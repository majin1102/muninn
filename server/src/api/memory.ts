import type {
  ListModeInput,
  NativeTables,
  ExtractionRow as Extraction,
  SessionRow,
  SessionSnapshotRow,
  TurnRow,
} from '../native.js';
import { embedText } from '../llm/embedding-provider.js';
import { generateText } from '../llm/provider.js';
import { loadPromptTemplate, renderPromptTemplate } from '../llm/prompts.js';
import { readTurnRow, sessionKey as buildSessionKey, normalizeSessionId } from '../pipeline/ingest.js';
import { parseSnapshotContent } from '../pipeline/snapshot.js';

export type RecallPublicMode = 'session' | 'extraction';

type SessionIdentity = { project: string; agent: string; sessionId: string };
type ContextKind = 'turn' | 'session' | 'extraction';

export interface RenderedContext {
  contextId: string;
  title?: string;
  summary?: string;
  detail?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecallHit {
  kind?: 'context' | 'synthesis';
  contextId?: string;
  title?: string;
  summary?: string;
  content: string;
  references: string[];
  project?: string;
  sessionId?: string;
  agent?: string;
  cwd?: string;
  sessionKey?: string;
  displaySession?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ContextReadRow {
  contextId: string;
  title?: string;
  content?: string;
  error?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_CONTEXT_ROW_ID_PATTERN = /^[0-9]+$/;
const SESSION_READ_EXTRACTION_SUMMARY_CHARS = 100;

export type ParsedContextId = {
  kind: ContextKind;
  contextId: string;
  id: string;
};

export function turnContextId(turnId: string): string {
  if (!/^turn:[^\s:]+$/.test(turnId)) {
    throw new Error(`invalid turn context id: ${turnId}`);
  }
  return turnId;
}

export function extractionContextId(id: string): string {
  const contextId = id.startsWith('ext:') ? id : `ext:${id}`;
  const parsed = parseContextId(contextId);
  if (parsed.kind !== 'extraction') {
    throw new Error(`invalid extraction context id: ${contextId}`);
  }
  return parsed.contextId;
}

export function parseContextId(contextId: string): ParsedContextId {
  if (contextId.startsWith('ext:')) {
    const id = contextId.slice('ext:'.length);
    if (!UUID_PATTERN.test(id)) {
      throw new Error(`invalid extraction context id: ${contextId}`);
    }
    return { kind: 'extraction', contextId: `ext:${id.toLowerCase()}`, id: id.toLowerCase() };
  }
  if (contextId.startsWith('session:')) {
    const id = contextId.slice('session:'.length);
    if (!SESSION_CONTEXT_ROW_ID_PATTERN.test(id)) {
      throw new Error(`invalid session context id: ${contextId}`);
    }
    return { kind: 'session', contextId: `session:${id}`, id };
  }
  if (contextId.startsWith('turn:')) {
    return { kind: 'turn', contextId: turnContextId(contextId), id: contextId.slice('turn:'.length) };
  }
  throw new Error(`unsupported context id: ${contextId}`);
}

function normalizeContextPart(value: string): string {
  return value.trim();
}

export async function getExtraction(
  client: NativeTables,
  contextId: string,
): Promise<Extraction | null> {
  const { id } = parseContextId(contextId);
  const rows = await client.extractionTable.get({ ids: [id] });
  return rows[0] ?? null;
}

export function inferRenderedContextKind(contextId: string): 'turn' | 'session' | 'extraction' {
  return parseContextId(contextId).kind;
}

export function fallbackRenderedContextTitle(context: RenderedContext): string {
  return context.title ?? context.summary ?? context.detail ?? context.contextId;
}

export function renderRenderedContextMarkdown(context: RenderedContext): string {
  const sections = [`# ${context.contextId}`];
  if (context.title) {
    sections.push('', '## Title', '', context.title);
  }
  sections.push('', '## Created At', '', context.createdAt);
  sections.push('', '## Updated At', '', context.updatedAt);
  if (context.summary) {
    sections.push('', '## Summary', '', context.summary);
  }
  if (context.detail) {
    sections.push('', '## Detail', '', context.detail);
  }
  return sections.join('\n');
}

export function renderTurn(turn: TurnRow): RenderedContext | null {
  const detail = renderTurnDetail(turn);
  if (!detail) {
    return null;
  }
  return {
    contextId: turnContextId(turn.turnId),
    detail,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
  };
}

export function renderSessionSnapshotRow(memory: SessionSnapshotRow): RenderedContext | null {
  const title = trimText(memory.title);
  const summary = trimText(memory.summary);
  const detail = trimText(memory.content);
  if (!title && !summary && !detail) {
    return null;
  }
  return {
    contextId: memory.snapshotId,
    title,
    summary,
    detail,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}

export function renderExtraction(memory: Extraction): RenderedContext {
  const content = trimText(memory.content)
    ? `Content:\n${memory.content.trim()}`
    : undefined;
  const references = memory.turnRefs.length > 0
    ? `References:\n${memory.turnRefs.map((ref) => `- ${ref}`).join('\n')}`
    : undefined;
  const detail = [content, references].filter(Boolean).join('\n\n') || undefined;
  return {
    contextId: extractionContextId(memory.id),
    title: memory.title,
    summary: memory.summary,
    detail,
    createdAt: memory.createdAt,
    updatedAt: memory.createdAt,
  };
}

export function renderSession(memory: SessionRow): RenderedContext {
  return {
    contextId: memory.latestSnapshotId,
    title: trimText(memory.title),
    summary: trimText(memory.summary),
    detail: sessionHitContent(memory),
    createdAt: memory.updatedAt,
    updatedAt: memory.updatedAt,
  };
}

function renderSessionReadMarkdown(snapshot: SessionSnapshotRow): string {
  const title = trimText(snapshot.title) ?? snapshot.snapshotId;
  const summary = trimText(snapshot.summary);
  const lines = [`# ${title}`];
  if (summary) {
    lines.push('', summary);
  }
  const extractions = sessionReadExtractions(snapshot);
  if (extractions.length > 0) {
    lines.push('', '## Extractions');
    for (const extraction of extractions) {
      lines.push('', `### ${extraction.title}`);
      if (extraction.contextId) {
        lines.push(`context_id: ${extraction.contextId}`);
      }
      lines.push(`summary: ${truncateSessionExtractionSummary(extraction.summary)}`);
    }
  }
  return lines.join('\n');
}

function sessionReadExtractions(snapshot: SessionSnapshotRow): Array<{
  title: string;
  summary: string;
  contextId?: string;
}> {
  try {
    const refs = new Set([
      ...snapshot.references,
      ...snapshotRefsFromMarkdown(snapshot.content),
    ]);
    const parsed = parseSnapshotContent(snapshot.content, refs, { includeContextIds: true });
    return parsed.extractions.map((extraction) => ({
      title: trimText(extraction.title) ?? trimText(extraction.text) ?? '(untitled extraction)',
      summary: trimText(extraction.text) ?? '',
      ...(extraction.id ? { contextId: extractionContextId(extraction.id) } : {}),
    }));
  } catch {
    return [];
  }
}

function truncateSessionExtractionSummary(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  const chars = Array.from(normalized);
  if (chars.length <= SESSION_READ_EXTRACTION_SUMMARY_CHARS) {
    return normalized;
  }
  return `${chars.slice(0, Math.max(0, SESSION_READ_EXTRACTION_SUMMARY_CHARS - 3)).join('')}...`;
}

function snapshotRefsFromMarkdown(markdown: string): string[] {
  const refs: string[] = [];
  for (const match of markdown.matchAll(/(?:<!--|^|;)\s*refs:\s*\[([^\]]*)\]/gim)) {
    const list = match[1] ?? '';
    for (const item of list.split(',')) {
      const ref = item.trim();
      if (ref) {
        refs.push(ref);
      }
    }
  }
  return refs;
}

export function renderTurnDetail(turn: TurnRow): string | undefined {
  const sections: string[] = [];
  if (trimText(turn.prompt)) {
    sections.push(`Prompt: ${turn.prompt!.trim()}`);
  }
  if (trimText(turn.response)) {
    sections.push(`Response: ${turn.response!.trim()}`);
  }
  const toolNames = turn.events
    .filter((event) => event.type === 'toolCall')
    .map((event) => event.name);
  if (toolNames.length > 0) {
    sections.push(`Tools: ${toolNames.join(', ')}`);
  }
  if (turn.artifacts && turn.artifacts.length > 0) {
    const rendered = [...turn.artifacts]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((artifact) => {
        const value = artifact.content ?? artifact.name ?? artifact.uri ?? artifact.kind;
        return `${artifact.key}: ${value}`;
      })
      .join(', ');
    sections.push(`Artifacts: ${rendered}`);
  }
  return sections.length > 0 ? sections.join('\n\n') : undefined;
}

function trimText(value?: string | null): string | undefined {
  return value?.trim() ? value.trim() : undefined;
}



export async function getTurn(
  client: NativeTables,
  contextId: string,
): Promise<TurnRow | null> {
  const parsed = parseContextId(contextId);
  if (parsed.kind !== 'turn') {
    throw new Error(`invalid turn context id: ${contextId}`);
  }
  const turn = await client.turnTable.getTurn(contextId);
  return turn ? readTurnRow(turn) : null;
}

export async function listTurns(
  client: NativeTables,
  params: { mode: ListModeInput; project?: string; agent?: string; sessionId?: string },
): Promise<TurnRow[]> {
  const turns = await client.turnTable.listTurns({
    mode: params.mode,
    project: normalizeText(params.project),
    agent: params.agent,
    sessionId: normalizeSessionId(params.sessionId),
  });
  return turns.map(readTurnRow);
}

export async function timelineTurns(
  client: NativeTables,
  params: { contextId: string; beforeLimit?: number; afterLimit?: number },
): Promise<TurnRow[]> {
  const parsed = parseContextId(params.contextId);
  if (parsed.kind !== 'turn') {
    throw new Error(`invalid turn context id: ${params.contextId}`);
  }
  const turns = await client.turnTable.timelineTurns({
    contextId: params.contextId,
    beforeLimit: params.beforeLimit,
    afterLimit: params.afterLimit,
  });
  return turns.map(readTurnRow);
}



export async function getSessionSnapshotRow(
  client: NativeTables,
  snapshotId: string,
): Promise<SessionSnapshotRow | null> {
  return client.sessionSnapshotTable.getSnapshot(snapshotId);
}

export async function listSessionSnapshotRows(
  client: NativeTables,
  params: { mode: ListModeInput; extractor?: string },
): Promise<SessionSnapshotRow[]> {
  const rows = await client.sessionSnapshotTable.listSnapshots({
    extractor: params.extractor,
  });
  return applySessionSnapshotListMode(rows, params.mode);
}

export async function timelineSessionSnapshotRows(
  client: NativeTables,
  params: { snapshotId: string; beforeLimit?: number; afterLimit?: number },
): Promise<SessionSnapshotRow[]> {
  const anchor = await getSessionSnapshotRow(client, params.snapshotId);
  if (!anchor) {
    return [];
  }
  const snapshots = await client.sessionSnapshotTable.threadSnapshots({
    project: anchor.project,
    agent: anchor.agent,
    sessionId: anchor.sessionId,
    extractor: anchor.extractor,
  });
  snapshots.sort((left, right) => (
    left.snapshotSequence - right.snapshotSequence
    || left.createdAt.localeCompare(right.createdAt)
  ));
  const anchorIndex = snapshots.findIndex((row) => row.snapshotId === params.snapshotId);
  if (anchorIndex < 0) {
    return [];
  }
  const beforeLimit = params.beforeLimit ?? 3;
  const afterLimit = params.afterLimit ?? 3;
  const start = Math.max(0, anchorIndex - beforeLimit);
  const end = Math.min(snapshots.length, anchorIndex + afterLimit + 1);
  return snapshots.slice(start, end);
}

function applySessionSnapshotListMode(rows: SessionSnapshotRow[], mode: ListModeInput): SessionSnapshotRow[] {
  const latestBySession = new Map<string, SessionSnapshotRow>();
  for (const row of rows) {
    const key = sessionIdentityKey(row);
    const current = latestBySession.get(key);
    if (!current
      || row.snapshotSequence > current.snapshotSequence
      || (row.snapshotSequence === current.snapshotSequence && row.createdAt > current.createdAt)
    ) {
      latestBySession.set(key, row);
    }
  }

  const latest = [...latestBySession.values()];
  latest.sort((left, right) => (
    right.createdAt.localeCompare(left.createdAt)
    || right.snapshotSequence - left.snapshotSequence
  ));

  if (mode.type === 'recency') {
    const selected = latest.slice(0, mode.limit);
    return selected.sort((left, right) => (
      left.createdAt.localeCompare(right.createdAt)
      || left.snapshotSequence - right.snapshotSequence
    ));
  }

  return latest.slice(mode.offset, mode.offset + mode.limit);
}

function sessionIdentityKey(identity: SessionIdentity): string {
  return JSON.stringify([
    normalizeContextPart(identity.project),
    normalizeContextPart(identity.agent),
    normalizeContextPart(identity.sessionId),
  ]);
}



export type MemoryRecallCandidate = {
  contextId: string;
  content: string;
  context?: string | null;
  refs: string[];
};

export type MemoryRecallInput = {
  query: string;
  budget: number;
  candidates: MemoryRecallCandidate[];
};

export type MemoryRecallResult = {
  content: string;
  refs: string[];
};

type SessionRerankCandidate = {
  contextId: string;
  title: string;
  summary: string;
  updatedAt?: string;
  backendRank: number;
};

type SessionRerankInput = {
  query: string;
  now: string;
  candidates: SessionRerankCandidate[];
};

type SessionRerankResult = {
  contextIds: string[];
  filteredContextIds: string[];
};

export async function recallMemoryContext(input: MemoryRecallInput): Promise<MemoryRecallResult> {
  const template = loadPromptTemplate('memory_recaller');
  const prompt = renderPromptTemplate(template.userTemplate, {
    query: input.query,
    budget: input.budget,
    candidates: renderCandidates(input.candidates),
  });
  const attempts = 2;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const raw = await generateText('extractor', {
        system: template.system,
        prompt,
      });
      if (!raw) {
        throw new Error('memory recaller llm is unavailable');
      }
      return validateMemoryRecallResult(parseMemoryRecallJson(raw), input);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function validateMemoryRecallResult(
  result: MemoryRecallResult,
  input: MemoryRecallInput,
): MemoryRecallResult {
  const content = result.content.trim();
  if (!content) {
    throw new Error('memory recaller returned empty content');
  }
  const maxLength = input.budget * 2;
  if (content.length > maxLength) {
    throw new Error(`memory recaller content exceeds soft budget limit: ${content.length} > ${maxLength}`);
  }
  const refs = uniqueStrings(result.refs);
  return { content, refs };
}

function parseMemoryRecallJson(raw: string): MemoryRecallResult {
  const parsed = JSON.parse(stripJsonFence(raw)) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('memory recaller result must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.content !== 'string') {
    throw new Error('memory recaller result.content must be a string');
  }
  if (!Array.isArray(record.refs)) {
    throw new Error('memory recaller result.refs must be an array');
  }
  return {
    content: record.content,
    refs: record.refs.map((ref) => String(ref).trim()).filter(Boolean),
  };
}

function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function renderCandidates(candidates: MemoryRecallCandidate[]): string {
  return candidates.map((candidate, index) => [
    `[${index + 1}] ${candidate.contextId}`,
    `Content: ${candidate.content}`,
    candidate.context?.trim() ? `Context: ${candidate.context.trim()}` : '',
    `Refs: ${candidate.refs.join(', ')}`,
  ].filter(Boolean).join('\n')).join('\n\n');
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    output.push(value);
  }
  return output;
}



type RecallOptions = {
  mode?: RecallPublicMode;
  budget?: number;
  queryLimit?: number;
  thinkingRatio?: number;
  embed?: (text: string) => Promise<number[]>;
  recallMemory?: (input: MemoryRecallInput) => Promise<MemoryRecallResult>;
  sessionRerank?: (input: SessionRerankInput) => Promise<SessionRerankResult>;
  excludeSession?: SessionIdentity;
};

export async function recallMemories(
  client: NativeTables,
  query: string,
  limit = 10,
  options: RecallOptions = {},
): Promise<RecallHit[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }
  const mode = options.mode ?? 'extraction';
  if (mode !== 'session' && mode !== 'extraction') {
    throw new Error('recall mode must be one of: session, extraction');
  }
  if (mode === 'session') {
    if (options.budget !== undefined || options.queryLimit !== undefined || options.thinkingRatio !== undefined) {
      throw new Error('budget, queryLimit, and thinkingRatio are only supported in extraction recall mode');
    }
    if (limit <= 0) {
      return [];
    }
    const vector = await (options.embed ?? embedText)(trimmed);
    const outputLimit = Math.max(0, limit);
    const candidateLimit = outputLimit * 4;
    const rows = await client.sessionTable.search({
      query: trimmed,
      vector,
      limit: candidateLimit,
    });
    const hits = rows
      .map(sessionHit)
      .filter((hit) => !isExcludedSession(hit, options.excludeSession));
    return rerankSessionHits(trimmed, hits, outputLimit, options.sessionRerank);
  }

  const budget = options.budget ?? 0;
  if (!Number.isSafeInteger(budget) || budget < 0) {
    throw new Error('recall budget must be a non-negative integer');
  }
  if (budget === 0 && limit <= 0) {
    return [];
  }
  const queryLimit = budget > 0 ? (options.queryLimit ?? 8) : limit;
  if (!Number.isSafeInteger(queryLimit) || queryLimit <= 0) {
    throw new Error('recall queryLimit must be a positive integer');
  }
  const vector = await (options.embed ?? embedText)(trimmed);
  const extractionRows = await client.extractionTable.search({
    query: trimmed,
    vector,
    limit: queryLimit,
    mode: 'hybrid',
  });
  const hits = await Promise.all(extractionRows.map((row) => extractionHit(client, row)));
  if (budget > 0) {
    if (hits.length === 0) {
      return [];
    }
    const candidates = extractionRows.map((row) => ({
      contextId: extractionContextId(row.id),
      content: row.content,
      refs: row.turnRefs,
    }));
    const input = {
      query: trimmed,
      budget,
      candidates,
    };
    const recalled = validateMemoryRecallResult(
      await (options.recallMemory ?? recallMemoryContext)(input),
      input,
    );
    return [{
      kind: 'synthesis',
      content: recalled.content,
      references: uniqueRefs(candidates.flatMap((candidate) => candidate.refs ?? [])),
      ...hitMetadata(hits.find((hit) => hasSessionMetadata(hit))),
    }];
  }
  return hits.slice(0, limit);
}

async function extractionHit(client: NativeTables, row: Extraction): Promise<RecallHit> {
  return {
    kind: 'context',
    contextId: extractionContextId(row.id),
    title: row.title,
    summary: row.summary,
    content: row.content,
    references: row.turnRefs,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...await ownershipFromTurnRefs(client, row.turnRefs),
  };
}

function sessionHit(row: SessionRow): RecallHit {
  return {
    kind: 'context',
    contextId: row.latestSnapshotId,
    title: row.title,
    summary: row.summary,
    content: sessionHitContent(row),
    references: [],
    project: row.project,
    sessionId: row.sessionId,
    agent: row.agent,
    cwd: row.cwd,
    displaySession: row.title,
    createdAt: row.updatedAt,
    updatedAt: row.updatedAt,
  };
}

function sessionHitContent(row: Pick<SessionRow, 'latestSnapshotId' | 'title' | 'summary'>): string {
  return [trimText(row.title), trimText(row.summary)]
    .filter(Boolean)
    .join('\n\n') || row.latestSnapshotId;
}

function isExcludedSession(hit: RecallHit, excluded: SessionIdentity | undefined): boolean {
  return Boolean(
    excluded
    && hit.project === excluded.project
    && hit.agent === excluded.agent
    && hit.sessionId === excluded.sessionId,
  );
}

async function rerankSessionHits(
  query: string,
  hits: RecallHit[],
  limit: number,
  rerank: (input: SessionRerankInput) => Promise<SessionRerankResult> = rerankSessionImportCandidates,
): Promise<RecallHit[]> {
  const candidates = hits
    .map((hit, index) => ({ hit, candidate: sessionRerankCandidate(hit, index + 1) }))
    .filter((entry): entry is { hit: RecallHit; candidate: SessionRerankCandidate } => Boolean(entry.candidate));
  const fallback = deterministicSessionOrder(query, candidates);
  if (candidates.length === 0) {
    return fallback.map((entry) => entry.hit).slice(0, limit);
  }
  try {
    const result = await rerank({
      query,
      now: new Date().toISOString(),
      candidates: candidates.map((entry) => entry.candidate),
    });
    return completeSessionRerank(result, candidates)
      .map((entry) => entry.hit)
      .slice(0, limit);
  } catch {
    return fallback.map((entry) => entry.hit).slice(0, limit);
  }
}

function sessionRerankCandidate(hit: RecallHit, backendRank: number): SessionRerankCandidate | null {
  if (!hit.contextId?.startsWith('session:')) {
    return null;
  }
  return {
    contextId: hit.contextId,
    title: trimText(hit.title) ?? trimText(hit.displaySession) ?? trimText(hit.sessionId) ?? hit.contextId,
    summary: trimText(hit.summary) ?? trimText(hit.content) ?? '',
    updatedAt: hit.updatedAt,
    backendRank,
  };
}

async function rerankSessionImportCandidates(input: SessionRerankInput): Promise<SessionRerankResult> {
  const template = loadPromptTemplate('session_reranker');
  const raw = await generateText('extractor', {
    system: template.system,
    prompt: renderPromptTemplate(template.userTemplate, {
      query: input.query,
      now: input.now,
      candidates: renderSessionRerankCandidates(input.candidates),
    }),
  });
  if (!raw) {
    throw new Error('session reranker llm is unavailable');
  }
  return parseSessionRerankJson(raw);
}

function renderSessionRerankCandidates(candidates: SessionRerankCandidate[]): string {
  return candidates.map((candidate) => [
    `context_id: ${candidate.contextId}`,
    `backend_rank: ${candidate.backendRank}`,
    `updated_at: ${candidate.updatedAt ?? ''}`,
    `title: ${candidate.title}`,
    `summary: ${candidate.summary}`,
  ].join('\n')).join('\n\n');
}

function parseSessionRerankJson(raw: string): SessionRerankResult {
  const parsed = JSON.parse(stripJsonFence(raw)) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('session reranker result must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const value = record.context_ids ?? record.contextIds;
  const filteredValue = record.filtered_context_ids ?? record.filteredContextIds;
  if (!Array.isArray(value)) {
    throw new Error('session reranker result.context_ids must be an array');
  }
  if (!Array.isArray(filteredValue)) {
    throw new Error('session reranker result.filtered_context_ids must be an array');
  }
  return {
    contextIds: value.map((contextId) => String(contextId).trim()).filter(Boolean),
    filteredContextIds: filteredValue.map((contextId) => String(contextId).trim()).filter(Boolean),
  };
}

function completeSessionRerank(
  result: SessionRerankResult,
  candidates: { hit: RecallHit; candidate: SessionRerankCandidate }[],
): { hit: RecallHit; candidate: SessionRerankCandidate }[] {
  const byId = new Map(candidates.map((entry) => [entry.candidate.contextId, entry]));
  const used = new Set<string>();
  const ordered: { hit: RecallHit; candidate: SessionRerankCandidate }[] = [];
  const consume = (contextId: string): { hit: RecallHit; candidate: SessionRerankCandidate } => {
    const entry = byId.get(contextId);
    if (!entry || used.has(contextId)) {
      throw new Error(`invalid session reranker context id: ${contextId}`);
    }
    used.add(contextId);
    return entry;
  };
  for (const contextId of result.contextIds) {
    ordered.push(consume(contextId));
  }
  for (const contextId of result.filteredContextIds) {
    consume(contextId);
  }
  if (used.size !== byId.size) {
    throw new Error('session reranker omitted context ids');
  }
  return ordered;
}

function deterministicSessionOrder(
  query: string,
  entries: { hit: RecallHit; candidate: SessionRerankCandidate }[],
): { hit: RecallHit; candidate: SessionRerankCandidate }[] {
  const tokens = queryTokensForRerank(query);
  const newest = Math.max(0, ...entries.map((entry) => Date.parse(entry.candidate.updatedAt ?? '') || 0));
  return entries.slice().sort((left, right) => {
    const leftScore = deterministicSessionScore(left.candidate, tokens, newest);
    const rightScore = deterministicSessionScore(right.candidate, tokens, newest);
    return rightScore - leftScore
      || left.candidate.backendRank - right.candidate.backendRank
      || (right.candidate.updatedAt ?? '').localeCompare(left.candidate.updatedAt ?? '');
  });
}

function deterministicSessionScore(
  candidate: SessionRerankCandidate,
  tokens: string[],
  newestMs: number,
): number {
  const title = normalizeRerankText(candidate.title);
  const summary = normalizeRerankText(candidate.summary);
  const query = tokens.join(' ');
  const titlePhrase = query && title.includes(query) ? 12 : 0;
  const summaryPhrase = query && summary.includes(query) ? 6 : 0;
  const titleMatches = tokens.filter((token) => title.includes(token)).length;
  const summaryMatches = tokens.filter((token) => summary.includes(token)).length;
  const coverage = new Set(tokens.filter((token) => title.includes(token) || summary.includes(token))).size;
  const backendPrior = 0.25 / Math.max(1, candidate.backendRank);
  const recency = recencyTieBreaker(candidate.updatedAt, newestMs);
  return titlePhrase
    + summaryPhrase
    + titleMatches * 5
    + summaryMatches * 2
    + coverage * 3
    + backendPrior
    + recency;
}

function recencyTieBreaker(updatedAt: string | undefined, newestMs: number): number {
  const updatedMs = Date.parse(updatedAt ?? '');
  if (!updatedMs || !newestMs || updatedMs > newestMs) {
    return 0;
  }
  const ageDays = (newestMs - updatedMs) / 86_400_000;
  return Math.max(0, 0.2 - Math.min(ageDays, 30) * (0.2 / 30));
}

function queryTokensForRerank(query: string): string[] {
  return Array.from(new Set(normalizeRerankText(query)
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !RERANK_STOPWORDS.has(token))));
}

const RERANK_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'about',
]);

function normalizeRerankText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

async function ownershipFromTurnRefs(client: NativeTables, refs: string[]): Promise<Partial<RecallHit>> {
  for (const ref of refs) {
    const contextId = turnContextRef(ref);
    if (!contextId) {
      continue;
    }
    const rawTurn = await client.turnTable?.getTurn?.(contextId);
    if (rawTurn) {
      const turn = readTurnRow(rawTurn);
      return {
        project: turn.project,
        sessionId: turn.sessionId ?? undefined,
        agent: turn.agent,
        cwd: turn.cwd,
        sessionKey: buildSessionKey(turn.sessionId ?? undefined, turn.agent, turn.extractor, {
          project: turn.project,
          cwd: turn.cwd,
        }),
        displaySession: await displaySession(client, turn),
      };
    }
  }
  return {};
}

async function displaySession(client: NativeTables, turn: TurnRow): Promise<string> {
  const sessionId = turn.sessionId?.trim();
  if (!sessionId) {
    return 'Default Session';
  }
  const snapshots = typeof client.sessionSnapshotTable?.threadSnapshots === 'function'
    ? await client.sessionSnapshotTable.threadSnapshots({
      project: turn.project,
      agent: turn.agent,
      sessionId,
      extractor: turn.extractor,
    }).catch(() => [])
    : [];
  const newest = snapshots
    ?.slice()
    .filter((snapshot) => snapshot.cwd === turn.cwd && snapshot.agent === turn.agent)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  return normalizeText(newest?.title) ?? displayTitle(sessionId);
}

function hitMetadata(hit: RecallHit | undefined): Partial<RecallHit> {
  if (!hit) {
    return {};
  }
  return {
    project: hit.project,
    sessionId: hit.sessionId,
    agent: hit.agent,
    cwd: hit.cwd,
    sessionKey: hit.sessionKey,
    displaySession: hit.displaySession,
  };
}

function hasSessionMetadata(hit: RecallHit): boolean {
  return Boolean(hit.project && hit.agent && hit.cwd);
}

function turnContextRef(ref: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return parseContextId(trimmed).kind === 'turn' ? trimmed : null;
  } catch {
    return null;
  }
}

function displayTitle(sessionId: string): string {
  const lastSlash = sessionId.lastIndexOf('/');
  const raw = lastSlash >= 0 ? sessionId.slice(lastSlash + 1) : sessionId;
  return raw.replace(/-[0-9a-f]{7,}$/i, '') || sessionId;
}

function normalizeText(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function uniqueRefs(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const ref = value.trim();
    if (!ref || seen.has(ref)) {
      continue;
    }
    seen.add(ref);
    output.push(ref);
  }
  return output;
}



export class Memories {
  constructor(private readonly client: NativeTables) {}

  async getTurn(contextId: string): Promise<TurnRow | null> {
    return getTurn(this.client, contextId);
  }

  async listTurns(params: {
    mode: ListModeInput;
    project?: string;
    agent?: string;
    sessionId?: string;
  }): Promise<TurnRow[]> {
    return listTurns(this.client, params);
  }

  async getSessionSnapshot(snapshotId: string): Promise<SessionSnapshotRow | null> {
    return getSessionSnapshotRow(this.client, snapshotId);
  }

  async listSessions(params: {
    mode: ListModeInput;
    extractor?: string;
  }): Promise<SessionSnapshotRow[]> {
    return listSessionSnapshotRows(this.client, params);
  }

  async getContext(contextId: string): Promise<RenderedContext | null> {
    const parsed = parseContextId(contextId);
    if (parsed.kind === 'extraction') {
      const extraction = await getExtraction(this.client, contextId);
      return extraction ? renderExtraction(extraction) : null;
    }
    if (parsed.kind === 'session') {
      const snapshot = await this.getSessionSnapshotForContextId(contextId);
      return snapshot ? renderSessionSnapshotRow(snapshot) : null;
    }
    const turn = await getTurn(this.client, contextId);
    return turn ? renderTurn(turn) : null;
  }

  async readContextIds(contextIds: string[]): Promise<ContextReadRow[]> {
    return Promise.all(contextIds.map(async (contextId) => {
      try {
        return await this.readContextId(contextId);
      } catch (error) {
        if (!isExpectedContextReadError(error)) {
          throw error;
        }
        return {
          contextId,
          error: error.message,
        };
      }
    }));
  }

  async list(params: { mode: ListModeInput }): Promise<RenderedContext[]> {
    const sourceMode = params.mode.type === 'page'
      ? { type: 'recency', limit: params.mode.offset + params.mode.limit } as const
      : params.mode;
    const [turns, sessions] = await Promise.all([
      listTurns(this.client, { mode: sourceMode }),
      listSessionSnapshotRows(this.client, { mode: sourceMode }),
    ]);
    const combined = turns
      .map(renderTurn)
      .concat(sessions.map(renderSessionSnapshotRow))
      .filter((context): context is RenderedContext => Boolean(context));
    combined.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    if (params.mode.type === 'recency') {
      const selected = combined.slice(0, params.mode.limit);
      return selected.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    }
    return combined.slice(params.mode.offset, params.mode.offset + params.mode.limit);
  }

  async timeline(params: {
    contextId: string;
    beforeLimit?: number;
    afterLimit?: number;
  }): Promise<RenderedContext[]> {
    const parsed = parseContextId(params.contextId);
    if (parsed.kind === 'session') {
      return (await timelineSessionSnapshotRows(this.client, {
        snapshotId: params.contextId,
        beforeLimit: params.beforeLimit,
        afterLimit: params.afterLimit,
      }))
        .map(renderSessionSnapshotRow)
        .filter((context): context is RenderedContext => Boolean(context));
    }
    return (await timelineTurns(this.client, params))
      .map(renderTurn)
      .filter((context): context is RenderedContext => Boolean(context));
  }

  async recall(
    query: string,
    limit?: number,
    options?: {
      mode?: RecallPublicMode;
      budget?: number;
      queryLimit?: number;
      thinkingRatio?: number;
      excludeSession?: SessionIdentity;
    },
  ): Promise<RecallHit[]> {
    return recallMemories(this.client, query, limit, options);
  }

  private async getSessionSnapshotForContextId(contextId: string): Promise<SessionSnapshotRow | null> {
    return this.client.sessionSnapshotTable.getSnapshot(contextId);
  }

  private async readContextId(contextId: string): Promise<ContextReadRow> {
    const parsed = parseContextId(contextId);
    if (parsed.kind === 'session') {
      return this.readSessionContextId(contextId);
    }
    if (parsed.kind === 'turn') {
      return this.readTurnContextId(contextId);
    }
    const rendered = await this.getContext(contextId);
    if (!rendered) {
      throw new Error(`extraction context not found: ${contextId}`);
    }
    return {
      contextId,
      title: rendered.title,
      content: renderRenderedContextMarkdown(rendered),
    };
  }

  private async readSessionContextId(contextId: string): Promise<ContextReadRow> {
    const snapshot = await this.getSessionSnapshotForContextId(contextId);
    if (!snapshot) {
      throw new Error(`session context not found: ${contextId}`);
    }
    const title = trimText(snapshot.title);
    return {
      contextId,
      title,
      content: renderSessionReadMarkdown(snapshot),
    };
  }

  private async readTurnContextId(contextId: string): Promise<ContextReadRow> {
    const turn = await getTurn(this.client, contextId);
    if (!turn) {
      throw new Error(`turn context not found: ${contextId}`);
    }
    const rendered = renderTurn(turn);
    if (!rendered) {
      throw new Error(`turn context has no readable content: ${contextId}`);
    }
    return {
      contextId,
      title: contextId,
      content: renderTurnContextMarkdown(contextId, rendered),
    };
  }

}

function isExpectedContextReadError(error: unknown): error is Error {
  if (!(error instanceof Error)) {
    return false;
  }
  return [
    'unsupported context id:',
    'invalid session context id:',
    'invalid turn context id:',
    'invalid extraction context id:',
    'session context not found:',
    'extraction context not found:',
    'turn context not found:',
    'turn context has no readable content:',
  ].some((prefix) => error.message.startsWith(prefix));
}

function renderTurnContextMarkdown(contextId: string, memory: RenderedContext): string {
  const sections = [`# ${contextId}`];
  sections.push('', '## Created At', '', memory.createdAt);
  sections.push('', '## Updated At', '', memory.updatedAt);
  if (memory.detail) {
    sections.push('', '## Detail', '', memory.detail);
  }
  return sections.join('\n');
}
