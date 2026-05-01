import type { SessionTurn } from '../client.js';
import { getObserverLlmConfig } from '../config.js';
import type {
  GatewayRoute,
  GatewayResult,
  ObserveRequest,
  ObserveResult,
  Observation,
  ObservingContentUpdate,
  ObservingThreadGatewayInput,
  ContextRef,
} from '../observer/types.js';
import { generateText } from './provider.js';
import { loadPromptTemplate, renderPromptTemplate } from './prompt-loader.js';

const MAX_TITLE_CHARS = 120;
const MAX_SUMMARY_CHARS = 220;
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

  const gatewayTurns = toGatewayTurns(pendingTurns);

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
        threadId: thread.threadId,
        title: thread.title,
        ...(thread.continuityHints?.length ? { continuityHints: thread.continuityHints } : {}),
      })),
      pendingTurns: gatewayTurns.map((turn) => ({
        turnId: turn.turnId,
        text: turn.text,
        ...(turn.previousTurn ? { previousTurn: turn.previousTurn } : {}),
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
        'Make sure every route has turnId, targetThreadId, sourceSlice, and rationale.',
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

function toGatewayTurns(pendingTurns: SessionTurn[]): Array<{ turnId: string; text: string; previousTurn?: string }> {
  return pendingTurns.map((turn) => ({
    turnId: turn.turnId,
    text: turn.prompt ?? turn.summary ?? turn.response ?? '',
    previousTurn: turn.previousTurnSummary ?? undefined,
  }));
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
        observations: input.observingContent.observations,
        openQuestions: input.observingContent.openQuestions,
        nextSteps: input.observingContent.nextSteps,
      },
      pendingTurns: input.pendingTurns.map((turn) => ({
        turnId: turn.turnId,
        ...(turn.sourceSlice ? { sourceSlice: turn.sourceSlice } : {}),
        ...(turn.prompt ? { prompt: turn.prompt } : {}),
        ...(turn.response ? { response: turn.response } : {}),
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
        'Keep all required content fields, contextRefs, and observationDelta arrays present.',
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
  pendingTurns: Array<{ turnId: string; text: string }>,
): GatewayResult {
  return {
    routes: pendingTurns.map((turn) => {
      const sourceSlice = normalizeText(turn.text, MAX_SUMMARY_CHARS);
      if (observingThreads.length > 0) {
        return {
          turnId: turn.turnId,
          targetThreadId: observingThreads[0].threadId,
          sourceSlice,
          rationale: 'The turn is routed to the existing observing thread for inspection.',
        } satisfies GatewayRoute;
      }
      return {
        turnId: turn.turnId,
        targetThreadId: null,
        newThreadTitle: normalizeText(sourceSlice, MAX_TITLE_CHARS),
        sourceSlice,
        rationale: 'The turn starts a new observing thread for inspection.',
      } satisfies GatewayRoute;
    }),
  };
}

function buildMockObserveResult(input: ObserveRequest): ObserveResult {
  const joined = input.pendingTurns
    .map((turn) => normalizeText(turn.sourceSlice ?? turn.prompt ?? turn.response ?? '', MAX_SUMMARY_CHARS))
    .filter(Boolean)
    .join(' ');
  const titleSeed = input.observingContent.title || joined || 'Mock observing thread';
  const summarySeed = [input.observingContent.summary, joined]
    .filter((value) => value && value.trim())
    .join(' ');
  return {
    observingContentUpdate: {
      title: normalizeText(titleSeed),
      summary: normalizeText(summarySeed || titleSeed),
      openQuestions: input.observingContent.openQuestions,
      nextSteps: input.observingContent.nextSteps,
    },
    contextRefs: input.pendingTurns
      .map((turn) => ({
        turnId: turn.turnId,
        summary: normalizeText(turn.sourceSlice ?? turn.prompt ?? turn.response ?? '', MAX_SUMMARY_CHARS),
      }))
      .filter((reference) => reference.summary),
    observationDelta: {
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
  pendingTurns: Array<{ turnId: string; text: string }>,
  result: GatewayResult,
): GatewayResult {
  const validTurnIds = new Set(pendingTurns.map((turn) => turn.turnId));
  const validThreadIds = new Set(observingThreads.map((thread) => thread.threadId));
  const coveredTurnIds = new Set<string>();
  if (!Array.isArray(result.routes)) {
    throw new Error('observer gateway returned routes that are not an array');
  }
  const routes = result.routes.map((route) => {
    const turnId = route.turnId.trim();
    if (!validTurnIds.has(turnId)) {
      throw new Error(`observer gateway referenced unknown turnId: ${route.turnId}`);
    }

    const sourceSlice = normalizeText(route.sourceSlice, MAX_SUMMARY_CHARS);
    if (!sourceSlice) {
      throw new Error(`observer gateway returned empty sourceSlice for turnId: ${turnId}`);
    }
    const rationale = normalizeText(route.rationale ?? '', MAX_SUMMARY_CHARS);
    if (!rationale) {
      throw new Error(`observer gateway returned empty rationale for turnId: ${turnId}`);
    }

    let normalized: GatewayRoute;
    const targetThreadId = route.targetThreadId?.trim() || null;
    if (targetThreadId) {
      if (!validThreadIds.has(targetThreadId) || route.newThreadTitle) {
        throw new Error(`observer gateway returned invalid targetThreadId for turnId: ${turnId}`);
      }
      normalized = {
        turnId,
        targetThreadId,
        sourceSlice,
        rationale,
      };
    } else {
      const newThreadTitle = normalizeText(route.newThreadTitle ?? '', MAX_TITLE_CHARS);
      if (!newThreadTitle) {
        throw new Error(`observer gateway returned missing newThreadTitle for turnId: ${turnId}`);
      }
      normalized = {
        turnId,
        targetThreadId: null,
        newThreadTitle,
        sourceSlice,
        rationale,
      };
    }

    coveredTurnIds.add(turnId);
    return normalized;
  });

  return { routes };
}

function validateObserveResult(result: ObserveResult): ObserveResult {
  const title = normalizeText(result.observingContentUpdate.title);
  if (!title) {
    throw new Error('observing update returned empty observingContentUpdate.title');
  }

  const summary = normalizeText(result.observingContentUpdate.summary);
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
    contextRefs: normalizeContextRefs(result.contextRefs),
    observationDelta: {
      before: normalizeObservationList(result.observationDelta.before),
      after: normalizeObservationList(result.observationDelta.after),
    },
  };
}

function normalizeContextRefs(value: unknown): ContextRef[] {
  if (!Array.isArray(value)) {
    throw new Error('observe result contextRefs must be an array');
  }
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const record = item as Record<string, unknown>;
    const turnId = typeof record.turnId === 'string' ? record.turnId.trim() : '';
    const summary = typeof record.summary === 'string' ? normalizeText(record.summary, MAX_SUMMARY_CHARS) : '';
    if (!turnId || !summary) {
      return [];
    }
    return [{ turnId, summary }];
  });
}

function normalizeObservationList(observations: Observation[]): Observation[] {
  return observations.map((observation) => {
    const text = normalizeText(observation.text, MAX_MEMORY_CHARS);
    if (!text) {
      throw new Error('observing update returned an empty observation text');
    }
    return {
      id: observation.id?.trim() || null,
      text,
      category: observation.category,
      updatedMemory: observation.updatedMemory?.trim() || null,
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

function normalizeText(value: string, maxChars?: number): string {
  const collapsed = value.split(/\s+/).join(' ').trim();
  if (!collapsed) {
    return '';
  }
  if (maxChars === undefined) {
    return collapsed;
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

export const __testing = {
  gatewayTurnsForTests: toGatewayTurns,
  validateGatewayResultForTests: validateGatewayResult,
  validateObserveResultForTests: validateObserveResult,
};
