import { appendFile } from 'node:fs/promises';

import { getObserverLlmConfig } from '../config.js';
import { loadPromptTemplate, renderPromptTemplate } from '../llm/prompt-loader.js';
import {
  generateWithTools,
  type LlmTask,
  type LlmTool,
  type LlmToolCall,
  type LlmToolMessage,
  type LlmToolRequest,
  type LlmToolResult,
} from '../llm/provider.js';
import type { Memories } from '../memories/memories.js';
import { renderRenderedMemoryMarkdown } from '../memories/rendered.js';
import type { Extraction } from '../native.js';
import type {
  ThreadCandidateMemory,
  ThreadPreparationResult,
  ThreadPreparationThread,
  ThreadPreparationWorkItem,
} from './types.js';

export type ThreadPreparationInput = {
  reviewedExtractions: Extraction[];
  activeThreads: ThreadPreparationThread[];
  candidateMemories?: ThreadCandidateMemory[];
};

type ThreadPreparationDeps = {
  memories?: Pick<Memories, 'get' | 'recall'>;
  model?: ToolModel;
};

type ToolModel = (
  task: LlmTask,
  request: LlmToolRequest,
) => Promise<LlmToolResult | null>;

export async function prepareThreads(
  input: ThreadPreparationInput,
  signal?: AbortSignal,
  deps: ThreadPreparationDeps = {},
): Promise<ThreadPreparationResult> {
  throwIfAborted(signal);
  const config = getObserverLlmConfig();
  if (!config) {
    throw new Error('observer is not configured');
  }
  if (config.provider === 'mock') {
    return validateThreadPreparation(input, {
      workItems: [],
      unthreadedExtractionIds: input.reviewedExtractions.map((extraction) => extraction.id),
    });
  }

  const template = loadPromptTemplate('thread_preparation');
  const inputJson = JSON.stringify(toPromptInput(input), null, 2);
  const trace = createThreadPreparationTrace(input);
  const raw = await runNativeToolLoop({
    messages: [
      { role: 'system', content: template.system },
      {
        role: 'user',
        content: renderPromptTemplate(template.userTemplate, { input_json: inputJson }),
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
    },
  });
  const result = validateOrFallback(input, raw);
  await writeThreadPreparationTrace({
    ...trace,
    result,
  });
  return result;
}

function validateOrFallback(input: ThreadPreparationInput, raw: string): ThreadPreparationResult {
  try {
    return validateThreadPreparation(input, parseJson<ThreadPreparationResult>(raw));
  } catch {
    return {
      workItems: [],
      unthreadedExtractionIds: input.reviewedExtractions.map((extraction) => extraction.id),
    };
  }
}

async function runNativeToolLoop(params: {
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
    await params.onToolResults?.({
      toolCalls: result.toolCalls,
      toolResults,
    });
  }
  throw new Error(`tool loop exceeded maxSteps=${maxSteps}`);
}

type ToolHandler = (args: Record<string, unknown>, call: LlmToolCall) => Promise<unknown> | unknown;

export async function collectCandidateMemories(params: {
  reviewedExtractions: Extraction[];
  memories: Pick<Memories, 'recall'>;
  limitPerExtraction?: number;
}): Promise<ThreadCandidateMemory[]> {
  const limit = params.limitPerExtraction ?? 5;
  const reviewedMemoryIds = new Set(params.reviewedExtractions.map((extraction) => `extraction:${extraction.id}`));
  const seen = new Set<string>();
  const candidates: ThreadCandidateMemory[] = [];
  for (const extraction of params.reviewedExtractions) {
    const hits = await params.memories.recall(extraction.text, limit).catch(() => []);
    for (const hit of hits) {
      if (reviewedMemoryIds.has(hit.memoryId) || seen.has(hit.memoryId)) {
        continue;
      }
      seen.add(hit.memoryId);
      candidates.push({
        memoryId: hit.memoryId,
        title: hit.text,
        summary: hit.text,
      });
    }
  }
  return candidates;
}

function createMemoryGetTool(
  input: ThreadPreparationInput,
  memories?: Pick<Memories, 'get'>,
) {
  const allowlist = buildMemoryGetAllowlist(input);
  return async (args: Record<string, unknown>) => {
    const memoryIds = normalizeMemoryIds(args.memoryIds);
    const results = [];
    for (const memoryId of memoryIds) {
      if (!allowlist.has(memoryId)) {
        results.push({
          memoryId,
          error: 'memory id is not allowlisted',
        });
        continue;
      }
      if (!memories) {
        results.push({
          memoryId,
          error: 'memory-get is unavailable',
        });
        continue;
      }
      const memory = await memories.get(memoryId);
      results.push(memory
        ? {
            memoryId,
            content: renderRenderedMemoryMarkdown(memory),
          }
        : {
            memoryId,
            error: 'memory not found',
          });
    }
    return { memories: results };
  };
}

function memoryGetSpec(): LlmTool {
  return {
    name: 'memory-get',
    description: 'Get full rendered details for allowlisted memory ids when summaries are insufficient.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        memoryIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Allowlisted memory ids from reviewedExtractions, activeThreads, or candidateMemories.',
        },
      },
      required: ['memoryIds'],
    },
  };
}

function createThreadPreparationTrace(input: ThreadPreparationInput) {
  return {
    reviewedExtractions: toPromptInput(input).reviewedExtractions,
    activeThreads: input.activeThreads,
    candidateMemories: input.candidateMemories ?? [],
    toolCalls: [] as LlmToolCall[],
    toolResults: [] as Array<{
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      result: unknown;
    }>,
  };
}

async function writeThreadPreparationTrace(event: {
  reviewedExtractions: unknown;
  activeThreads: ThreadPreparationThread[];
  candidateMemories: ThreadCandidateMemory[];
  toolCalls: LlmToolCall[];
  toolResults: unknown[];
  result: ThreadPreparationResult;
}): Promise<void> {
  const file = process.env.MUNINN_THREAD_PREPARATION_TRACE_FILE;
  if (!file) {
    return;
  }
  await appendFile(file, `${JSON.stringify(event)}\n`, 'utf8');
}

function buildMemoryGetAllowlist(input: ThreadPreparationInput): Set<string> {
  return new Set([
    ...input.reviewedExtractions.map((extraction) => `extraction:${extraction.id}`),
    ...input.activeThreads
      .map((thread) => thread.memoryId)
      .filter((memoryId): memoryId is string => Boolean(memoryId?.trim())),
    ...(input.candidateMemories ?? []).map((memory) => memory.memoryId),
  ]);
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

function validateThreadPreparation(
  input: ThreadPreparationInput,
  result: ThreadPreparationResult,
): ThreadPreparationResult {
  if (!result || typeof result !== 'object') {
    throw new Error('thread preparation must return an object');
  }
  if (!Array.isArray(result.workItems)) {
    throw new Error('thread preparation workItems must be an array');
  }

  const reviewedIds = new Set(input.reviewedExtractions.map((extraction) => extraction.id));
  const activeThreadIds = new Set(input.activeThreads.map((thread) => thread.threadId));
  const seen = new Set<string>();
  const workItems = result.workItems.map((item) => (
    validateWorkItem(item, reviewedIds, activeThreadIds, seen)
  ));
  const unthreadedExtractionIds = normalizeIdList(result.unthreadedExtractionIds, 'unthreadedExtractionIds');
  for (const id of unthreadedExtractionIds) {
    if (!reviewedIds.has(id)) {
      throw new Error(`unthreadedExtractionIds includes unknown extraction id: ${id}`);
    }
    if (seen.has(id)) {
      throw new Error(`reviewed extraction id must appear exactly once: ${id}`);
    }
    seen.add(id);
  }

  for (const id of reviewedIds) {
    if (!seen.has(id)) {
      throw new Error(`reviewed extraction id must appear exactly once: ${id}`);
    }
  }

  return {
    workItems,
    unthreadedExtractionIds,
  };
}

function validateWorkItem(
  item: ThreadPreparationWorkItem,
  reviewedIds: Set<string>,
  activeThreadIds: Set<string>,
  seen: Set<string>,
): ThreadPreparationWorkItem {
  if (!item || typeof item !== 'object') {
    throw new Error('thread preparation work item must be an object');
  }
  const extractionIds = normalizeIdList(item.extractionIds, 'workItems[].extractionIds');
  if (extractionIds.length === 0) {
    throw new Error('workItems[].extractionIds must include at least one extraction id');
  }
  for (const id of extractionIds) {
    if (!reviewedIds.has(id)) {
      throw new Error(`work item includes unknown extraction id: ${id}`);
    }
    if (seen.has(id)) {
      throw new Error(`reviewed extraction id must appear exactly once: ${id}`);
    }
    seen.add(id);
  }

  const targetThreadId = normalizeOptionalString(item.targetThreadId);
  const newThreadTitle = normalizeOptionalString(item.newThreadTitle);
  if ((targetThreadId && newThreadTitle) || (!targetThreadId && !newThreadTitle)) {
    throw new Error('work item must include either targetThreadId or newThreadTitle');
  }
  if (targetThreadId && !activeThreadIds.has(targetThreadId)) {
    throw new Error(`unknown targetThreadId: ${targetThreadId}`);
  }
  if (newThreadTitle && extractionIds.length < 2) {
    throw new Error('newThreadTitle requires at least two related extractions');
  }

  const rationale = typeof item.rationale === 'string' ? item.rationale.trim() : '';
  if (!rationale) {
    throw new Error('work item rationale must be a non-empty string');
  }

  return {
    extractionIds,
    ...(targetThreadId ? { targetThreadId } : {}),
    ...(newThreadTitle ? { newThreadTitle } : {}),
    rationale,
  };
}

function normalizeIdList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  const ids = value.map((id) => (typeof id === 'string' ? id.trim() : '')).filter(Boolean);
  if (ids.length !== new Set(ids).size) {
    throw new Error(`${label} contains duplicate extraction ids`);
  }
  return ids;
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function toPromptInput(input: ThreadPreparationInput): Record<string, unknown> {
  return {
    reviewedExtractions: input.reviewedExtractions.map((extraction) => ({
      id: extraction.id,
      memoryId: `extraction:${extraction.id}`,
      text: extraction.text,
      category: extraction.category,
      references: extraction.references,
    })),
    activeThreads: input.activeThreads,
    candidateMemories: input.candidateMemories ?? [],
  };
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
  collectCandidateMemories,
  prepareThreadsWithModel: (
    input: ThreadPreparationInput,
    deps: ThreadPreparationDeps,
    signal?: AbortSignal,
  ) => prepareThreads(input, signal, deps),
  validateThreadPreparation,
};
