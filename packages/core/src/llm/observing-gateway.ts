import type { SessionTurn } from '../client.js';
import { getObserverLlmConfig } from '../config.js';
import type {
  GatewayAction,
  GatewayResult,
  GatewayUpdate,
  NewThreadHint,
  ObserveRequest,
  ObserveResult,
  ObservedMemory,
  ObservingContentUpdate,
  ObservingThreadGatewayInput,
} from '../observer/types.js';
import { generateText } from './provider.js';
import { loadPromptTemplate, renderPromptTemplate } from './prompt-loader.js';

const MAX_TITLE_CHARS = 120;
const MAX_SUMMARY_CHARS = 220;
const MAX_WHY_CHARS = 100;
const MAX_LIST_ITEM_CHARS = 120;
const MAX_MEMORY_CHARS = 220;

export async function routeObservingThreads(
  observingThreads: ObservingThreadGatewayInput[],
  pendingTurns: SessionTurn[],
  signal?: AbortSignal,
): Promise<GatewayResult> {
  throwIfAborted(signal);
  const config = getObserverLlmConfig();
  if (!config) {
    throw new Error('observer gateway is not configured');
  }

  const gatewayTurns = pendingTurns.map((turn) => ({
    turnId: turn.turnId,
    summary: turn.summary ?? turn.prompt ?? turn.response ?? '',
  }));

  if (config.provider === 'mock') {
    return validateGatewayResult(
      observingThreads,
      gatewayTurns,
      buildMockGatewayResult(observingThreads, gatewayTurns),
    );
  }

  const template = loadPromptTemplate('observing_gateway');
  const inputJson = JSON.stringify(
    {
      observingThreads: observingThreads.map((thread) => ({
        observingId: thread.observingId,
        title: thread.title,
        summary: thread.summary,
      })),
      pendingTurns: gatewayTurns.map((turn) => ({
        turnId: turn.turnId,
        summary: turn.summary,
      })),
    },
    null,
    2,
  );
  const basePrompt = renderPromptTemplate(template.userTemplate, { input_json: inputJson });

  let lastError = 'observer gateway returned no output';
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    throwIfAborted(signal);
    const raw = await generateText('observer', {
      system: template.system,
      prompt: buildRetryPrompt(
        basePrompt,
        attempt,
        lastError,
        'Make sure every pending turnId appears in at least one update.',
      ),
      signal,
    });
    if (!raw) {
      throw new Error('observer gateway is not configured');
    }
    throwIfAborted(signal);

    try {
      const parsed = parseJson<GatewayResult>(raw);
      return validateGatewayResult(observingThreads, gatewayTurns, parsed);
    } catch (error) {
      lastError = String(error);
    }
  }

  throw new Error(`observer gateway returned invalid output: ${lastError}`);
}

export async function observeThread(input: ObserveRequest, signal?: AbortSignal): Promise<ObserveResult> {
  throwIfAborted(signal);
  const config = getObserverLlmConfig();
  if (!config) {
    throw new Error('observing update is not configured');
  }

  if (config.provider === 'mock') {
    return validateObserveResult(buildMockObserveResult(input));
  }

  const template = loadPromptTemplate('observing');
  const inputJson = JSON.stringify(
    {
      observingContent: {
        title: input.observingContent.title,
        summary: input.observingContent.summary,
        memories: input.observingContent.memories,
        openQuestions: input.observingContent.openQuestions,
        nextSteps: input.observingContent.nextSteps,
      },
      pendingTurns: input.pendingTurns.map((turn) => ({
        turnId: turn.turnId,
        summary: turn.summary,
        whyRelated: turn.whyRelated,
      })),
    },
    null,
    2,
  );
  const basePrompt = renderPromptTemplate(template.userTemplate, { input_json: inputJson });

  let lastError = 'observing update returned no output';
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    throwIfAborted(signal);
    const raw = await generateText('observer', {
      system: template.system,
      prompt: buildRetryPrompt(
        basePrompt,
        attempt,
        lastError,
        'Keep all required content fields and memoryDelta arrays present.',
      ),
      signal,
    });
    if (!raw) {
      throw new Error('observing update is not configured');
    }
    throwIfAborted(signal);

    try {
      return validateObserveResult(parseJson<ObserveResult>(raw));
    } catch (error) {
      lastError = String(error);
    }
  }

  throw new Error(`observing update returned invalid output: ${lastError}`);
}

function buildMockGatewayResult(
  observingThreads: ObservingThreadGatewayInput[],
  pendingTurns: Array<{ turnId: string; summary: string }>,
): GatewayResult {
  return {
    updates: pendingTurns.map((turn) => {
      if (observingThreads.length > 0) {
        return {
          turnId: turn.turnId,
          action: 'append',
          observingId: observingThreads[0].observingId,
          summary: normalizeText(turn.summary, MAX_SUMMARY_CHARS),
          newThread: null,
          why: 'Matches the current observing thread.',
        } satisfies GatewayUpdate;
      }
      const summary = normalizeText(turn.summary, MAX_SUMMARY_CHARS);
      return {
        turnId: turn.turnId,
        action: 'new',
        observingId: null,
        summary,
        newThread: {
          title: normalizeText(summary, MAX_TITLE_CHARS),
          summary,
        } satisfies NewThreadHint,
        why: 'Starts a new observing thread.',
      } satisfies GatewayUpdate;
    }),
  };
}

function buildMockObserveResult(input: ObserveRequest): ObserveResult {
  const joined = input.pendingTurns
    .map((turn) => normalizeText(turn.summary, MAX_SUMMARY_CHARS))
    .filter(Boolean)
    .join(' ');
  const firstTurn = input.pendingTurns[0];
  const titleSeed = input.observingContent.title || joined || 'Mock observing thread';
  const summarySeed = [input.observingContent.summary, joined]
    .filter((value) => value && value.trim())
    .join(' ');
  const whySeed = normalizeText(firstTurn?.whyRelated ?? '', MAX_WHY_CHARS);
  return {
    observingContentUpdate: {
      title: normalizeText(titleSeed, MAX_TITLE_CHARS),
      summary: normalizeText(summarySeed || titleSeed, MAX_SUMMARY_CHARS),
      openQuestions: input.observingContent.openQuestions,
      nextSteps: whySeed ? [`Follow up: ${whySeed}`] : input.observingContent.nextSteps,
    },
    memoryDelta: {
      before: [],
      after: joined ? [{
        text: joined,
        category: 'Fact',
        updatedMemory: null,
      }] : [],
    },
  };
}

function validateGatewayResult(
  observingThreads: ObservingThreadGatewayInput[],
  pendingTurns: Array<{ turnId: string; summary: string }>,
  result: GatewayResult,
): GatewayResult {
  const validTurnIds = new Set(pendingTurns.map((turn) => turn.turnId));
  const validThreadIds = new Set(observingThreads.map((thread) => thread.observingId));
  const coveredTurnIds = new Set<string>();
  const updates = result.updates.map((update) => {
    const turnId = update.turnId.trim();
    if (!validTurnIds.has(turnId)) {
      throw new Error(`observer gateway referenced unknown turnId: ${update.turnId}`);
    }
    const summary = normalizeText(update.summary, MAX_SUMMARY_CHARS);
    if (!summary) {
      throw new Error(`observer gateway returned empty summary for turnId: ${turnId}`);
    }
    const why = normalizeText(update.why, MAX_WHY_CHARS);
    if (!why) {
      throw new Error(`observer gateway returned empty why for turnId: ${turnId}`);
    }

    let normalized: GatewayUpdate;
    if (update.action === 'append') {
      const observingId = update.observingId?.trim();
      if (!observingId || !validThreadIds.has(observingId) || update.newThread) {
        throw new Error(`observer gateway returned invalid append target for turnId: ${turnId}`);
      }
      normalized = {
        turnId,
        action: 'append',
        observingId,
        summary,
        newThread: null,
        why,
      };
    } else if (update.action === 'new') {
      if (update.observingId?.trim()) {
        throw new Error(`observer gateway returned new update with observingId for turnId: ${turnId}`);
      }
      const title = normalizeText(update.newThread?.title ?? '', MAX_TITLE_CHARS);
      const newSummary = normalizeText(update.newThread?.summary ?? '', MAX_SUMMARY_CHARS);
      if (!title || !newSummary) {
        throw new Error(`observer gateway returned incomplete new thread payload for turnId: ${turnId}`);
      }
      normalized = {
        turnId,
        action: 'new',
        observingId: null,
        summary,
        newThread: { title, summary: newSummary },
        why,
      };
    } else {
      throw new Error(`observer gateway returned invalid action for turnId: ${turnId}`);
    }

    coveredTurnIds.add(turnId);
    return normalized;
  });

  if (updates.length === 0 && pendingTurns.length > 0) {
    throw new Error('observer gateway returned no valid updates');
  }

  const missing = pendingTurns
    .map((turn) => turn.turnId)
    .filter((turnId) => !coveredTurnIds.has(turnId));
  if (missing.length > 0) {
    throw new Error(`observer gateway omitted pending turns: ${missing.join(', ')}`);
  }

  return { updates };
}

function validateObserveResult(result: ObserveResult): ObserveResult {
  const title = normalizeText(result.observingContentUpdate.title, MAX_TITLE_CHARS);
  if (!title) {
    throw new Error('observing update returned empty observingContentUpdate.title');
  }

  const summary = normalizeText(result.observingContentUpdate.summary, MAX_SUMMARY_CHARS);
  if (!summary) {
    throw new Error('observing update returned empty observingContentUpdate.summary');
  }

  return {
    observingContentUpdate: {
      title,
      summary,
      openQuestions: normalizeStringList(result.observingContentUpdate.openQuestions),
      nextSteps: normalizeStringList(result.observingContentUpdate.nextSteps),
    } satisfies ObservingContentUpdate,
    memoryDelta: {
      before: normalizeMemoryList(result.memoryDelta.before),
      after: normalizeMemoryList(result.memoryDelta.after),
    },
  };
}

function normalizeMemoryList(memories: ObservedMemory[]): ObservedMemory[] {
  return memories.map((memory) => {
    const text = normalizeText(memory.text, MAX_MEMORY_CHARS);
    if (!text) {
      throw new Error('observing update returned an empty memory text');
    }
    return {
      id: memory.id?.trim() || null,
      text,
      category: memory.category,
      updatedMemory: memory.updatedMemory?.trim() || null,
    };
  });
}

function normalizeStringList(values: string[]): string[] {
  return values
    .map((value) => normalizeText(value, MAX_LIST_ITEM_CHARS))
    .filter((value): value is string => Boolean(value));
}

function parseJson<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end >= start) {
      return JSON.parse(raw.slice(start, end + 1)) as T;
    }
    throw new Error('invalid JSON');
  }
}

function buildRetryPrompt(
  basePrompt: string,
  attempt: number,
  lastError: string,
  rule: string,
): string {
  if (attempt === 1) {
    return basePrompt;
  }
  return `${basePrompt}\n\nPrevious output was invalid.\nValidation error: ${lastError}\nReturn one JSON object only. ${rule}`;
}

function normalizeText(value: string, maxChars: number): string {
  const collapsed = value.split(/\s+/).join(' ').trim();
  if (!collapsed) {
    return '';
  }
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  if (maxChars <= 3) {
    return collapsed.slice(0, maxChars);
  }
  return `${collapsed.slice(0, maxChars - 3)}...`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  const reason = signal.reason;
  if (reason instanceof Error) {
    throw reason;
  }
  const error = new Error('operation aborted');
  error.name = 'AbortError';
  throw error;
}
