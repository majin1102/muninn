import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { Turn } from '../client.js';
import { getExtractorLlmConfig, resolveDatabaseLogPath, resolveDatabaseName } from '../config.js';
import type { Memories } from '../memories/memories.js';
import type {
  GatewayResult,
  ExtractSessionMemoryRequest,
  ExtractSessionMemoryResult,
  Extraction,
  SessionMemoryThreadGatewayInput,
  ContextRef,
} from '../extractor/types.js';
import {
  parseSnapshotContent,
  parseSnapshotPatch,
  renderExtractionBlock,
  renderSnapshotContent,
} from '../extractor/thread-memory.js';
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
const SNAPSHOT_VIEW_TOKEN_CAP = 10_000;
const MAX_GET_EXTRACTION_CALLS = 5;

type ToolModel = (
  task: LlmTask,
  request: LlmToolRequest,
) => Promise<LlmToolResult | null>;

type ExtractSessionMemoryDeps = {
  memories?: Pick<Memories, 'get'>;
  model?: ToolModel;
  database?: string;
};

export async function routeSessionMemoryThreads(
  sessionMemoryThreads: SessionMemoryThreadGatewayInput[],
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
      sessionMemoryThreads,
      gatewayTurns,
      buildMockGatewayResult(sessionMemoryThreads, gatewayTurns),
    );
  }

  const template = loadPromptTemplate('extracting_gateway');
  const inputJson = JSON.stringify(
    {
      sessionMemoryThreads: sessionMemoryThreads.map((thread) => ({
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
      return validateGatewayResult(sessionMemoryThreads, gatewayTurns, parsed);
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

export async function extractSessionMemory(
  input: ExtractSessionMemoryRequest,
  signal?: AbortSignal,
  deps: ExtractSessionMemoryDeps = {},
): Promise<ExtractSessionMemoryResult> {
  throwIfAborted(signal);
  const config = getExtractorLlmConfig();
  if (!config) {
    throw new Error('extraction update is not configured');
  }

  if (config.provider === 'mock') {
    return validateMockSessionMemoryResult(buildMockSnapshotContent(input), input);
  }

  const template = loadPromptTemplate('thread_extracting');
  const systemPrompt = template.system;
  const snapshotView = buildSnapshotView(input.sessionMemoryContent);
  const inputMarkdown = [
    snapshotView.markdown,
    '',
    renderNewTurns(input.turns),
  ].join('\n').trim();
  const basePrompt = renderPromptTemplate(template.userTemplate, { input_markdown: inputMarkdown });
  const trace = createExtractionTrace(input);
  const database = resolveDatabaseName(deps.database);

  let lastError = 'extraction update returned no output';
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    throwIfAborted(signal);
    let getExtractionCallCount = 0;
    const readExtractionSequences = new Set<number>();
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
      'Return only a valid Markdown snapshot patch using optional `# <Session Title>`, optional `## Summary`, optional `## Extractions`, refs metadata, and `### Title`/`### Summary`/`### Content` extraction blocks.',
          ),
        },
      ],
      tools: [getExtractionSpec()],
      toolHandlers: {
        get_extraction: (args) => {
          getExtractionCallCount += 1;
          if (getExtractionCallCount > MAX_GET_EXTRACTION_CALLS) {
            throw new Error(`get_extraction exceeded max calls: ${MAX_GET_EXTRACTION_CALLS}`);
          }
          for (const sequence of normalizeSequences(args.sequences)) {
            if (snapshotView.visibleSequences.has(sequence)) {
              readExtractionSequences.add(sequence);
            }
          }
          return createGetExtractionTool(input, snapshotView.visibleSequences)(args);
        },
      },
      model: deps.model ?? generateWithTools,
      signal,
      maxSteps: MAX_GET_EXTRACTION_CALLS + 1,
      onToolResults: (event) => {
        trace.toolCalls.push(...event.toolCalls);
        trace.toolResults.push(...event.toolResults);
      },
    });
    const durationMs = Date.now() - startedAt;
    if (!raw) {
      throw new Error('extraction update is not configured');
    }
    throwIfAborted(signal);

    try {
      const result = validateExtractSessionMemoryResult(raw, input, { readExtractionSequences });
      await writeExtractionTrace({
        ...trace,
        database,
        attempt,
        durationMs,
        finalText: raw,
        extractions: result.extractions,
      });
      return result;
    } catch (error) {
      lastError = String(error);
      await writeExtractionTrace({
        ...trace,
        database,
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
  sessionMemoryThreads: SessionMemoryThreadGatewayInput[],
  pendingTurns: Array<{ turnId: string; text: string }>,
): GatewayResult {
  const targetThread = sessionMemoryThreads.find((thread) => thread.kind === 'session') ?? sessionMemoryThreads[0];
  return {
    sessionFragments: targetThread
      ? pendingTurns.map((turn) => ({
          threadId: targetThread.threadId,
          turnIds: [turn.turnId],
          content: normalizeText(turn.text, MAX_SUMMARY_CHARS),
          reason: 'The turn is routed to the existing session memory thread for inspection.',
        }))
      : [],
  };
}

function buildMockSnapshotContent(input: ExtractSessionMemoryRequest): string {
  const joined = input.turns
    .map((turn) => normalizeText(renderSessionTurnText(turn), MAX_SUMMARY_CHARS))
    .filter(Boolean)
    .join(' ');
  const references = input.turns.map((turn) => turn.turnId).filter(Boolean);
  const extractions = [...input.sessionMemoryContent.extractions];
  if (joined && references.length > 0) {
    extractions.push({
      text: joined,
      title: normalizeText(joined, 80) || 'Mock extraction',
      context: null,
      references,
    });
  }
  if (extractions.length === 0) {
    extractions.push({
      text: input.sessionMemoryContent.title || 'Mock session memory thread',
      title: input.sessionMemoryContent.title || 'Mock session memory thread',
      context: null,
      references: [references[0] ?? 'session:mock'],
    });
  }
  return renderSnapshotContent(
    input.sessionMemoryContent.title || 'Mock session memory thread',
    input.sessionMemoryContent.summary || 'This thread tracks session conversation memory.',
    extractions,
  );
}

function isDefaultSummary(text: string): boolean {
  return text === 'Default session memory thread for this session.'
    || text === 'Default session thread for this session.'
    || /^Default session memory thread for session .+\.$/.test(text)
    || /^Default session thread for session .+\.$/.test(text);
}

function validateGatewayResult(
  sessionMemoryThreads: SessionMemoryThreadGatewayInput[],
  pendingTurns: Array<{ turnId: string; text: string }>,
  result: GatewayResult,
): GatewayResult {
  const validTurnIds = new Set(pendingTurns.map((turn) => turn.turnId));
  const validThreadIds = new Set(sessionMemoryThreads.map((thread) => thread.threadId));
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

function validateExtractSessionMemoryResult(
  result: string,
  input?: ExtractSessionMemoryRequest,
  options: { readExtractionSequences?: ReadonlySet<number> } = {},
): ExtractSessionMemoryResult {
  const contextRefs = extractionContextRefs(input);
  const validNewReferences = validSessionMemoryReferences(input);
  const current = input?.sessionMemoryContent.extractions ?? [];
  const currentSummary = input?.sessionMemoryContent.summary ?? '';
  const currentTitle = input?.sessionMemoryContent.title ?? '';
  const patch = parseSnapshotPatch(result, validNewReferences);
  validateUpdatedSequencesWereRead(patch, options.readExtractionSequences);
  const nextExtractions = mergePatchExtractions(current, patch, validNewReferences);
  const summary = patch.summary ?? currentSummary;
  const title = patch.title ?? currentTitle;
  const snapshotContent = renderSnapshotContent(
    title || 'Session memory snapshot',
    summary || 'This session has no durable memory summary yet.',
    nextExtractions,
  );
  const parsed = parseSnapshotContent(
    snapshotContent,
    new Set(nextExtractions.flatMap((extraction) => extraction.references)),
  );

  return {
    title: parsed.title,
    summary: parsed.summary,
    snapshotContent: parsed.snapshotContent,
    extractions: parsed.extractions,
    openQuestions: input?.sessionMemoryContent.openQuestions ?? [],
    nextSteps: input?.sessionMemoryContent.nextSteps ?? [],
    contextRefs,
  };
}

function validateUpdatedSequencesWereRead(
  patch: ReturnType<typeof parseSnapshotPatch>,
  readExtractionSequences?: ReadonlySet<number>,
): void {
  if (!readExtractionSequences) {
    return;
  }
  for (const update of patch.updates) {
    if (!readExtractionSequences.has(update.sequence)) {
      throw new Error(`sequence ${update.sequence} must be read with get_extraction before it can be updated`);
    }
  }
}

function validateMockSessionMemoryResult(result: string, input: ExtractSessionMemoryRequest): ExtractSessionMemoryResult {
  const references = new Set([
    ...input.turns.map((turn) => turn.turnId).filter(Boolean),
    ...input.sessionMemoryContent.extractions.flatMap((extraction) => extraction.references ?? []),
  ]);
  const parsed = parseSnapshotContent(result, references);
  return {
    title: input.sessionMemoryContent.title || parsed.title,
    summary: parsed.summary,
    snapshotContent: parsed.snapshotContent,
    extractions: parsed.extractions,
    openQuestions: input.sessionMemoryContent.openQuestions,
    nextSteps: input.sessionMemoryContent.nextSteps,
    contextRefs: extractionContextRefs(input),
  };
}

function extractionContextRefs(input?: ExtractSessionMemoryRequest): ContextRef[] {
  return input?.turns
    .map((turn) => ({
      turnId: turn.turnId,
      summary: normalizeText(renderSessionTurnText(turn), MAX_SUMMARY_CHARS),
    }))
    .filter((reference) => reference.turnId && reference.summary) ?? [];
}

function validSessionMemoryReferences(input: ExtractSessionMemoryRequest | undefined): Set<string> {
  return new Set(input?.turns.map((turn) => turn.turnId).filter(Boolean) ?? []);
}

function mergePatchExtractions(
  current: Extraction[],
  patch: ReturnType<typeof parseSnapshotPatch>,
  validNewReferences: Set<string>,
): Extraction[] {
  const next = current.map((extraction) => ({
      ...extraction,
      title: extraction.title ?? extraction.text,
      references: [...(extraction.references ?? [])],
  }));
  const seenSequences = new Set<number>();

  for (const update of patch.updates) {
    const existing = next[update.sequence];
    if (!existing) {
      throw new Error(`snapshot patch referenced unknown sequence: ${update.sequence}`);
    }
    if (seenSequences.has(update.sequence)) {
      throw new Error(`snapshot patch updated sequence more than once: ${update.sequence}`);
    }
    seenSequences.add(update.sequence);
    next[update.sequence] = {
      ...existing,
      title: update.title,
      text: update.summary,
      context: update.content ?? null,
      references: mergeReferences(existing.references ?? [], update.refs),
    };
  }

  for (const addition of patch.additions) {
    if (addition.refs.some((ref) => !validNewReferences.has(ref))) {
      throw new Error('snapshot patch new extraction referenced unknown new turn');
    }
    next.push({
      title: addition.title,
      text: addition.summary,
      context: addition.content ?? null,
      references: addition.refs,
    });
  }

  return next;
}

function mergeReferences(current: string[], additions: string[]): string[] {
  const refs = [...current];
  for (const ref of additions) {
    if (!refs.includes(ref)) {
      refs.push(ref);
    }
  }
  return refs;
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

function buildSnapshotView(content: ExtractSessionMemoryRequest['sessionMemoryContent']): {
  markdown: string;
  visibleSequences: Set<number>;
} {
  const rawTitle = normalizeText(content.title ?? '');
  const rawSummary = normalizeText(content.summary ?? '');
  const title = isGeneratedSnapshotTitle(rawTitle, rawSummary) ? '' : rawTitle;
  const summary = isDefaultSummary(rawSummary)
    ? ''
    : rawSummary;
  const extractionEntries = content.extractions.map((extraction, sequence) => ({
    sequence,
    markdown: [
      `<!-- sequence: ${sequence} -->`,
      '### Title',
      normalizeText(extraction.title ?? extraction.text, 80),
      '',
      '### Summary',
      extraction.text.trim(),
    ].join('\n'),
  }));

  let visibleEntries = [...extractionEntries];
  let markdown = renderSnapshotViewMarkdown(title, summary, visibleEntries);
  while (estimateTokens(markdown) > SNAPSHOT_VIEW_TOKEN_CAP && visibleEntries.length > 0) {
    visibleEntries = visibleEntries.slice(1);
    markdown = renderSnapshotViewMarkdown(title, summary, visibleEntries);
  }

  return {
    markdown,
    visibleSequences: new Set(visibleEntries.map((entry) => entry.sequence)),
  };
}

function renderSnapshotViewMarkdown(
  title: string,
  summary: string,
  entries: Array<{ sequence: number; markdown: string }>,
): string {
  return [
    '## Current Snapshot',
    '',
    `# ${title || '(empty)'}`,
    '',
    '### Summary',
    summary || '(empty)',
    '',
    '### Extractions',
    entries.length > 0 ? entries.map((entry) => entry.markdown).join('\n\n----\n\n') : '(empty)',
  ].join('\n');
}

function isGeneratedSnapshotTitle(title: string, summary: string): boolean {
  if (!title) {
    return false;
  }
  if (
    title === 'Session memory thread'
    || title === 'Session memory snapshot'
    || title === 'Session observing thread'
  ) {
    return true;
  }
  return /^Session\s+\S+/.test(title) && isDefaultSummary(summary);
}

function renderNewTurns(turns: ExtractSessionMemoryRequest['turns']): string {
  return [
    '## Current Batch Turns',
    turns.map((turn) => [
      `### ${turn.turnId}`,
      labeledText('Prompt', turn.prompt),
      labeledText('Response', turn.response),
    ].filter(Boolean).join('\n\n')).join('\n\n') || '(empty)',
  ].join('\n');
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function getExtractionSpec(): LlmTool {
  return {
    name: 'get_extraction',
    description: 'Get full extraction details by visible sequence when the compressed summary is not enough to safely update a memory unit.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sequences: {
          type: 'array',
          items: { type: 'number' },
          description: 'Visible extraction sequence numbers from the current snapshot.',
        },
      },
      required: ['sequences'],
    },
  };
}

function createGetExtractionTool(input: ExtractSessionMemoryRequest, visibleSequences: Set<number>) {
  return (args: Record<string, unknown>) => {
    const sequences = normalizeSequences(args.sequences);
    const results = [];
    for (const sequence of sequences) {
      if (!visibleSequences.has(sequence)) {
        results.push({ sequence, error: 'sequence is not visible' });
        continue;
      }
      const extraction = input.sessionMemoryContent.extractions[sequence];
      if (!extraction) {
        results.push({ sequence, error: 'extraction not found' });
        continue;
      }
      results.push({
        sequence,
        content: renderExtractionBlock(extraction, { sequence, includeRefs: false }),
      });
    }
    return { extractions: results };
  };
}

function normalizeSequences(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((sequence) => (typeof sequence === 'number' ? sequence : Number(sequence)))
    .filter((sequence) => Number.isInteger(sequence) && sequence >= 0)
    .filter((sequence, index, values) => values.indexOf(sequence) === index);
}

function createExtractionTrace(input: ExtractSessionMemoryRequest) {
  return {
    input: {
      sessionMemoryContent: input.sessionMemoryContent,
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

function renderSessionTurnText(turn: { prompt?: string | null; response?: string | null; summary?: string | null }): string {
  const parts = [
    labeledText('Prompt', turn.prompt),
    labeledText('Response', turn.response),
  ].filter(Boolean);
  return parts.join('\n\n');
}

async function writeExtractionTrace(event: {
  database?: string;
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
  const file = process.env.MUNINN_SESSION_MEMORY_TRACE_FILE
    ?? resolveDatabaseLogPath(event.database, 'extractor-trace.jsonl');
  await mkdir(path.dirname(file), { recursive: true });
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
  renderNewTurnsForTests: renderNewTurns,
  validateGatewayResultForTests: validateGatewayResult,
  validateExtractSessionMemoryResultForTests: validateExtractSessionMemoryResult,
};
