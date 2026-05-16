import { appendFile } from 'node:fs/promises';

import type { Turn } from '../client.js';
import { getExtractorLlmConfig } from '../config.js';
import type { Memories } from '../memories/memories.js';
import { renderRenderedMemoryMarkdown } from '../memories/rendered.js';
import type {
  GatewayResult,
  ObserveRequest,
  ObserveResult,
  Extraction,
  ObservingThreadGatewayInput,
  ContextRef,
} from '../extractor/types.js';
import { parseThreadMemoryDocument } from '../extractor/thread-memory.js';
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
import { loadGatewayDomainPrompt } from './domain-prompt.js';
import { loadPromptTemplate, renderPromptTemplate } from './prompt-loader.js';

const MAX_SUMMARY_CHARS = 220;

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
  pendingTurns: Turn[],
  signal?: AbortSignal,
): Promise<GatewayResult> {
  throwIfAborted(signal);
  const config = getExtractorLlmConfig();
  if (!config) {
    throw new Error('extractor gateway is not configured');
  }

  const gatewayTurns = toGatewayTurns(pendingTurns);

  if (config.provider === 'mock') {
    return validateGatewayResult(
      observingThreads,
      gatewayTurns,
      buildMockGatewayResult(observingThreads, gatewayTurns),
    );
  }

  const template = loadPromptTemplate('extracting_gateway');
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

  let lastError = 'extractor gateway returned no output';
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    throwIfAborted(signal);
    const raw = await generateText('extractor', {
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
      throw new Error('extractor gateway is not configured');
    }
    throwIfAborted(signal);

    try {
      const parsed = parseJson<GatewayResult>(raw);
      return validateGatewayResult(observingThreads, gatewayTurns, parsed);
    } catch (error) {
      lastError = String(error);
    }
  }

  throw new Error(`extractor gateway returned invalid output: ${lastError}`);
}

function toGatewayTurns(pendingTurns: Turn[]): Array<{ turnId: string; text: string }> {
  return pendingTurns.map((turn) => ({
    turnId: turn.turnId,
    text: renderGatewayTurnText(turn),
  }));
}

function renderGatewayTurnText(turn: Turn): string {
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
  const template = loadPromptTemplate('extracting_gateway');
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
  const config = getExtractorLlmConfig();
  if (!config) {
    throw new Error('extraction update is not configured');
  }

  if (config.provider === 'mock') {
    return validateObserveResult(buildMockThreadMemory(input), input);
  }

  const template = loadPromptTemplate('thread_extracting');
  const systemPrompt = template.system;
  const inputJson = JSON.stringify(
    {
      memory: promptMemory(input.observingContent.threadMemory ?? ''),
      newTurns: input.turns.map((turn) => ({
        turnId: turn.turnId,
        ...(turn.prompt ? { prompt: turn.prompt } : {}),
        ...(turn.response ? { response: turn.response } : {}),
        ...(turn.summary ? { summary: turn.summary } : {}),
      })),
    },
    null,
    2,
  );
  const basePrompt = renderPromptTemplate(template.userTemplate, { input_json: inputJson });
  const trace = createObserveTrace(input);

  let lastError = 'extraction update returned no output';
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
            'Return only valid thread memory Markdown with one `#` title, one `## Summary`, one `## Extractions`, and valid memory units under `## Extractions`.',
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
      throw new Error('extraction update is not configured');
    }
    throwIfAborted(signal);

    try {
      const result = validateObserveResult(raw, input);
      await writeObserveTrace({
        ...trace,
        attempt,
        durationMs,
        finalText: raw,
        extractions: result.extractions,
      });
      return result;
    } catch (error) {
      lastError = String(error);
      await writeObserveTrace({
        ...trace,
        attempt,
        durationMs,
        rawText: raw,
        validationError: lastError,
        extractions: [],
      });
    }
  }

  throw new Error(`extraction update returned invalid output: ${lastError}`);
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

function buildMockThreadMemory(input: ObserveRequest): string {
  const joined = input.turns
    .map((turn) => normalizeText(renderObserveTurnText(turn), MAX_SUMMARY_CHARS))
    .filter(Boolean)
    .join(' ');
  const memory = promptMemory(input.observingContent.threadMemory ?? '');
  const existingMemory = /<!--\s*refs:/i.test(memory)
    ? memory
    : '';
  const references = input.turns.map((turn) => turn.turnId).filter(Boolean);
  const newMemory = joined && references.length > 0
    ? `${threadMemoryMetadata(references)}\n[Fact] observed turn\n[Extraction] ${joined}`
    : '';
  const extractions = [extractExtractionSection(existingMemory), newMemory]
    .filter((value) => value && value.trim())
    .join('\n\n----\n')
    .trim() || `${threadMemoryMetadata([references[0] ?? 'session:mock'])}\n[Fact] mock memory\n[Extraction] ${input.observingContent.title || 'Mock observing thread'}`;
  return [
    `# ${input.observingContent.title || 'Observing Thread'}`,
    '',
    '## Summary',
    input.observingContent.summary || 'This thread tracks observed conversation memory.',
    '',
    '## Extractions',
    extractions,
  ].join('\n');
}

function threadMemoryMetadata(references: string[]): string {
  return `<!-- refs: [${references.join(', ')}] -->`;
}

function promptMemory(summary: string): string {
  const text = normalizeText(summary);
  return isDefaultSummary(text) ? '' : text;
}

function extractExtractionSection(memory: string): string {
  const match = memory.match(/^##\s+Extractions\s*$/im);
  if (!match || match.index === undefined) {
    return memory;
  }
  return memory.slice(match.index + match[0].length).trim();
}

function isDefaultSummary(text: string): boolean {
  return text === 'Default observing thread for this session.'
    || /^Default observing thread for session .+\.$/.test(text);
}

function validateGatewayResult(
  observingThreads: ObservingThreadGatewayInput[],
  pendingTurns: Array<{ turnId: string; text: string }>,
  result: GatewayResult,
): GatewayResult {
  const validTurnIds = new Set(pendingTurns.map((turn) => turn.turnId));
  const validThreadIds = new Set(observingThreads.map((thread) => thread.threadId));
  if (!Array.isArray(result.sessionFragments)) {
    throw new Error('extractor gateway returned sessionFragments that are not an array');
  }
  const sessionFragments = result.sessionFragments.map((fragment) => {
    const threadId = typeof fragment.threadId === 'string' ? fragment.threadId.trim() : '';
    if (!validThreadIds.has(threadId)) {
      throw new Error(`extractor gateway referenced unknown threadId: ${threadId}`);
    }
    const turnIds = Array.isArray(fragment.turnIds)
      ? [...new Set(fragment.turnIds.map((turnId) => typeof turnId === 'string' ? turnId.trim() : '').filter(Boolean))]
      : [];
    if (turnIds.length === 0) {
      throw new Error('extractor gateway sessionFragment must include turnIds');
    }
    for (const turnId of turnIds) {
      if (!validTurnIds.has(turnId)) {
        throw new Error(`extractor gateway referenced unknown turnId: ${turnId}`);
      }
    }
    const content = normalizeText(typeof fragment.content === 'string' ? fragment.content : '');
    if (!content) {
      throw new Error('extractor gateway returned empty content');
    }
    const reason = normalizeText(fragment.reason ?? '', MAX_SUMMARY_CHARS);
    if (!reason) {
      throw new Error('extractor gateway returned empty reason');
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

function validateObserveResult(result: string, input?: ObserveRequest): ObserveResult {
  const contextRefs = observeContextRefs(input);
  const validReferences = validThreadMemoryReferences(input);
  const parsed = parseThreadMemoryDocument(result, validReferences);

  return {
    title: parsed.title,
    summary: parsed.summary,
    threadMemory: parsed.threadMemory,
    extractions: parsed.extractions,
    openQuestions: input?.observingContent.openQuestions ?? [],
    nextSteps: input?.observingContent.nextSteps ?? [],
    contextRefs,
  };
}

function observeContextRefs(input?: ObserveRequest): ContextRef[] {
  return input?.turns
    .map((turn) => ({
      turnId: turn.turnId,
      summary: normalizeText(renderObserveTurnText(turn), MAX_SUMMARY_CHARS),
    }))
    .filter((reference) => reference.turnId && reference.summary) ?? [];
}

function validThreadMemoryReferences(input: ObserveRequest | undefined): Set<string> {
  return new Set([
    ...(input?.turns.map((turn) => turn.turnId).filter(Boolean) ?? []),
    ...(input?.observingContent.extractions.flatMap((extraction) => extraction.references ?? []) ?? []),
  ]);
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
    const result = await params.model('extractor', {
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
    description: 'Get visible raw turn details to verify context and update memories.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        memoryIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Visible turns[].turnId values to inspect for detailed source context.',
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
  return observeTurnIds(input);
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
      turns: input.turns,
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

function observeTurnIds(input: ObserveRequest): string[] {
  return [...new Set(input.turns.map((turn) => turn.turnId))];
}

function renderObserveTurnText(turn: { prompt?: string | null; response?: string | null; summary?: string | null }): string {
  const parts = [
    labeledText('Prompt', turn.prompt),
    labeledText('Response', turn.response),
    labeledText('Summary', turn.summary),
  ].filter(Boolean);
  return parts.join('\n\n');
}

async function writeObserveTrace(event: {
  input: unknown;
  attempt: number;
  durationMs: number;
  toolCalls: LlmToolCall[];
  toolResults: unknown[];
  finalText?: string;
  rawText?: string;
  validationError?: string;
  extractions: Extraction[];
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
  return `${basePrompt}\n\nPrevious output was invalid.\nValidation error: ${lastError}\n${rule}`;
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
