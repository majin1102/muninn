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
import { loadDomainPrompt, loadGatewayDomainPrompt } from './domain-prompt.js';
import { loadPromptTemplate, renderPromptTemplate } from './prompt-loader.js';

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
        kind: thread.kind,
        title: thread.title,
        summary: thread.summary,
      })),
      pendingTurns: gatewayTurns.map((turn) => ({
        turnId: turn.turnId,
        text: turn.text,
      })),
    },
    null,
    2,
  );
  const systemPrompt = buildGatewaySystemPrompt(config.domainPrompt);
  const basePrompt = renderPromptTemplate(template.userTemplate, { input_json: inputJson });

  let lastError = 'observer gateway returned no output';
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    throwIfAborted(signal);
    const raw = await generateText('observer', {
      system: systemPrompt,
      prompt: buildRetryPrompt(
        basePrompt,
        attempt,
        lastError,
        'Make sure every sessionFragment has threadId, turnIds, content, and reason.',
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

function toGatewayTurns(pendingTurns: SessionTurn[]): Array<{ turnId: string; text: string }> {
  return pendingTurns.map((turn) => ({
    turnId: turn.turnId,
    text: renderGatewayTurnText(turn),
  }));
}

function renderGatewayTurnText(turn: SessionTurn): string {
  const parts = [
    labeledText('Prompt', turn.prompt),
    labeledText('Response', turn.response),
  ].filter(Boolean);
  if (parts.length > 0) {
    return parts.join('\n\n');
  }
  return turn.summary ?? '';
}

function labeledText(label: string, value?: string | null): string | null {
  const text = value?.trim();
  return text ? `${label}:\n${text}` : null;
}

function buildGatewaySystemPrompt(domainPrompt?: string): string {
  const template = loadPromptTemplate('observing_gateway');
  return renderPromptTemplate(template.system, {
    domain_prompt: loadGatewayDomainPrompt(domainPrompt)?.trim() || 'No additional domain thread guidance.',
  });
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
    return validateObserveResult(buildMockObserveResult(input));
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
      fragments: input.fragments.map((fragment) => ({
        content: fragment.content,
        turns: fragment.turns.map((turn) => ({
          turnId: turn.turnId,
          ...(turn.prompt ? { prompt: turn.prompt } : {}),
          ...(turn.response ? { response: turn.response } : {}),
        })),
      })),
    },
    null,
    2,
  );
  const basePrompt = renderPromptTemplate(template.userTemplate, { input_json: inputJson });
  const trace = createObserveTrace(input);

  let lastError = 'observing update returned no output';
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    throwIfAborted(signal);
    const attemptToolResults: typeof trace.toolResults = [];
    const startedAt = Date.now();
    const raw = await runToolLoop({
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: buildRetryPrompt(
            basePrompt,
            attempt,
            lastError,
            'Return observingContent with title, summary, observations, openQuestions, and nextSteps; keep contextRefs present.',
          ),
        },
      ],
      tools: [memoryGetSpec()],
      toolHandlers: {
        'memory-get': createMemoryGetTool(input, deps.memories),
      },
      model: deps.model ?? generateWithTools,
      signal,
      onToolResults: (event) => {
        trace.toolCalls.push(...event.toolCalls);
        trace.toolResults.push(...event.toolResults);
        attemptToolResults.push(...event.toolResults);
      },
    });
    const durationMs = Date.now() - startedAt;
    if (!raw) {
      throw new Error('observing update is not configured');
    }
    throwIfAborted(signal);

    try {
      const result = validateObserveResult(parseJson<ObserveResult>(raw), input);
      await writeObserveTrace({
        ...trace,
        attempt,
        durationMs,
        finalJson: raw,
        observations: result.observingContent.observations,
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
  const targetThread = observingThreads.find((thread) => thread.kind === 'session') ?? observingThreads[0];
  return {
    sessionFragments: targetThread
      ? pendingTurns.map((turn) => ({
          threadId: targetThread.threadId,
          turnIds: [turn.turnId],
          content: normalizeText(turn.text, MAX_SUMMARY_CHARS),
          reason: 'The turn is routed to the existing observing thread for inspection.',
        }))
      : [],
  };
}

function buildMockObserveResult(input: ObserveRequest): ObserveResult {
  const joined = input.fragments
    .map((fragment) => normalizeText(fragment.content, MAX_SUMMARY_CHARS))
    .filter(Boolean)
    .join(' ');
  const turnIds = fragmentTurnIds(input);
  const titleSeed = input.observingContent.title || joined || 'Mock observing thread';
  const summarySeed = [input.observingContent.summary, joined]
    .filter((value) => value && value.trim())
    .join(' ');
  return {
    observingContent: {
      title: normalizeText(titleSeed),
      summary: normalizeText(summarySeed || titleSeed),
      observations: joined
        ? [{
            text: joined,
            category: 'Fact',
            references: turnIds,
          }]
        : input.observingContent.observations,
      openQuestions: input.observingContent.openQuestions,
      nextSteps: input.observingContent.nextSteps,
    },
    contextRefs: input.fragments
      .flatMap((fragment) => fragment.turns.map((turn) => ({
        turnId: turn.turnId,
        summary: normalizeText(fragment.content, MAX_SUMMARY_CHARS),
      })))
      .filter((reference) => reference.summary),
  };
}

function validateGatewayResult(
  observingThreads: ObservingThreadGatewayInput[],
  pendingTurns: Array<{ turnId: string; text: string }>,
  result: GatewayResult,
): GatewayResult {
  const validTurnIds = new Set(pendingTurns.map((turn) => turn.turnId));
  const validThreadIds = new Set(observingThreads.map((thread) => thread.threadId));
  if (!Array.isArray(result.sessionFragments)) {
    throw new Error('observer gateway returned sessionFragments that are not an array');
  }
  const sessionFragments = result.sessionFragments.map((fragment) => {
    const threadId = typeof fragment.threadId === 'string' ? fragment.threadId.trim() : '';
    if (!validThreadIds.has(threadId)) {
      throw new Error(`observer gateway referenced unknown threadId: ${threadId}`);
    }
    const turnIds = Array.isArray(fragment.turnIds)
      ? [...new Set(fragment.turnIds.map((turnId) => typeof turnId === 'string' ? turnId.trim() : '').filter(Boolean))]
      : [];
    if (turnIds.length === 0) {
      throw new Error('observer gateway sessionFragment must include turnIds');
    }
    for (const turnId of turnIds) {
      if (!validTurnIds.has(turnId)) {
        throw new Error(`observer gateway referenced unknown turnId: ${turnId}`);
      }
    }
    const content = normalizeText(typeof fragment.content === 'string' ? fragment.content : '');
    if (!content) {
      throw new Error('observer gateway returned empty content');
    }
    const reason = normalizeText(fragment.reason ?? '', MAX_SUMMARY_CHARS);
    if (!reason) {
      throw new Error('observer gateway returned empty reason');
    }
      return {
        threadId,
        turnIds,
        content,
        reason,
      };
  });
  return { sessionFragments };
}

function validateObserveResult(result: ObserveResult, input?: ObserveRequest): ObserveResult {
  if (result && typeof result === 'object' && 'observationChanges' in result) {
    throw new Error('observe result must not return observationChanges; return observingContent.observations');
  }
  const title = normalizeText(result.observingContent.title);
  if (!title) {
    throw new Error('observing update returned empty observingContent.title');
  }

  const summary = normalizeText(result.observingContent.summary);
  if (!summary) {
    throw new Error('observing update returned empty observingContent.summary');
  }

  const existingObservationIds = new Set(
    input?.observingContent.observations
      .map((observation) => observation.id?.trim())
      .filter((id): id is string => Boolean(id)) ?? [],
  );
  const allowedReferenceIds = new Set([
    ...(input ? fragmentTurnIds(input) : []),
    ...(input?.observingContent.observations.flatMap((observation) => observation.references ?? []) ?? []),
  ]);

  const normalized = {
    observingContent: {
      title,
      summary,
      observations: normalizeObservations(
        result.observingContent.observations,
        existingObservationIds,
        allowedReferenceIds,
      ),
      openQuestions: normalizeStringList(result.observingContent.openQuestions),
      nextSteps: normalizeStringList(result.observingContent.nextSteps),
    },
    contextRefs: normalizeContextRefs(result.contextRefs),
  };
  return normalized;
}

function normalizeObservations(
  observations: unknown,
  existingObservationIds: Set<string>,
  allowedReferenceIds: Set<string>,
): Observation[] {
  if (!Array.isArray(observations)) {
    throw new Error('observingContent.observations must be an array');
  }
  const seenIds = new Set<string>();
  return observations.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new Error('observations entries must be objects');
    }
    const observation = item as Record<string, unknown>;
    const id = typeof observation.id === 'string' ? observation.id.trim() : '';
    if (id) {
      if (seenIds.has(id)) {
        throw new Error(`duplicate observation id: ${id}`);
      }
      if (existingObservationIds.size > 0 && !existingObservationIds.has(id)) {
        throw new Error(`unknown observation id: ${id}`);
      }
      seenIds.add(id);
    }
    const text = typeof observation.text === 'string' ? normalizeText(observation.text) : '';
    if (!text) {
      throw new Error('observation text is required');
    }
    const references = normalizeIdList(observation.references, 'observation references');
    if (references.length === 0) {
      throw new Error('observation references must include at least one reference');
    }
    if (allowedReferenceIds.size > 0) {
      for (const reference of references) {
        if (!allowedReferenceIds.has(reference)) {
          throw new Error(`observation referenced non-visible memory id: ${reference}`);
        }
      }
    }
    return {
      ...(id ? { id } : {}),
      text,
      category: normalizeCategory(observation.category),
      references,
    };
  });
}

function normalizeIdList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return [...new Set(value.map((id) => typeof id === 'string' ? id.trim() : '').filter(Boolean))];
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
    name: 'memory-get',
    description: 'Get visible source turn details to verify context and update memories.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        memoryIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Visible fragments[].turns[].turnId values to inspect for detailed source context.',
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
        results.push({ memoryId, error: 'memory-get is unavailable' });
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
  return fragmentTurnIds(input);
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
      fragments: input.fragments,
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

function fragmentTurnIds(input: ObserveRequest): string[] {
  return [...new Set(input.fragments.flatMap((fragment) => (
    fragment.turns.map((turn) => turn.turnId)
  )))];
}

async function writeObserveTrace(event: {
  input: unknown;
  attempt: number;
  durationMs: number;
  toolCalls: LlmToolCall[];
  toolResults: unknown[];
  finalJson: string;
  observations: Observation[];
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
  buildGatewaySystemPromptForTests: buildGatewaySystemPrompt,
  gatewayTurnsForTests: toGatewayTurns,
  validateGatewayResultForTests: validateGatewayResult,
  validateObserveResultForTests: validateObserveResult,
};
