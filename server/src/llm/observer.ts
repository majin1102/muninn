import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { parseObservationSubtree } from '../pipeline/observation.js';
import type { ParsedObservationDocument } from '../pipeline/observation.js';
import { getObserverRuntimeConfig, resolveDatabaseLogPath, resolveDatabaseName } from '../config.js';
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
import { loadPromptTemplate, renderPromptTemplate } from './prompts.js';

export type ObservationExtractionInput = {
  id: string;
  status?: 'new' | 'changed';
  text: string;
  context?: string | null;
  cwd?: string;
  turnRefs?: string[];
};

export type ObservationPatchInput = {
  cwdScope: string;
  outline: string;
  observedDocument: string;
  extractions: ObservationExtractionInput[];
  validRefs?: string[];
  getObservation?: (paths: string[]) => Promise<string> | string;
  maxAttempts?: number;
  database?: string;
  signal?: AbortSignal;
  model?: ToolModel;
};

type ToolModel = (
  task: LlmTask,
  request: LlmToolRequest,
) => Promise<LlmToolResult | null>;

export async function generateObservationPatch(input: ObservationPatchInput): Promise<ParsedObservationDocument> {
  const template = loadPromptTemplate('thread_observing');
  const database = resolveDatabaseName(input.database);
  const contentBudgetChars = getObserverRuntimeConfig().contentBudgetChars;
  const observedDocument = trimContent(input.observedDocument, contentBudgetChars);
  const prompt = renderPromptTemplate(template.userTemplate, {
    outline: input.outline.trim() || '(none)',
    observed_document: observedDocument.trim() || '(none)',
    extractions: renderExtractions(input.extractions),
  });
  const validRefs = new Set([
    ...(input.validRefs ?? []),
    ...extractRefs(input.observedDocument),
    ...input.extractions.map((extraction) => extraction.id),
  ]);
  const attempts = input.maxAttempts ?? 2;
  const trace = {
    input: {
      cwdScope: input.cwdScope,
      outline: input.outline,
      observedDocument,
      extractions: input.extractions,
      contentBudgetChars,
    },
    prompt: {
      system: template.system,
      user: prompt,
    },
  };
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    throwIfAborted(input.signal);
    const attemptToolResults: Array<{
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      result: unknown;
    }> = [];
    const startedAt = Date.now();
    const raw = await generateObservationText({
      system: template.system,
      prompt: attempt === 1 ? prompt : `${prompt}\n\nPrevious output was invalid: ${String(lastError)}\nReturn Markdown only.`,
      signal: input.signal,
      cwdScope: input.cwdScope,
      extractionCount: input.extractions.length,
      getObservation: input.getObservation,
      model: input.model,
      onToolResults: (event) => {
        for (const result of event.toolResults) {
          if (typeof result.result === 'object' && result.result && 'content' in result.result) {
            validRefsForContent(result.result, validRefs);
          }
        }
        attemptToolResults.push(...event.toolResults);
      },
    });
    if (!raw) {
      throw new Error('observer llm is unavailable');
    }
    try {
      const document = parseObservationSubtree(raw, validRefs, input.cwdScope);
      await writeObservationTrace({
        ...trace,
        database,
        attempt,
        durationMs: Date.now() - startedAt,
        finalText: raw,
        document,
        toolResults: attemptToolResults,
      });
      return document;
    } catch (error) {
      lastError = error;
      await writeObservationTrace({
        ...trace,
        database,
        attempt,
        durationMs: Date.now() - startedAt,
        rawText: raw,
        validationError: String(error),
        toolResults: attemptToolResults,
      });
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function generateObservationText(params: {
  system: string;
  prompt: string;
  signal?: AbortSignal;
  cwdScope: string;
  extractionCount: number;
  getObservation?: (paths: string[]) => Promise<string> | string;
  model?: ToolModel;
  onToolResults?: (event: {
    toolCalls: LlmToolCall[];
    toolResults: Array<{
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      result: unknown;
    }>;
  }) => Promise<void> | void;
}): Promise<string | null> {
  try {
    if (!params.getObservation) {
      return await generateText('observer', {
        system: params.system,
        prompt: params.prompt,
        signal: params.signal,
      });
    }
    let getObservationCalls = 0;
    const maxGetObservationCalls = 3;
    return await runToolLoop({
      messages: [
        { role: 'system', content: params.system },
        { role: 'user', content: params.prompt },
      ],
      tools: [getObservationSpec()],
      toolHandlers: {
        get_observation: async (args) => {
          getObservationCalls += 1;
          if (getObservationCalls > maxGetObservationCalls) {
            const error = new Error(`get_observation exceeded max calls=${maxGetObservationCalls}`);
            (error as Error & { fatalToolError?: boolean }).fatalToolError = true;
            throw error;
          }
          const paths = Array.isArray(args.paths)
            ? args.paths.map((path) => typeof path === 'string' ? path.trim() : '').filter(Boolean)
            : [];
          if (paths.length === 0) {
            throw new Error('get_observation requires paths');
          }
          return { paths, content: await params.getObservation!(paths) };
        },
      },
      model: params.model ?? generateWithTools,
      signal: params.signal,
      onToolResults: params.onToolResults,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const wrapped = new Error(
      `observer llm request failed for cwd=${JSON.stringify(params.cwdScope)} extractionCount=${params.extractionCount}: ${message}`,
    );
    (wrapped as Error & { cause?: unknown }).cause = error;
    throw wrapped;
  }
}

function renderExtractions(extractions: ObservationExtractionInput[]): string {
  return extractions.map((extraction) => [
    `- ${extraction.id}`,
    extraction.status ? `  Status: ${extraction.status}` : '',
    extraction.cwd ? `  CWD: ${extraction.cwd}` : '',
    extraction.context?.trim() ? `  Context: ${extraction.context.trim()}` : '',
    `  Extraction: ${extraction.text.trim()}`,
    extraction.turnRefs && extraction.turnRefs.length > 0 ? `  Source refs: ${extraction.turnRefs.join(', ')}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');
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
  const maxSteps = params.maxSteps ?? 6;
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
      let toolResult: unknown;
      try {
        toolResult = await handler(call.arguments, call);
      } catch (error) {
        if (error instanceof Error && (error as Error & { fatalToolError?: boolean }).fatalToolError) {
          throw error;
        }
        toolResult = {
          error: error instanceof Error ? error.message : String(error),
        };
      }
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

function getObservationSpec(): LlmTool {
  return {
    name: 'get_observation',
    description: 'Get root-to-node paths and complete subtrees for observation paths visible in the outline.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Observation paths visible in the observation outline.',
        },
      },
      required: ['paths'],
    },
  };
}

function trimContent(content: string, maxChars: number): string {
  const value = content.trim();
  if (value.length <= maxChars) {
    return value;
  }
  const marker = '\n\n<!-- Existing content omitted to keep observer input bounded. -->\n\n';
  const headBudget = Math.min(Math.floor(maxChars * 0.25), 4_000);
  const tailBudget = Math.max(maxChars - headBudget - marker.length, 0);
  return `${value.slice(0, headBudget).trimEnd()}${marker}${value.slice(-tailBudget).trimStart()}`;
}

function extractRefs(content: string): string[] {
  return [...content.matchAll(/\[([^\]]+)\]/g)]
    .flatMap((match) => (match[1] ?? '').split(',').map((ref) => ref.trim()).filter(Boolean));
}

function validRefsForContent(value: unknown, refs: Set<string>): void {
  if (!value || typeof value !== 'object') {
    return;
  }
  const content = (value as { content?: unknown }).content;
  if (typeof content !== 'string') {
    return;
  }
  for (const ref of extractRefs(content)) {
    refs.add(ref);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Operation aborted', 'AbortError');
  }
}

async function writeObservationTrace(event: {
  database?: string;
  input: unknown;
  prompt: {
    system: string;
    user: string;
  };
  attempt: number;
  durationMs: number;
  finalText?: string;
  rawText?: string;
  validationError?: string;
  document?: ParsedObservationDocument;
  toolResults?: unknown[];
}): Promise<void> {
  const file = process.env.MUNINN_OBSERVER_TRACE_FILE
    ?? resolveDatabaseLogPath(event.database, 'observer-trace.jsonl');
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(event)}\n`, 'utf8');
}

export const __testing = {
  renderExtractions,
  trimContent,
  getObservationSpec,
};
