import { readFile } from 'node:fs/promises';

export type GatewayLabRoute = {
  turnId: string;
  targetThreadId: string | null;
  newThreadTitle?: string;
  sourceSlice: string;
  rationale: string;
};

export type GatewayLabThread = {
  threadId: string;
  title: string;
  sourceSlices: Array<{
    turnId: string;
    sourceSlice: string;
  }>;
  continuityHints: string[];
};

export type GatewayLabState = {
  nextThreadIndex: number;
  threads: GatewayLabThread[];
};

export type GatewayLabTurn = {
  turnId: string;
  text: string;
  previousTurn?: string;
};

export type GatewayLabTurnRoutes = {
  turnId: string;
  text: string;
  routes: GatewayLabRoute[];
};

export type GatewayLabResult = {
  threads: GatewayLabThread[];
  turnRoutes: GatewayLabTurnRoutes[];
  coverage: {
    support: boolean;
    career: boolean;
    painting: boolean;
  };
};

export type GatewayLabRouter = (
  threads: Array<{ threadId: string; title: string; continuityHints?: string[] }>,
  pendingTurns: GatewayLabTurn[],
) => Promise<{ routes: GatewayLabRoute[] }>;

type LocomoTurn = {
  speaker?: unknown;
  dia_id?: unknown;
  text?: unknown;
  blip_caption?: unknown;
};

type LocomoSample = {
  conversation?: Record<string, unknown>;
};

export function createGatewayLabState(): GatewayLabState {
  return {
    nextThreadIndex: 1,
    threads: [],
  };
}

export function applyGatewayRoutes(state: GatewayLabState, routes: GatewayLabRoute[]): void {
  for (const route of routes) {
    const sourceSlice = route.sourceSlice.trim();
    if (!sourceSlice) {
      continue;
    }

    const targetThreadId = route.targetThreadId?.trim() || null;
    const thread = targetThreadId
      ? state.threads.find((candidate) => candidate.threadId === targetThreadId)
      : createLabThread(state, route.newThreadTitle);
    if (!thread) {
      continue;
    }

    thread.sourceSlices.push({
      turnId: route.turnId,
      sourceSlice,
    });
    thread.continuityHints.push(sourceSlice);
  }
}

export async function runGatewayLab(params: {
  turns: GatewayLabTurn[];
  routeGateway?: GatewayLabRouter;
}): Promise<GatewayLabResult> {
  const state = createGatewayLabState();
  const routeGateway = params.routeGateway ?? defaultRouteGateway;
  const turnRoutes: GatewayLabTurnRoutes[] = [];
  let previousTurn: string | undefined;

  for (const turn of params.turns) {
    const pendingTurn = {
      ...turn,
      ...(previousTurn ? { previousTurn } : {}),
    };
    const result = await routeGateway(gatewayThreadInputs(state), [pendingTurn]);
    applyGatewayRoutes(state, result.routes);
    turnRoutes.push({
      turnId: turn.turnId,
      text: turn.text,
      routes: result.routes,
    });
    previousTurn = turn.text;
  }

  return {
    threads: state.threads,
    turnRoutes,
    coverage: expectedTopicCoverage(state),
  };
}

export function expectedTopicCoverage(state: GatewayLabState): {
  support: boolean;
  career: boolean;
  painting: boolean;
} {
  const titleText = state.threads.map((thread) => thread.title.toLowerCase()).join('\n');
  const sliceText = state.threads
    .flatMap((thread) => thread.sourceSlices.map((slice) => slice.sourceSlice.toLowerCase()))
    .join('\n');
  const combined = `${titleText}\n${sliceText}`;
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
    const renderedText = renderTurnText({
      dateTime,
      speaker,
      text,
      caption: asString(turn.blip_caption),
    });
    return [{ turnId, text: renderedText }];
  });
}

function createLabThread(state: GatewayLabState, title?: string): GatewayLabThread | null {
  const normalizedTitle = title?.trim();
  if (!normalizedTitle) {
    return null;
  }
  const thread = {
    threadId: `thread-${state.nextThreadIndex}`,
    title: normalizedTitle,
    sourceSlices: [],
    continuityHints: [],
  };
  state.nextThreadIndex += 1;
  state.threads.push(thread);
  return thread;
}

function gatewayThreadInputs(state: GatewayLabState): Array<{
  threadId: string;
  title: string;
  continuityHints?: string[];
}> {
  return state.threads.map((thread) => ({
    threadId: thread.threadId,
    title: thread.title,
    ...(thread.continuityHints.length ? { continuityHints: thread.continuityHints.slice(-1) } : {}),
  }));
}

async function defaultRouteGateway(
  threads: Array<{ threadId: string; title: string; continuityHints?: string[] }>,
  pendingTurns: GatewayLabTurn[],
): Promise<{ routes: GatewayLabRoute[] }> {
  const module = await import('../../../packages/core/dist/llm/observing-gateway.js');
  const sessionTurns = pendingTurns.map((turn) => ({
    turnId: turn.turnId,
    prompt: turn.text,
    summary: turn.text,
    response: null,
    previousTurnSummary: turn.previousTurn,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sessionId: 'locomo-gateway-lab',
    agent: 'locomo',
    observer: 'gateway-lab',
    title: null,
    observingEpoch: 0,
  }));
  const result = await module.routeObservingThreads(threads, sessionTurns);
  return {
    routes: result.routes.map((route: {
      turnId: string;
      targetThreadId?: string | null;
      newThreadTitle?: string | null;
      sourceSlice: string;
      rationale: string;
    }): GatewayLabRoute => ({
      turnId: route.turnId,
      targetThreadId: route.targetThreadId ?? null,
      ...(route.newThreadTitle ? { newThreadTitle: route.newThreadTitle } : {}),
      sourceSlice: route.sourceSlice,
      rationale: route.rationale,
    })),
  };
}

async function main(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  const dataFile = requireOption(options, 'data-file');
  const sampleId = requireOption(options, 'sample-id');
  const sessionNo = Number(options.get('session-no') ?? '1');
  const samples = JSON.parse(await readFile(dataFile, 'utf8')) as LocomoSample[];
  const sample = samples.find((candidate) => String((candidate as Record<string, unknown>).sample_id) === sampleId);
  if (!sample) {
    throw new Error(`LoCoMo sample not found: ${sampleId}`);
  }
  const result = await runGatewayLab({
    turns: locomoSessionTurns(sample, sessionNo),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseArgs(argv: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      continue;
    }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`missing value for --${key}`);
    }
    options.set(key, value);
    index += 1;
  }
  return options;
}

function requireOption(options: Map<string, string>, key: string): string {
  const value = options.get(key);
  if (!value) {
    throw new Error(`missing required option --${key}`);
  }
  return value;
}

function renderTurnText(params: {
  dateTime: string;
  speaker: string;
  text: string;
  caption: string;
}): string {
  const text = params.caption
    ? `${params.text} [shares ${params.caption}]`
    : params.text;
  const lines = [];
  if (params.dateTime) {
    lines.push(`DATE: ${params.dateTime}`);
  }
  lines.push(`${params.speaker} said: "${text}"`);
  return lines.join('\n');
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function includesAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
