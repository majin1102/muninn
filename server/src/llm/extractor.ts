import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { getExtractorLlmConfig, resolveDatabaseLogPath, resolveDatabaseName } from '../config.js';
import type { Memories } from '../api/memory.js';
import type {
  SessionExtractionInput,
  SessionExtractionResult,
  ExtractionUnit,
  ContextRef,
  SnapshotSignals,
} from '../pipeline/session.js';
import {
  parseSnapshotContent,
  parseSnapshotPatch,
  renderExtractionBlock,
  renderSnapshotContent,
  isValidSkillName,
  skillNamesFromSignals,
  signalEvidenceLabels,
} from '../pipeline/session.js';
import {
  generateWithTools,
  type LlmTask,
  type LlmTool,
  type LlmToolCall,
  type LlmToolMessage,
  type LlmToolRequest,
  type LlmToolResult,
} from './provider.js';
import { loadPromptTemplate, renderPromptTemplate } from './prompts.js';
import {
  previewPolicy,
  renderCurrentBatchTurns,
  type RenderedBatchTurns,
} from './extraction-input.js';

const MAX_SUMMARY_CHARS = 220;
const PROTECTED_SNAPSHOT_EXTRACTION_SUMMARIES = 16;
const MAX_GET_EXTRACTION_CALLS = 2;
const MAX_GET_SKILL_CALLS_PER_NAME = 1;
const MAX_GET_TURN_CALLS = 3;
const MAX_GET_TURN_CHARS_PER_CALL = 16_384;
const MAX_GET_TURN_CHARS_TOTAL = 32_768;

type ToolModel = (
  task: LlmTask,
  request: LlmToolRequest,
) => Promise<LlmToolResult | null>;

type SessionExtractionDeps = {
  memories?: Pick<Memories, 'get'>;
  model?: ToolModel;
  database?: string;
};

function labeledText(label: string, value?: string | null): string | null {
  const text = value?.trim();
  return text ? `${label}:\n${text}` : null;
}

export async function extractSessionMemory(
  input: SessionExtractionInput,
  signal?: AbortSignal,
  deps: SessionExtractionDeps = {},
): Promise<SessionExtractionResult> {
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
  const snapshotView = buildSnapshotView(input.sessionMemory, config.snapshotInputChars);
  const renderedTurns = renderNewTurns(input.turns, {
    previewChars: config.previewChars,
    stoppedBy: input.inputBudgetStoppedBy,
  });
  const inputMarkdown = [
    snapshotView.markdown,
    '',
    renderedTurns.markdown,
  ].join('\n').trim();
  const basePrompt = renderPromptTemplate(template.userTemplate, { input_markdown: inputMarkdown });
  const trace = createExtractionTrace(input, {
    config,
    systemPromptChars: systemPrompt.length,
    snapshotView,
    renderedTurns,
    userPromptRenderedChars: basePrompt.length,
  });
  const database = resolveDatabaseName(deps.database);

  let lastError = 'extraction update returned no output';
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    throwIfAborted(signal);
    let getExtractionCallCount = 0;
    let getTurnCallCount = 0;
    let getTurnReturnedChars = 0;
    const readExtractionSequences = new Set<number>();
    const requestedExtractionSequences = new Set<number>();
    const readSkillNames = new Set<string>();
    const startedAt = Date.now();
    let raw: string;
    try {
      raw = await runToolLoop({
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: buildRetryPrompt(
              basePrompt,
              attempt,
              lastError,
              'Return only a valid Markdown snapshot patch using optional `# <Session Title>`, optional `## Summary`, optional `## Instruction Signals`, optional `## Skill Signals`, optional `## Skill Details`, optional `## Extractions`, refs metadata, and `### Title`/`### Summary`/`### Content` extraction blocks. Before outputting any existing `sequence: N` extraction update, call `get_extraction({ sequences: [N] })` in this attempt. Call `get_extraction` at most twice per attempt; batch all needed visible sequences into as few calls as possible, and never request a sequence that was already requested earlier in the same attempt.',
            ),
          },
        ],
        tools: [getExtractionSpec(), getSkillSpec(), getTurnSpec()],
        toolHandlers: {
          get_extraction: (args) => {
            const sequences = normalizeSequences(args.sequences);
            const alreadyRequested = sequences.filter((sequence) => requestedExtractionSequences.has(sequence));
            if (alreadyRequested.length > 0) {
              return {
                error: `get_extraction sequences already requested in this attempt: ${alreadyRequested.join(', ')}`,
                alreadyRequested,
              };
            }
            if (getExtractionCallCount >= MAX_GET_EXTRACTION_CALLS) {
              return {
                error: `get_extraction exceeded max calls: ${MAX_GET_EXTRACTION_CALLS}`,
                maxCalls: MAX_GET_EXTRACTION_CALLS,
              };
            }
            getExtractionCallCount += 1;
            for (const sequence of sequences) {
              requestedExtractionSequences.add(sequence);
              if (snapshotView.visibleSequences.has(sequence)) {
                readExtractionSequences.add(sequence);
              }
            }
            return createGetExtractionTool(input, snapshotView.visibleSequences)(args);
          },
          get_skill: (args) => {
            const skillName = normalizeSkillNameArg(args.skillName);
            if (!skillName) {
              return { error: 'skillName is required' };
            }
            if (MAX_GET_SKILL_CALLS_PER_NAME === 1 && readSkillNames.has(skillName)) {
              return { skillName, error: 'skill already read' };
            }
            const result = createGetSkillTool(input)(args);
            if (isGetSkillSuccess(result)) {
              readSkillNames.add(skillName);
            }
            return result;
          },
          get_turn: (args) => {
            getTurnCallCount += 1;
            const result = createGetTurnTool(input, {
              callCount: getTurnCallCount,
              returnedChars: getTurnReturnedChars,
              maxCalls: MAX_GET_TURN_CALLS,
              maxCharsPerCall: MAX_GET_TURN_CHARS_PER_CALL,
              maxCharsTotal: MAX_GET_TURN_CHARS_TOTAL,
            })(args);
            getTurnReturnedChars += getTurnToolReturnedChars(result);
            trace.getTurnResults.push(result);
            return result.publicResult;
          },
        },
        model: deps.model ?? generateWithTools,
        signal,
        maxSteps: MAX_GET_EXTRACTION_CALLS + MAX_GET_TURN_CALLS + (input.sessionMemory.skillSignals?.length ?? 0) + 2,
        onToolResults: (event) => {
          trace.toolCalls.push(...event.toolCalls);
          trace.toolResults.push(...event.toolResults);
        },
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      lastError = String(error);
      const durationMs = Date.now() - startedAt;
      await writeExtractionTrace({
        ...trace,
        database,
        attempt,
        durationMs,
        readSkillNames: [...readSkillNames],
        validationError: lastError,
        extractions: [],
      });
      continue;
    }
    const durationMs = Date.now() - startedAt;
    if (!raw.trim()) {
      lastError = 'extraction update returned no output';
      await writeExtractionTrace({
        ...trace,
        database,
        attempt,
        durationMs,
        readSkillNames: [...readSkillNames],
        rawText: raw,
        validationError: lastError,
        extractions: [],
      });
      continue;
    }
    throwIfAborted(signal);

    try {
      const result = validateSessionExtractionResult(raw, input, { readExtractionSequences });
      await writeExtractionTrace({
        ...trace,
        database,
        attempt,
        durationMs,
        readSkillNames: [...readSkillNames],
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
        readSkillNames: [...readSkillNames],
        rawText: raw,
        validationError: lastError,
        extractions: [],
      });
    }
  }

  throw new Error(`extraction update returned invalid output: ${lastError}`);
}

function buildMockSnapshotContent(input: SessionExtractionInput): string {
  const joined = input.turns
    .map((turn) => normalizeText(renderSessionTurnText(turn), MAX_SUMMARY_CHARS))
    .filter(Boolean)
    .join(' ');
  const references = input.turns.map((turn) => turn.turnId).filter(Boolean);
  const extractions = [...input.sessionMemory.extractions];
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
      text: input.sessionMemory.title || 'Mock session memory thread',
      title: input.sessionMemory.title || 'Mock session memory thread',
      context: null,
      references: [references[0] ?? 'session:mock'],
    });
  }
  return renderSnapshotContent(
    input.sessionMemory.title || 'Mock session memory thread',
    input.sessionMemory.summary || 'This thread tracks session conversation memory.',
    snapshotSignals(input.sessionMemory),
    extractions,
  );
}

function isDefaultSummary(text: string): boolean {
  return text === 'Default session memory thread for this session.'
    || text === 'Default session thread for this session.'
    || /^Default session memory thread for session .+\.$/.test(text)
    || /^Default session thread for session .+\.$/.test(text);
}

function snapshotSignals(content?: Partial<SessionExtractionInput['sessionMemory']>): SnapshotSignals {
  return {
    memorySignals: [...(content?.memorySignals ?? [])],
    skillSignals: [...(content?.skillSignals ?? [])],
    skillDetails: { ...(content?.skillDetails ?? {}) },
  };
}

function applySignalPatch(
  current: SnapshotSignals,
  patch: ReturnType<typeof parseSnapshotPatch>,
): SnapshotSignals {
  const skillSignals = patch.skillSignals ?? current.skillSignals;
  const currentSkillNames = skillNamesFromSignals(skillSignals);
  for (const name of Object.keys(patch.skillDetails ?? {})) {
    if (!currentSkillNames.has(name)) {
      throw new Error(`snapshot patch ## Skill Details key lacks matching ## Skill Signals card: ${name}`);
    }
  }
  const skillDetails = { ...current.skillDetails, ...(patch.skillDetails ?? {}) };
  for (const name of patch.skillDetailsDeletes ?? []) {
    delete skillDetails[name];
  }
  for (const name of Object.keys(skillDetails)) {
    if (!currentSkillNames.has(name)) {
      delete skillDetails[name];
    }
  }
  return {
    memorySignals: patch.memorySignals ?? current.memorySignals,
    skillSignals,
    skillDetails,
  };
}

function validateSessionExtractionResult(
  result: string,
  input?: SessionExtractionInput,
  options: { readExtractionSequences?: ReadonlySet<number> } = {},
): SessionExtractionResult {
  const contextRefs = extractionContextRefs(input);
  const validNewReferences = validSessionMemoryReferences(input);
  const current = input?.sessionMemory.extractions ?? [];
  const currentSummary = input?.sessionMemory.summary ?? '';
  const currentSignals = snapshotSignals(input?.sessionMemory);
  const currentTitle = input?.sessionMemory.title ?? '';
  const validExistingSignalLabels = new Set([
    ...signalEvidenceLabels(currentSignals.memorySignals),
    ...signalEvidenceLabels(currentSignals.skillSignals),
  ]);
  const patch = parseSnapshotPatch(result, validNewReferences, validExistingSignalLabels);
  validateUpdatedSequencesWereRead(patch, options.readExtractionSequences);
  const nextExtractions = mergePatchExtractions(current, patch, validNewReferences);
  const summary = resolveSnapshotSummary(patch.summary, currentSummary);
  const signals = applySignalPatch(currentSignals, patch);
  const title = resolveSnapshotTitle(patch.title, currentTitle, currentSummary, summary, input);
  const snapshotContent = renderSnapshotContent(
    title || 'Session memory snapshot',
    summary || 'This session has no durable memory summary yet.',
    signals,
    nextExtractions,
  );
  const parsed = parseSnapshotContent(
    snapshotContent,
    new Set(nextExtractions.flatMap((extraction) => extraction.references)),
  );

  return {
    title: parsed.title,
    summary: parsed.summary,
    memorySignals: parsed.memorySignals,
    skillSignals: parsed.skillSignals,
    skillDetails: parsed.skillDetails,
    snapshotContent: parsed.snapshotContent,
    extractions: parsed.extractions,
    nextSteps: input?.sessionMemory.nextSteps ?? [],
    contextRefs,
  };
}

function resolveSnapshotTitle(
  patchTitle: string | undefined,
  currentTitle: string,
  currentSummary: string,
  nextSummary: string,
  input: SessionExtractionInput | undefined,
): string {
  const patchCandidate = normalizeText(patchTitle ?? '');
  if (isUsableSessionTitle(patchCandidate, nextSummary)) {
    return patchCandidate;
  }

  const currentCandidate = normalizeText(currentTitle);
  if (isUsableSessionTitle(currentCandidate, currentSummary)) {
    return currentCandidate;
  }

  return normalizeText(firstPrompt(input), 80);
}

function resolveSnapshotSummary(patchSummary: string | undefined, currentSummary: string): string {
  const patchCandidate = normalizeText(patchSummary ?? '');
  if (patchSummary !== undefined) {
    return isEmptyMarker(patchCandidate) ? '' : patchCandidate;
  }

  const currentCandidate = normalizeText(currentSummary);
  return isDefaultSummary(currentCandidate) || isEmptyMarker(currentCandidate)
    ? ''
    : currentCandidate;
}

function isUsableSessionTitle(title: string, summary: string): boolean {
  return Boolean(title)
    && !isEmptyMarker(title)
    && !isGeneratedSnapshotTitle(title, summary);
}

function isEmptyMarker(text: string): boolean {
  return text.toLowerCase() === '(empty)';
}

function firstPrompt(input: SessionExtractionInput | undefined): string {
  return input?.turns.find((turn) => normalizeText(turn.prompt ?? ''))?.prompt ?? '';
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

function validateMockSessionMemoryResult(result: string, input: SessionExtractionInput): SessionExtractionResult {
  const references = new Set([
    ...input.turns.map((turn) => turn.turnId).filter(Boolean),
    ...input.sessionMemory.extractions.flatMap((extraction) => extraction.references ?? []),
  ]);
  const parsed = parseSnapshotContent(result, references);
  return {
    title: input.sessionMemory.title || parsed.title,
    summary: parsed.summary,
    memorySignals: parsed.memorySignals,
    skillSignals: parsed.skillSignals,
    skillDetails: parsed.skillDetails,
    snapshotContent: parsed.snapshotContent,
    extractions: parsed.extractions,
    nextSteps: input.sessionMemory.nextSteps,
    contextRefs: extractionContextRefs(input),
  };
}

function extractionContextRefs(input?: SessionExtractionInput): ContextRef[] {
  return input?.turns
    .map((turn) => ({
      turnId: turn.turnId,
      summary: normalizeText(renderSessionTurnText(turn), MAX_SUMMARY_CHARS),
    }))
    .filter((reference) => reference.turnId && reference.summary) ?? [];
}

function validSessionMemoryReferences(input: SessionExtractionInput | undefined): Set<string> {
  return new Set(input?.turns.map((turn) => turn.turnId).filter(Boolean) ?? []);
}

function mergePatchExtractions(
  current: ExtractionUnit[],
  patch: ReturnType<typeof parseSnapshotPatch>,
  validNewReferences: Set<string>,
): ExtractionUnit[] {
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

function buildSnapshotView(content: SessionExtractionInput['sessionMemory'], snapshotInputChars: number): {
  markdown: string;
  visibleSequences: Set<number>;
  snapshotCharsOriginal: number;
  snapshotCharsRendered: number;
  snapshotStoppedBy: 'none' | 'snapshot-input-chars' | 'snapshot-protected-oversize';
  snapshotProtectedExtractionSummaries: number;
} {
  const rawTitle = normalizeText(content.title ?? '');
  const rawSummary = normalizeText(content.summary ?? '');
  const rawSignals = snapshotSignals(content);
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

  const fullMarkdown = renderSnapshotViewMarkdown(title, summary, rawSignals, extractionEntries);
  if (fullMarkdown.length <= snapshotInputChars) {
    return {
      markdown: fullMarkdown,
      visibleSequences: new Set(extractionEntries.map((entry) => entry.sequence)),
      snapshotCharsOriginal: fullMarkdown.length,
      snapshotCharsRendered: fullMarkdown.length,
      snapshotStoppedBy: 'none',
      snapshotProtectedExtractionSummaries: Math.min(PROTECTED_SNAPSHOT_EXTRACTION_SUMMARIES, extractionEntries.length),
    };
  }

  const protectedEntries = extractionEntries.slice(-PROTECTED_SNAPSHOT_EXTRACTION_SUMMARIES);
  let visibleEntries = [...protectedEntries];
  let markdown = renderSnapshotViewMarkdown(title, summary, rawSignals, visibleEntries);
  if (markdown.length <= snapshotInputChars) {
    const olderEntries = extractionEntries.slice(0, Math.max(0, extractionEntries.length - protectedEntries.length));
    for (let index = olderEntries.length - 1; index >= 0; index -= 1) {
      const candidate = [olderEntries[index], ...visibleEntries].sort((left, right) => left.sequence - right.sequence);
      const candidateMarkdown = renderSnapshotViewMarkdown(title, summary, rawSignals, candidate);
      if (candidateMarkdown.length > snapshotInputChars) {
        break;
      }
      visibleEntries = candidate;
      markdown = candidateMarkdown;
    }
  }

  return {
    markdown,
    visibleSequences: new Set(visibleEntries.map((entry) => entry.sequence)),
    snapshotCharsOriginal: fullMarkdown.length,
    snapshotCharsRendered: markdown.length,
    snapshotStoppedBy: markdown.length > snapshotInputChars
      ? 'snapshot-protected-oversize'
      : 'snapshot-input-chars',
    snapshotProtectedExtractionSummaries: Math.min(PROTECTED_SNAPSHOT_EXTRACTION_SUMMARIES, extractionEntries.length),
  };
}

function renderSnapshotViewMarkdown(
  title: string,
  summary: string,
  signals: SnapshotSignals,
  entries: Array<{ sequence: number; markdown: string }>,
): string {
  return [
    '## Current Snapshot',
    '',
    `# ${title || '(empty)'}`,
    '',
    '## Summary',
    summary || '(empty)',
    '',
    '## Instruction Signals',
    renderSignalList(signals.memorySignals),
    '',
    '## Skill Signals',
    renderSignalList(signals.skillSignals),
    '',
    '## Extractions',
    entries.length > 0 ? entries.map((entry) => entry.markdown).join('\n\n----\n\n') : '(empty)',
  ].join('\n');
}

function renderSignalList(signals: string[]): string {
  return signals.map((signal) => signal.trim()).filter(Boolean).join('\n') || '(empty)';
}

function isGeneratedSnapshotTitle(title: string, summary: string): boolean {
  if (!title) {
    return false;
  }
  if (
    title === 'Session memory thread'
    || title === 'Session memory snapshot'
  ) {
    return true;
  }
  return /^Session\s+\S+/.test(title) && isDefaultSummary(summary);
}

function renderNewTurns(
  turns: SessionExtractionInput['turns'],
  options: { previewChars: number; stoppedBy?: RenderedBatchTurns['stoppedBy'] } = { previewChars: 800 },
): RenderedBatchTurns {
  return renderCurrentBatchTurns(turns, options);
}

function getExtractionSpec(): LlmTool {
  return {
    name: 'get_extraction',
    description: 'Get full extraction details by visible sequence when the compressed summary is not enough to safely update a context unit. Call at most twice per attempt and do not request the same sequence twice.',
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

function getSkillSpec(): LlmTool {
  return {
    name: 'get_skill',
    description: 'Get hidden detail for an existing Skill Signal by skill name when deciding whether to update, merge, rename, or remove that skill.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        skillName: {
          type: 'string',
          description: 'Existing Skill Signal name from the current snapshot.',
        },
      },
      required: ['skillName'],
    },
  };
}

function getTurnSpec(): LlmTool {
  return {
    name: 'get_turn',
    description: 'Get bounded prompt and response text for a target conversation turn.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        turnId: {
          type: 'string',
          description: 'Exact current-batch turn id shown in the Current Batch Turns heading.',
        },
      },
      required: ['turnId'],
    },
  };
}

function createGetExtractionTool(input: SessionExtractionInput, visibleSequences: Set<number>) {
  return (args: Record<string, unknown>) => {
    const sequences = normalizeSequences(args.sequences);
    const results = [];
    for (const sequence of sequences) {
      if (!visibleSequences.has(sequence)) {
        results.push({ sequence, error: 'sequence is not visible' });
        continue;
      }
      const extraction = input.sessionMemory.extractions[sequence];
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

type GetTurnToolResult = {
  publicResult: unknown;
  turnId?: string;
  returnedPromptChars: number;
  returnedResponseChars: number;
  omittedPromptChars: number;
  omittedResponseChars: number;
  reason?: string;
  error?: string;
};

function createGetTurnTool(
  input: SessionExtractionInput,
  budget: {
    callCount: number;
    returnedChars: number;
    maxCalls: number;
    maxCharsPerCall: number;
    maxCharsTotal: number;
  },
) {
  const turnsById = new Map(input.turns.map((turn) => [turn.turnId, turn]));
  return (args: Record<string, unknown>): GetTurnToolResult => {
    const turnId = typeof args.turnId === 'string' ? args.turnId.trim() : '';
    if (!turnId) {
      return getTurnError('', 'turnId is required');
    }
    if (budget.callCount > budget.maxCalls) {
      return getTurnError(turnId, `get_turn exceeded max calls: ${budget.maxCalls}`);
    }
    const remainingTotal = budget.maxCharsTotal - budget.returnedChars;
    if (remainingTotal <= 0) {
      return getTurnError(turnId, `get_turn exceeded total returned chars: ${budget.maxCharsTotal}`);
    }
    const turn = turnsById.get(turnId);
    if (!turn) {
      return getTurnError(turnId, 'turn is not in the current extraction request');
    }
    const maxChars = Math.min(budget.maxCharsPerCall, remainingTotal);
    const prompt = turn.prompt?.trim() ?? '';
    const response = turn.response?.trim() ?? '';
    const rendered = renderGetTurnPayload(turnId, prompt, response, maxChars);
    return {
      publicResult: {
        turnId,
        prompt: rendered.prompt,
        response: rendered.response,
      },
      turnId,
      returnedPromptChars: rendered.prompt.length,
      returnedResponseChars: rendered.response.length,
      omittedPromptChars: rendered.omittedPromptChars,
      omittedResponseChars: rendered.omittedResponseChars,
      reason: rendered.reason,
    };
  };
}

function getTurnError(turnId: string, error: string): GetTurnToolResult {
  return {
    publicResult: turnId ? { turnId, error } : { error },
    turnId: turnId || undefined,
    returnedPromptChars: 0,
    returnedResponseChars: 0,
    omittedPromptChars: 0,
    omittedResponseChars: 0,
    error,
  };
}

function renderGetTurnPayload(
  turnId: string,
  prompt: string,
  response: string,
  maxChars: number,
): {
  prompt: string;
  response: string;
  omittedPromptChars: number;
  omittedResponseChars: number;
  reason: string;
} {
  if (prompt.length > maxChars) {
    return {
      prompt: foldToolText(
        prompt,
        maxChars,
        `[prompt middle omitted; omittedChars=${prompt.length - maxChars}; full content remains stored in turn table]`,
      ),
      response: '',
      omittedPromptChars: prompt.length - maxChars,
      omittedResponseChars: response.length,
      reason: 'prompt-over-budget',
    };
  }
  const remainingForResponse = Math.max(0, maxChars - prompt.length);
  if (response.length > remainingForResponse) {
    return {
      prompt,
      response: foldToolText(
        response,
        remainingForResponse,
        `[response middle omitted; omittedChars=${response.length - remainingForResponse}; full content remains stored in turn table]`,
      ),
      omittedPromptChars: 0,
      omittedResponseChars: response.length - remainingForResponse,
      reason: 'response-over-budget',
    };
  }
  return {
    prompt,
    response,
    omittedPromptChars: 0,
    omittedResponseChars: 0,
    reason: 'full',
  };
}

function foldToolText(text: string, maxChars: number, marker: string): string {
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 0) {
    return '';
  }
  const available = maxChars - marker.length - 2;
  if (available <= 0) {
    return marker.slice(0, maxChars);
  }
  const headChars = Math.ceil(available * 0.6);
  const tailChars = Math.max(0, available - headChars);
  return [
    text.slice(0, headChars),
    marker,
    tailChars > 0 ? text.slice(text.length - tailChars) : '',
  ].filter(Boolean).join('\n');
}

function getTurnToolReturnedChars(result: GetTurnToolResult): number {
  return result.returnedPromptChars + result.returnedResponseChars;
}

function createGetSkillTool(input: SessionExtractionInput) {
  const skillNames = skillNamesFromSignals(input.sessionMemory.skillSignals ?? []);
  return (args: Record<string, unknown>) => {
    const skillName = normalizeSkillNameArg(args.skillName);
    if (!skillName) {
      return { error: 'skillName is required' };
    }
    if (!skillNames.has(skillName)) {
      return { skillName, error: 'skill signal not found' };
    }
    return {
      skillName,
      content: input.sessionMemory.skillDetails?.[skillName] ?? '',
    };
  };
}

function isGetSkillSuccess(result: unknown): boolean {
  return typeof result === 'object'
    && result !== null
    && !Object.prototype.hasOwnProperty.call(result, 'error');
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

function normalizeSkillNameArg(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const skillName = value.trim();
  return isValidSkillName(skillName) ? skillName : '';
}

function createExtractionTrace(
  input: SessionExtractionInput,
  params: {
    config: {
      newBatchInputChars: number;
      snapshotInputChars: number;
      previewChars: number;
    };
    systemPromptChars: number;
    snapshotView: ReturnType<typeof buildSnapshotView>;
    renderedTurns: RenderedBatchTurns;
    userPromptRenderedChars: number;
  },
) {
  const promptCharsOriginal = input.turns.reduce((sum, turn) => sum + (turn.prompt?.trim().length ?? 0), 0);
  const responseCharsOriginal = input.turns.reduce((sum, turn) => sum + (turn.response?.trim().length ?? 0), 0);
  const promptCharsRendered = params.renderedTurns.turns.reduce((sum, turn) => sum + turn.promptCharsRendered, 0);
  const responseCharsRendered = params.renderedTurns.turns.reduce((sum, turn) => sum + turn.responseCharsRendered, 0);
  const omittedPromptPlanChars = params.renderedTurns.turns.reduce((sum, turn) => sum + turn.omittedPromptPlanChars, 0);
  const omittedResponseCompressedChars = params.renderedTurns.turns.reduce((sum, turn) => sum + turn.omittedResponseCompressedChars, 0);
  const omittedResponseChars = params.renderedTurns.turns.reduce((sum, turn) => sum + turn.omittedResponseChars, 0);
  return {
    input: {
      sessionMemory: input.sessionMemory,
      turns: input.turns,
    },
    inputBudget: {
      newBatchInputChars: params.config.newBatchInputChars,
      snapshotInputChars: params.config.snapshotInputChars,
      systemPromptChars: params.systemPromptChars,
      newBatchRenderedChars: params.renderedTurns.renderedChars,
      snapshotRenderedChars: params.snapshotView.snapshotCharsRendered,
      userPromptRenderedChars: params.userPromptRenderedChars,
      userPromptOverheadChars: params.userPromptRenderedChars
        - params.snapshotView.snapshotCharsRendered
        - params.renderedTurns.renderedChars,
      initialRequestChars: params.systemPromptChars + params.userPromptRenderedChars,
      candidateTurns: input.candidateTurnCount ?? input.turns.length,
      includedTurns: input.turns.length,
      deferredTurns: input.deferredTurnCount ?? 0,
      stoppedBy: input.inputBudgetStoppedBy ?? params.renderedTurns.stoppedBy,
      snapshotStoppedBy: params.snapshotView.snapshotStoppedBy,
      snapshotProtectedExtractionSummaries: params.snapshotView.snapshotProtectedExtractionSummaries,
      promptCharsOriginal,
      promptCharsRendered,
      omittedPromptPlanChars,
      responseCharsOriginal,
      responseCharsRendered,
      omittedResponseCompressedChars,
      snapshotCharsOriginal: params.snapshotView.snapshotCharsOriginal,
      snapshotCharsRendered: params.snapshotView.snapshotCharsRendered,
      omittedResponseChars,
      previewPolicy: previewPolicy(params.config.previewChars),
    },
    turnBudgetRecords: params.renderedTurns.turns.flatMap((turn) => turn.records),
    getTurnResults: [] as GetTurnToolResult[],
    toolCalls: [] as LlmToolCall[],
    toolResults: [] as Array<{
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      result: unknown;
    }>,
  };
}

function renderSessionTurnText(turn: { prompt?: string | null; response?: string | null }): string {
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
  readSkillNames?: string[];
  finalText?: string;
  rawText?: string;
  validationError?: string;
  extractions: ExtractionUnit[];
}): Promise<void> {
  const file = process.env.MUNINN_SESSION_MEMORY_TRACE_FILE
    ?? resolveDatabaseLogPath(event.database, 'extractor-trace.jsonl');
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(event)}\n`, 'utf8');
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export const __testing = {
  renderNewTurnsForTests: (turns: SessionExtractionInput['turns']) => renderNewTurns(turns).markdown,
  renderNewTurnsBudgetForTests: renderNewTurns,
  validateSessionExtractionResultForTests: validateSessionExtractionResult,
};
