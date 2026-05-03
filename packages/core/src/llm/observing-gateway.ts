import { appendFile } from 'node:fs/promises';

import type { SessionTurn } from '../client.js';
import { getObserverLlmConfig } from '../config.js';
import type { Memories } from '../memories/memories.js';
import { renderRenderedMemoryMarkdown } from '../memories/rendered.js';
import type {
  GatewayResult,
  ObserveRequest,
  ObserveResult,
  Observation,
  ObservationCategory,
  ObservationChange,
  ObservingThreadGatewayInput,
  ContextRef,
} from '../observer/types.js';
import {
  generateText,
  generateWithTools,
  type LlmTask,
  type LlmTool,
  type LlmToolCall,
  type LlmToolMessage,
  type LlmToolRequest,
  type LlmToolResult,
} from './provider.js';
import { loadDomainPrompt } from './domain-prompt.js';
import { loadPromptTemplate, renderPromptTemplate } from './prompt-loader.js';

const MAX_TITLE_CHARS = 120;
const MAX_SUMMARY_CHARS = 220;
const MAX_LIST_ITEM_CHARS = 120;

type ToolModel = (
  task: LlmTask,
  request: LlmToolRequest,
) => Promise<LlmToolResult | null>;

type ObserveThreadDeps = {
  memories?: Pick<Memories, 'get'>;
  model?: ToolModel;
};

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
        'Make sure every work item has sourceRefs, targetThreadId or newThreadTitle, and routingReason.',
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

export async function observeThread(
  input: ObserveRequest,
  signal?: AbortSignal,
  deps: ObserveThreadDeps = {},
): Promise<ObserveResult> {
  throwIfAborted(signal);
  const config = getObserverLlmConfig();
  if (!config) {
    throw new Error('observing update is not configured');
  }

  if (config.provider === 'mock') {
    return validateObserveResult(buildMockObserveResult(input), input);
  }

  const template = loadPromptTemplate('thread_observing');
  const systemPrompt = renderPromptTemplate(template.system, {
    domain_prompt: loadDomainPrompt(config.domainPrompt)?.trim() || 'No additional domain guidance.',
  });
  const inputJson = JSON.stringify(
    {
      observingContent: {
        title: input.observingContent.title,
        summary: input.observingContent.summary,
        observations: input.observingContent.observations,
        openQuestions: input.observingContent.openQuestions,
        nextSteps: input.observingContent.nextSteps,
      },
      sourceRefs: input.sourceRefs.map((turn) => ({
        turnId: turn.turnId,
        ...(turn.excerpt ? { excerpt: turn.excerpt } : {}),
        ...(turn.prompt ? { prompt: turn.prompt } : {}),
        ...(turn.response ? { response: turn.response } : {}),
      })),
      allowedMemoryIds: buildObserveMemoryAllowlist(input),
    },
    null,
    2,
  );
  const basePrompt = renderPromptTemplate(template.userTemplate, { input_json: inputJson });
  const trace = createObserveTrace(input);

  let lastError = 'observing update returned no output';
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    throwIfAborted(signal);
    const raw = await runToolLoop({
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: buildRetryPrompt(
            basePrompt,
            attempt,
            lastError,
            'Keep observingContent, contextRefs, and observationChanges present.',
          ),
        },
      ],
      tools: [memoryGetSpec()],
      toolHandlers: {
        memory_get: createMemoryGetTool(input, deps.memories),
      },
      model: deps.model ?? generateWithTools,
      signal,
      onToolResults: (event) => {
        trace.toolCalls.push(...event.toolCalls);
        trace.toolResults.push(...event.toolResults);
      },
    });
    if (!raw) {
      throw new Error('observing update is not configured');
    }
    throwIfAborted(signal);

    try {
      const result = validateObserveResult(parseJson<ObserveResult>(raw), input);
      await writeObserveTrace({
        ...trace,
        finalJson: raw,
        observationChanges: result.observationChanges,
      });
      return result;
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
    workItems: pendingTurns.map((turn) => {
      const excerpt = normalizeText(turn.text, MAX_SUMMARY_CHARS);
      if (observingThreads.length > 0) {
        return {
          targetThreadId: observingThreads[0].threadId,
          sourceRefs: [{ turnId: turn.turnId, excerpt }],
          routingReason: 'The turn is routed to the existing observing thread for inspection.',
        };
      }
      return {
        targetThreadId: null,
        newThreadTitle: normalizeText(excerpt, MAX_TITLE_CHARS),
        sourceRefs: [{ turnId: turn.turnId, excerpt }],
        routingReason: 'The turn starts a new observing thread for inspection.',
      };
    }),
    ignoredTurnIds: [],
  };
}

function buildMockObserveResult(input: ObserveRequest): ObserveResult {
  const joined = input.sourceRefs
    .map((turn) => normalizeText(turn.excerpt ?? turn.prompt ?? turn.response ?? '', MAX_SUMMARY_CHARS))
    .filter(Boolean)
    .join(' ');
  const titleSeed = input.observingContent.title || joined || 'Mock observing thread';
  const summarySeed = [input.observingContent.summary, joined]
    .filter((value) => value && value.trim())
    .join(' ');
  return {
    observingContent: {
      title: normalizeText(titleSeed),
      summary: normalizeText(summarySeed || titleSeed),
      observations: input.observingContent.observations,
      openQuestions: input.observingContent.openQuestions,
      nextSteps: input.observingContent.nextSteps,
    },
    contextRefs: input.sourceRefs
      .map((turn) => ({
        turnId: turn.turnId,
        summary: normalizeText(turn.excerpt ?? turn.prompt ?? turn.response ?? '', MAX_SUMMARY_CHARS),
      }))
      .filter((reference) => reference.summary),
    observationChanges: joined
      ? [{
          type: 'add',
          text: joined,
          category: 'Fact',
          references: input.sourceRefs.map((reference) => reference.turnId),
          reason: 'Mock observer records the routed source context.',
        }]
      : [],
  };
}

function validateGatewayResult(
  observingThreads: ObservingThreadGatewayInput[],
  pendingTurns: Array<{ turnId: string; text: string }>,
  result: GatewayResult,
): GatewayResult {
  const validTurnIds = new Set(pendingTurns.map((turn) => turn.turnId));
  const validThreadIds = new Set(observingThreads.map((thread) => thread.threadId));
  if (!Array.isArray(result.workItems)) {
    throw new Error('observer gateway returned workItems that are not an array');
  }
  const workItems = result.workItems.map((item) => {
    const routingReason = normalizeText(item.routingReason ?? '', MAX_SUMMARY_CHARS);
    if (!routingReason) {
      throw new Error('observer gateway returned empty routingReason');
    }

    const sourceRefs = Array.isArray(item.sourceRefs) ? item.sourceRefs.map((reference) => {
      const turnId = typeof reference.turnId === 'string' ? reference.turnId.trim() : '';
      if (!validTurnIds.has(turnId)) {
        throw new Error(`observer gateway referenced unknown turnId: ${turnId}`);
      }
      const excerpt = normalizeText(typeof reference.excerpt === 'string' ? reference.excerpt : '', MAX_SUMMARY_CHARS);
      if (!excerpt) {
        throw new Error(`observer gateway returned empty excerpt for turnId: ${turnId}`);
      }
      return { turnId, excerpt };
    }) : [];
    if (sourceRefs.length === 0) {
      throw new Error('observer gateway work item must include sourceRefs');
    }

    const targetThreadId = item.targetThreadId?.trim() || null;
    if (targetThreadId) {
      if (!validThreadIds.has(targetThreadId) || item.newThreadTitle) {
        throw new Error('observer gateway returned invalid targetThreadId');
      }
      return {
        targetThreadId,
        sourceRefs,
        routingReason,
      };
    }

    const newThreadTitle = normalizeText(item.newThreadTitle ?? '', MAX_TITLE_CHARS);
    if (!newThreadTitle) {
      throw new Error('observer gateway returned missing newThreadTitle');
    }
    return {
      targetThreadId: null,
      newThreadTitle,
      sourceRefs,
      routingReason,
    };
  });
  const ignoredTurnIds = Array.isArray(result.ignoredTurnIds)
    ? [...new Set(result.ignoredTurnIds.map((turnId) => typeof turnId === 'string' ? turnId.trim() : '').filter(Boolean))]
    : [];
  for (const turnId of ignoredTurnIds) {
    if (!validTurnIds.has(turnId)) {
      throw new Error(`observer gateway ignored unknown turnId: ${turnId}`);
    }
  }

  return { workItems, ignoredTurnIds };
}

function validateObserveResult(result: ObserveResult, input?: ObserveRequest): ObserveResult {
  const title = normalizeText(result.observingContent.title);
  if (!title) {
    throw new Error('observing update returned empty observingContent.title');
  }

  const summary = normalizeText(result.observingContent.summary);
  if (!summary) {
    throw new Error('observing update returned empty observingContent.summary');
  }

  const normalized = {
    observingContent: {
      title,
      summary,
      observations: normalizeObservationList(result.observingContent.observations),
      openQuestions: normalizeStringList(result.observingContent.openQuestions),
      nextSteps: normalizeStringList(result.observingContent.nextSteps),
    },
    contextRefs: normalizeContextRefs(result.contextRefs),
    observationChanges: normalizeObservationChanges(result.observationChanges),
  };
  rejectRelativeTime(normalized, input);
  return normalized;
}

function normalizeObservationChanges(actions: unknown): ObservationChange[] {
  if (!Array.isArray(actions)) {
    throw new Error('observationChanges must be an array');
  }
  const modifiedObservationIds = new Set<string>();
  return actions.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new Error('observationChanges entries must be objects');
    }
    const action = item as Record<string, unknown>;
    const type = typeof action.type === 'string' ? action.type : '';
    const reason = typeof action.reason === 'string' ? normalizeText(action.reason, MAX_SUMMARY_CHARS) : '';
    if (!reason) {
      throw new Error('observation change missing reason');
    }
    if (type === 'add') {
      const text = typeof action.text === 'string' ? normalizeText(action.text) : '';
      if (!text) {
        throw new Error('add change missing text');
      }
      const references = normalizeIdList(action.references, 'add.references');
      if (references.length === 0) {
        throw new Error('add change must include references');
      }
      return {
        type: 'add',
        text,
        category: normalizeCategory(action.category),
        references,
        reason,
      };
    }
    if (type === 'merge') {
      const observationIds = normalizeIdList(action.observationIds, 'merge.observationIds');
      if (observationIds.length < 2) {
        throw new Error('merge change must include at least two observationIds');
      }
      for (const observationId of observationIds) {
        claimModifiedObservationId(observationId, modifiedObservationIds);
      }
      const text = typeof action.text === 'string' ? normalizeText(action.text) : '';
      if (!text) {
        throw new Error('merge change missing text');
      }
      return {
        type: 'merge',
        observationIds,
        text,
        category: normalizeCategory(action.category),
        reason,
      };
    }
    if (type === 'update') {
      const observationId = typeof action.observationId === 'string' ? action.observationId.trim() : '';
      claimModifiedObservationId(observationId, modifiedObservationIds);
      const text = typeof action.text === 'string' ? normalizeText(action.text) : '';
      if (!text) {
        throw new Error('update change missing text');
      }
      return {
        type: 'update',
        observationId,
        text,
        ...(action.category ? { category: normalizeCategory(action.category) } : {}),
        ...(Array.isArray(action.references) ? { references: normalizeIdList(action.references, 'update.references') } : {}),
        reason,
      };
    }
    if (type === 'delete') {
      const observationId = typeof action.observationId === 'string' ? action.observationId.trim() : '';
      claimModifiedObservationId(observationId, modifiedObservationIds);
      return {
        type: 'delete',
        observationId,
        reason,
      };
    }
    throw new Error('unknown observation change type');
  });
}

function normalizeIdList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return [...new Set(value.map((id) => typeof id === 'string' ? id.trim() : '').filter(Boolean))];
}

function claimModifiedObservationId(observationId: string, modifiedObservationIds: Set<string>): void {
  if (!observationId) {
    throw new Error('observation change missing observationId');
  }
  if (observationId.startsWith('session:')) {
    throw new Error(`observation change cannot modify source turn id: ${observationId}`);
  }
  if (modifiedObservationIds.has(observationId)) {
    throw new Error(`observation change modifies observationId more than once: ${observationId}`);
  }
  modifiedObservationIds.add(observationId);
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
  if (!Array.isArray(observations)) {
    throw new Error('observingContent.observations must be an array');
  }
  return observations.map((observation) => {
    const text = normalizeText(observation.text);
    if (!text) {
      throw new Error('observing update returned an empty observation text');
    }
    return {
      id: observation.id?.trim() || null,
      text,
      category: normalizeCategory(observation.category),
      updatedMemory: observation.updatedMemory?.trim() || null,
    };
  });
}

function rejectRelativeTime(result: ObserveResult, input?: ObserveRequest): void {
  if (!inputHasDateAnchor(input)) {
    return;
  }
  const texts = [
    ...result.observingContent.observations.map((observation) => observation.text),
    ...result.observationChanges.flatMap((change) => (
      change.type === 'add' || change.type === 'merge' || change.type === 'update'
        ? [change.text]
        : []
    )),
  ];
  const relativePattern = /\b(?:yesterday|tomorrow|last|next)\s+(?:day|week|month|year)\b/i;
  for (const text of texts) {
    if (relativePattern.test(text)) {
      throw new Error('observation text must normalize clear relative dates or periods using DATE anchors');
    }
  }
}

function inputHasDateAnchor(input?: ObserveRequest): boolean {
  return Boolean(input?.sourceRefs.some((reference) => /\bDATE:/i.test(reference.prompt ?? '')));
}

function normalizeCategory(value: unknown): ObservationCategory {
  if (
    value === 'Preference'
    || value === 'Fact'
    || value === 'Decision'
    || value === 'Entity'
    || value === 'Concept'
    || value === 'Other'
  ) {
    return value;
  }
  throw new Error(`invalid observation category: ${String(value)}`);
}

function normalizeStringList(values: string[]): string[] {
  return values
    .map((value) => normalizeText(value, MAX_LIST_ITEM_CHARS))
    .filter((value): value is string => Boolean(value));
}

type ToolHandler = (args: Record<string, unknown>, call: LlmToolCall) => Promise<unknown> | unknown;

async function runToolLoop(params: {
  messages: LlmToolMessage[];
  tools: LlmTool[];
  toolHandlers: Record<string, ToolHandler>;
  model: ToolModel;
  signal?: AbortSignal;
  maxSteps?: number;
  onToolResults?: (event: {
    toolCalls: LlmToolCall[];
    toolResults: Array<{
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      result: unknown;
    }>;
  }) => Promise<void> | void;
}): Promise<string> {
  const maxSteps = params.maxSteps ?? 3;
  const messages = [...params.messages];
  for (let step = 0; step < maxSteps; step += 1) {
    throwIfAborted(params.signal);
    const result = await params.model('observer', {
      messages,
      tools: params.tools,
      signal: params.signal,
    });
    if (!result) {
      throw new Error('llm did not return a tool result');
    }
    if (result.type === 'final') {
      return result.text;
    }
    messages.push({
      role: 'assistant',
      toolCalls: result.toolCalls,
    });
    const toolResults = [];
    for (const call of result.toolCalls) {
      const handler = params.toolHandlers[call.name];
      if (!handler) {
        throw new Error(`unknown tool: ${call.name}`);
      }
      throwIfAborted(params.signal);
      const toolResult = await handler(call.arguments, call);
      toolResults.push({
        id: call.id,
        name: call.name,
        arguments: call.arguments,
        result: toolResult,
      });
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify(toolResult),
      });
    }
    await params.onToolResults?.({ toolCalls: result.toolCalls, toolResults });
  }
  throw new Error(`tool loop exceeded maxSteps=${maxSteps}`);
}

function memoryGetSpec(): LlmTool {
  return {
    name: 'memory_get',
    description: 'Get full rendered details for allowlisted memory ids when source refs or summaries are insufficient.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        memoryIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Allowlisted memory ids from the current thread, existing observations, or source refs.',
        },
      },
      required: ['memoryIds'],
    },
  };
}

function createMemoryGetTool(input: ObserveRequest, memories?: Pick<Memories, 'get'>) {
  const allowlist = new Set(buildObserveMemoryAllowlist(input));
  return async (args: Record<string, unknown>) => {
    const memoryIds = normalizeMemoryIds(args.memoryIds);
    const results = [];
    for (const memoryId of memoryIds) {
      if (!allowlist.has(memoryId)) {
        results.push({ memoryId, error: 'memory id is not allowlisted' });
        continue;
      }
      if (!memories) {
        results.push({ memoryId, error: 'memory_get is unavailable' });
        continue;
      }
      const memory = await memories.get(memoryId);
      results.push(memory
        ? { memoryId, content: renderRenderedMemoryMarkdown(memory) }
        : { memoryId, error: 'memory not found' });
    }
    return { memories: results };
  };
}

function buildObserveMemoryAllowlist(input: ObserveRequest): string[] {
  return [
    ...(input.threadMemoryId ? [input.threadMemoryId] : []),
    ...input.observingContent.observations
      .map((observation) => observation.id)
      .filter((id): id is string => Boolean(id?.trim()))
      .map((id) => `observation:${id}`),
    ...input.sourceRefs.map((reference) => reference.turnId),
  ];
}

function normalizeMemoryIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((memoryId) => (typeof memoryId === 'string' ? memoryId.trim() : ''))
    .filter(Boolean)
    .filter((memoryId, index, values) => values.indexOf(memoryId) === index);
}

function createObserveTrace(input: ObserveRequest) {
  return {
    input: {
      observingContent: input.observingContent,
      sourceRefs: input.sourceRefs,
      threadMemoryId: input.threadMemoryId ?? null,
      allowedMemoryIds: buildObserveMemoryAllowlist(input),
    },
    toolCalls: [] as LlmToolCall[],
    toolResults: [] as Array<{
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      result: unknown;
    }>,
  };
}

async function writeObserveTrace(event: {
  input: unknown;
  toolCalls: LlmToolCall[];
  toolResults: unknown[];
  finalJson: string;
  observationChanges: ObservationChange[];
}): Promise<void> {
  const file = process.env.MUNINN_THREAD_OBSERVING_TRACE_FILE;
  if (!file) {
    return;
  }
  await appendFile(file, `${JSON.stringify(event)}\n`, 'utf8');
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
