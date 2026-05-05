import { readFile } from 'node:fs/promises';

type LabThread = {
  threadId: string;
  kind: 'session' | 'subject';
  title: string;
  summary: string;
  observations: Array<{ id?: string | null; text: string; category: string }>;
  contextRefs: Array<{ turnId: string; summary: string }>;
  openQuestions: string[];
  nextSteps: string[];
};

type LabTurn = {
  turnId: string;
  text: string;
};

type LabObservingContent = {
  title: string;
  summary: string;
  observations: Array<{ id?: string | null; text: string; category: string }>;
  openQuestions: string[];
  nextSteps: string[];
};

type LabSessionFragment = {
  threadId: string;
  turnIds: string[];
  content: string;
  reason: string;
};

type LabObserveResult = {
  observingContent: {
    title: string;
    summary: string;
    openQuestions: string[];
    nextSteps: string[];
  };
  contextRefs: Array<{ turnId: string; summary: string }>;
  observationChanges: Array<
    | { type: 'add'; text: string; category: string; references: string[]; reason: string }
    | { type: 'merge'; observationIds: string[]; text: string; category: string; reason: string }
    | { type: 'update'; observationId: string; text: string; category?: string; reason: string }
    | { type: 'delete'; observationId: string; reason: string }
  >;
};

type LabPipeline = {
  fit(input: {
    observingThreads: Array<{ threadId: string; kind: 'session' | 'subject'; title: string; summary: string }>;
    pendingTurns: LabTurn[];
  }): Promise<{ sessionFragments: LabSessionFragment[] }>;
  observe(input: {
    observingContent: LabObservingContent;
    sourceRefs: Array<{ turnId: string; excerpt: string }>;
  }): Promise<LabObserveResult>;
};

type LocomoTurn = {
  speaker?: unknown;
  dia_id?: unknown;
  text?: unknown;
  blip_caption?: unknown;
};

type LocomoSample = {
  conversation?: Record<string, unknown>;
};

export type GatewayLabResult = {
  threads: LabThread[];
  epochs: Array<{
    turnId: string;
    text: string;
    sessionFragments: LabSessionFragment[];
  }>;
  coverage: {
    support: boolean;
    career: boolean;
    painting: boolean;
  };
};

export async function runGatewayLab(params: {
  turns: LabTurn[];
  pipeline?: LabPipeline;
}): Promise<GatewayLabResult> {
  const pipeline = params.pipeline ?? await defaultPipeline();
  const threads: LabThread[] = [createSessionThread()];
  const epochs: GatewayLabResult['epochs'] = [];

  for (const turn of params.turns) {
    const fitting = await pipeline.fit({
      observingThreads: threads.map((thread) => ({
        threadId: thread.threadId,
        kind: thread.kind,
        title: thread.title,
        summary: thread.summary,
      })),
      pendingTurns: [turn],
    });

    for (const fragment of fitting.sessionFragments) {
      const thread = threads.find((candidate) => candidate.threadId === fragment.threadId);
      if (!thread) {
        continue;
      }
      const result = await pipeline.observe({
        observingContent: {
          title: thread.title,
          summary: thread.summary,
          observations: thread.observations,
          openQuestions: thread.openQuestions,
          nextSteps: thread.nextSteps,
        },
        sourceRefs: fragment.turnIds.map((turnId) => ({
          turnId,
          excerpt: fragment.content,
        })),
      });
      applyObserveResult(thread, result);
    }

    epochs.push({
      turnId: turn.turnId,
      text: turn.text,
      sessionFragments: fitting.sessionFragments,
    });
  }

  return {
    threads,
    epochs,
    coverage: expectedTopicCoverage(threads),
  };
}

export function expectedTopicCoverage(threads: LabThread[]): {
  support: boolean;
  career: boolean;
  painting: boolean;
} {
  const combined = threads.map((thread) => [
    thread.title,
    thread.summary,
    ...thread.observations.map((observation) => observation.text),
    ...thread.contextRefs.map((reference) => reference.summary),
  ].join('\n').toLowerCase()).join('\n');
  return {
    support: includesAny(combined, ['lgbtq', 'support group', 'self-acceptance', 'identity']),
    career: includesAny(combined, ['counsel', 'mental-health', 'mental health', 'career', 'education']),
    painting: includesAny(combined, ['painting', 'sunrise', 'sunset', 'lake', 'creative outlet']),
  };
}

export function locomoSessionTurns(sample: LocomoSample, sessionNo: number): Array<{
  turnId: string;
  text: string;
}> {
  const conversation = sample.conversation ?? {};
  const session = conversation[`session_${sessionNo}`];
  if (!Array.isArray(session)) {
    return [];
  }
  const dateTime = asString(conversation[`session_${sessionNo}_date_time`]);
  return (session as LocomoTurn[]).flatMap((turn, index) => {
    const speaker = asString(turn.speaker);
    const text = asString(turn.text);
    if (!speaker || !text) {
      return [];
    }
    const turnId = asString(turn.dia_id) || `D${sessionNo}:${index + 1}`;
    return [{
      turnId,
      text: renderTurnText({
        dateTime,
        speaker,
        text,
        caption: asString(turn.blip_caption),
      }),
    }];
  });
}

async function defaultPipeline(): Promise<LabPipeline> {
  const observingModule = await import('../../../packages/core/dist/llm/observing-gateway.js');
  return {
    fit: async (input) => observingModule.routeObservingThreads(
      input.observingThreads,
      toSessionTurns(input.pendingTurns),
    ),
    observe: async (input) => observingModule.observeThread(input as never),
  };
}

function createSessionThread(): LabThread {
  return {
    threadId: 'thread-session',
    kind: 'session',
    title: 'Session observing thread',
    summary: 'Default observing thread for this session.',
    observations: [],
    contextRefs: [],
    openQuestions: [],
    nextSteps: [],
  };
}

function applyObserveResult(thread: LabThread, result: LabObserveResult): void {
  thread.title = result.observingContent.title;
  thread.summary = result.observingContent.summary;
  thread.observations = applyObservationChanges(thread.observations, result.observationChanges);
  thread.contextRefs = mergeContextRefs(thread.contextRefs, result.contextRefs);
  thread.openQuestions = result.observingContent.openQuestions;
  thread.nextSteps = result.observingContent.nextSteps;
}

function applyObservationChanges(
  current: LabThread['observations'],
  changes: LabObserveResult['observationChanges'],
): LabThread['observations'] {
  const observations = new Map(current.flatMap((observation) => (
    observation.id ? [[observation.id, observation]] : []
  )));
  let nextId = observations.size + 1;
  for (const change of changes) {
    if (change.type === 'add') {
      const id = `lab-observation-${nextId++}`;
      observations.set(id, { id, text: change.text, category: change.category });
      continue;
    }
    if (change.type === 'update') {
      const existing = observations.get(change.observationId);
      if (existing) {
        observations.set(change.observationId, {
          ...existing,
          text: change.text,
          category: change.category ?? existing.category,
        });
      }
      continue;
    }
    if (change.type === 'merge') {
      for (const observationId of change.observationIds) {
        observations.delete(observationId);
      }
      const id = `lab-observation-${nextId++}`;
      observations.set(id, { id, text: change.text, category: change.category });
      continue;
    }
    observations.delete(change.observationId);
  }
  return [...observations.values()];
}

function mergeContextRefs(
  current: Array<{ turnId: string; summary: string }>,
  next: Array<{ turnId: string; summary: string }>,
): Array<{ turnId: string; summary: string }> {
  const merged = [...current];
  for (const reference of next) {
    const existingIndex = merged.findIndex((candidate) => candidate.turnId === reference.turnId);
    if (existingIndex >= 0) {
      merged.splice(existingIndex, 1);
    }
    merged.push(reference);
  }
  return merged;
}

function toSessionTurns(turns: LabTurn[]) {
  return turns.map((turn) => ({
    turnId: turn.turnId,
    prompt: turn.text,
    summary: turn.text,
    response: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sessionId: 'locomo-observing-lab',
    agent: 'locomo',
    observer: 'observing-lab',
    title: null,
    observingEpoch: 0,
  }));
}

function renderTurnText(input: {
  dateTime: string;
  speaker: string;
  text: string;
  caption: string;
}): string {
  const textWithCaption = input.caption
    ? `${input.text} [shares ${input.caption}]`
    : input.text;
  return [
    input.dateTime ? `DATE: ${input.dateTime}` : '',
    `${input.speaker} said: "${textWithCaption}"`,
  ].filter(Boolean).join('\n');
}

function includesAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function loadLocomoSample(path: string, sampleId: string): Promise<LocomoSample | null> {
  const raw = await readFile(path, 'utf8');
  const data = JSON.parse(raw) as Array<Record<string, unknown>>;
  return data.find((sample) => sample.sample_id === sampleId) as LocomoSample | null ?? null;
}
