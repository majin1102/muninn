import { readFile } from 'node:fs/promises';

type LabThread = {
  threadId: string;
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
  previousTurn?: string;
};

type LabWorkItem = {
  targetThreadId?: string | null;
  newThreadTitle?: string | null;
  sourceRefs: Array<{ turnId: string; excerpt: string }>;
  routingReason: string;
};

type LabObserveResult = {
  observingContent: {
    title: string;
    summary: string;
    observations: Array<{ id?: string | null; text: string; category: string }>;
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
    observingThreads: Array<{ threadId: string; title: string; continuityHints?: string[] }>;
    pendingTurns: LabTurn[];
  }): Promise<{ workItems: LabWorkItem[]; ignoredTurnIds?: string[] }>;
  observe(input: {
    observingContent: LabObserveResult['observingContent'];
    sourceRefs: Array<{ turnId: string; excerpt: string; prompt?: string | null; response?: string | null }>;
    threadMemoryId?: string | null;
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
    workItems: LabWorkItem[];
    ignoredTurnIds: string[];
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
  const threads: LabThread[] = [];
  const epochs: GatewayLabResult['epochs'] = [];
  let nextThreadIndex = 1;
  let previousTurn: string | undefined;

  for (const turn of params.turns) {
    const currentTurn = {
      ...turn,
      ...(previousTurn ? { previousTurn } : {}),
    };
    const fitting = await pipeline.fit({
      observingThreads: threads.map((thread) => ({
        threadId: thread.threadId,
        title: thread.title,
        ...(thread.contextRefs.length > 0
          ? { continuityHints: [thread.contextRefs[thread.contextRefs.length - 1].summary] }
          : {}),
      })),
      pendingTurns: [currentTurn],
    });

    for (const item of fitting.workItems) {
      const thread = item.targetThreadId
        ? threads.find((candidate) => candidate.threadId === item.targetThreadId)
        : createThread(item.newThreadTitle, nextThreadIndex++);
      if (!thread) {
        continue;
      }
      if (!item.targetThreadId) {
        threads.push(thread);
      }
      const result = await pipeline.observe({
        observingContent: {
          title: thread.title,
          summary: thread.summary,
          observations: thread.observations,
          openQuestions: thread.openQuestions,
          nextSteps: thread.nextSteps,
        },
        sourceRefs: item.sourceRefs.map((reference) => ({
          turnId: reference.turnId,
          excerpt: reference.excerpt,
          prompt: params.turns.find((candidate) => candidate.turnId === reference.turnId)?.text ?? null,
          response: null,
        })),
        threadMemoryId: null,
      });
      applyObserveResult(thread, result);
    }

    epochs.push({
      turnId: turn.turnId,
      text: turn.text,
      workItems: fitting.workItems,
      ignoredTurnIds: fitting.ignoredTurnIds ?? [],
    });
    previousTurn = turn.text;
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

function createThread(title: string | undefined | null, index: number): LabThread | null {
  const normalizedTitle = title?.trim();
  if (!normalizedTitle) {
    return null;
  }
  return {
    threadId: `thread-${index}`,
    title: normalizedTitle,
    summary: normalizedTitle,
    observations: [],
    contextRefs: [],
    openQuestions: [],
    nextSteps: [],
  };
}

function applyObserveResult(thread: LabThread, result: LabObserveResult): void {
  thread.title = result.observingContent.title;
  thread.summary = result.observingContent.summary;
  thread.observations = result.observingContent.observations;
  thread.contextRefs = mergeContextRefs(thread.contextRefs, result.contextRefs);
  thread.openQuestions = result.observingContent.openQuestions;
  thread.nextSteps = result.observingContent.nextSteps;
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
    previousTurnSummary: turn.previousTurn,
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
