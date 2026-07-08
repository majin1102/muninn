import { Buffer } from 'node:buffer';

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

export type RecallPublicMode = 'session' | 'extraction';

type SessionIdentity = { project: string; agent: string; sessionId: string };

export interface RenderedMemory {
  memoryId: string;
  title?: string;
  summary?: string;
  detail?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecallHit {
  memoryId: string;
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

export function assertMemoryIdLayer(memoryId: string, expectedLayer: 'turn' | 'session'): void {
  const [layer, point, extra] = memoryId.split(':');
  if (!layer || !point || extra !== undefined || !/^\d+$/.test(point)) {
    throw new Error(`invalid memory id: ${memoryId}`);
  }
  if (layer !== expectedLayer) {
    throw new Error(`invalid memory id layer: expected ${expectedLayer}, got ${layer}`);
  }
}

export function parseExtractionMemoryId(memoryId: string): string {
  const [layer, id, extra] = memoryId.split(':');
  if (layer !== 'ext' || !id || extra !== undefined) {
    throw new Error(`invalid extraction memory id: ${memoryId}`);
  }
  return id;
}

export function sessionContextId(identity: SessionIdentity): string {
  validateSessionContextIdentity(identity);
  return `session_${Buffer.from(JSON.stringify([
    identity.project,
    identity.agent,
    identity.sessionId,
  ])).toString('base64url')}`;
}

export function parseSessionContextId(contextId: string): SessionIdentity {
  if (!contextId.startsWith('session_')) {
    throw new Error(`unsupported context id: ${contextId}`);
  }
  try {
    const parsed = JSON.parse(Buffer.from(contextId.slice('session_'.length), 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 3) {
      throw new Error('payload must be a three item array');
    }
    const [project, agent, sessionId] = parsed;
    const identity = { project, agent, sessionId };
    validateSessionContextIdentity(identity);
    return identity;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('invalid session context id')) {
      throw error;
    }
    throw new Error(`invalid session context id: ${contextId}`);
  }
}

export function turnContextId(memoryId: string): string {
  assertMemoryIdLayer(memoryId, 'turn');
  return `turn_${Buffer.from(memoryId).toString('base64url')}`;
}

export function parseTurnContextId(contextId: string): string {
  if (!contextId.startsWith('turn_')) {
    throw new Error(`unsupported context id: ${contextId}`);
  }
  const memoryId = Buffer.from(contextId.slice('turn_'.length), 'base64url').toString('utf8');
  assertMemoryIdLayer(memoryId, 'turn');
  return memoryId;
}

export function contextIdForRecallHit(hit: Pick<RecallHit, 'project' | 'agent' | 'sessionId'>): string | null {
  if (!hit.project || !hit.agent || !hit.sessionId) {
    return null;
  }
  try {
    return sessionContextId({
      project: hit.project,
      agent: hit.agent,
      sessionId: hit.sessionId,
    });
  } catch {
    return null;
  }
}

function validateSessionContextIdentity(identity: {
  project: unknown;
  agent: unknown;
  sessionId: unknown;
}): asserts identity is SessionIdentity {
  if (
    typeof identity.project !== 'string'
    || identity.project.trim().length === 0
    || typeof identity.agent !== 'string'
    || identity.agent.trim().length === 0
    || typeof identity.sessionId !== 'string'
    || identity.sessionId.trim().length === 0
  ) {
    throw new Error('invalid session context id: project, agent, and sessionId must be non-empty strings');
  }
}

export async function getExtraction(
  client: NativeTables,
  memoryId: string,
): Promise<Extraction | null> {
  const id = parseExtractionMemoryId(memoryId);
  const rows = await client.extractionTable.get({ ids: [id] });
  return rows[0] ?? null;
}

export function inferRenderedMemoryKind(memoryId: string): 'turn' | 'session' | 'extraction' {
  if (memoryId.startsWith('turn:')) {
    return 'turn';
  }
  if (memoryId.startsWith('ext:')) {
    return 'extraction';
  }
  return 'session';
}

export function fallbackRenderedMemoryTitle(memory: RenderedMemory): string {
  return memory.title ?? memory.summary ?? memory.detail ?? memory.memoryId;
}

export function renderRenderedMemoryMarkdown(memory: RenderedMemory): string {
  const sections = [`# ${memory.memoryId}`];
  if (memory.title) {
    sections.push('', '## Title', '', memory.title);
  }
  sections.push('', '## Created At', '', memory.createdAt);
  sections.push('', '## Updated At', '', memory.updatedAt);
  if (memory.summary) {
    sections.push('', '## Summary', '', memory.summary);
  }
  if (memory.detail) {
    sections.push('', '## Detail', '', memory.detail);
  }
  return sections.join('\n');
}

export function renderTurn(memory: TurnRow): RenderedMemory | null {
  const detail = renderTurnDetail(memory);
  if (!detail) {
    return null;
  }
  return {
    memoryId: memory.turnId,
    detail,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}

export function renderSessionSnapshotRow(memory: SessionSnapshotRow): RenderedMemory | null {
  const title = trimText(memory.title);
  const summary = trimText(memory.summary);
  const detail = trimText(memory.content);
  if (!title && !summary && !detail) {
    return null;
  }
  return {
    memoryId: memory.snapshotId,
    title,
    summary,
    detail,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}

export function renderExtraction(memory: Extraction): RenderedMemory {
  const content = trimText(memory.content)
    ? `Content:\n${memory.content.trim()}`
    : undefined;
  const references = memory.turnRefs.length > 0
    ? `References:\n${memory.turnRefs.map((ref) => `- ${ref}`).join('\n')}`
    : undefined;
  const detail = [content, references].filter(Boolean).join('\n\n') || undefined;
  return {
    memoryId: `ext:${memory.id}`,
    title: memory.title,
    summary: memory.summary,
    detail,
    createdAt: memory.createdAt,
    updatedAt: memory.createdAt,
  };
}

export function renderSession(memory: SessionRow): RenderedMemory {
  return {
    memoryId: memory.latestSnapshotId,
    title: trimText(memory.title),
    summary: trimText(memory.summary),
    detail: sessionHitContent(memory),
    createdAt: memory.updatedAt,
    updatedAt: memory.updatedAt,
  };
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
  memoryId: string,
): Promise<TurnRow | null> {
  assertMemoryIdLayer(memoryId, 'turn');
  const turn = await client.turnTable.getTurn(memoryId);
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
  params: { memoryId: string; beforeLimit?: number; afterLimit?: number },
): Promise<TurnRow[]> {
  assertMemoryIdLayer(params.memoryId, 'turn');
  const turns = await client.turnTable.timelineTurns({
    memoryId: params.memoryId,
    beforeLimit: params.beforeLimit,
    afterLimit: params.afterLimit,
  });
  return turns.map(readTurnRow);
}



export async function getSessionSnapshotRow(
  client: NativeTables,
  memoryId: string,
): Promise<SessionSnapshotRow | null> {
  assertMemoryIdLayer(memoryId, 'session');
  return client.sessionSnapshotTable.getSnapshot(memoryId);
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
  params: { memoryId: string; beforeLimit?: number; afterLimit?: number },
): Promise<SessionSnapshotRow[]> {
  assertMemoryIdLayer(params.memoryId, 'session');
  const anchor = await getSessionSnapshotRow(client, params.memoryId);
  if (!anchor) {
    return [];
  }
  const snapshots = await client.sessionSnapshotTable.threadSnapshots(anchor.sessionId);
  snapshots.sort((left, right) => (
    left.snapshotSequence - right.snapshotSequence
    || left.createdAt.localeCompare(right.createdAt)
  ));
  const anchorIndex = snapshots.findIndex((row) => row.snapshotId === params.memoryId);
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
  const latestBySessionId = new Map<string, SessionSnapshotRow>();
  for (const row of rows) {
    const current = latestBySessionId.get(row.sessionId);
    if (!current
      || row.snapshotSequence > current.snapshotSequence
      || (row.snapshotSequence === current.snapshotSequence && row.createdAt > current.createdAt)
    ) {
      latestBySessionId.set(row.sessionId, row);
    }
  }

  const latest = [...latestBySessionId.values()];
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



export type MemoryRecallCandidate = {
  memoryId: string;
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
    `[${index + 1}] ${candidate.memoryId}`,
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
    const rows = await client.sessionTable.search({
      query: trimmed,
      vector,
      limit,
    });
    return rows.map(sessionHit);
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
      memoryId: `ext:${row.id}`,
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
      memoryId: 'recalled:memory',
      content: recalled.content,
      references: uniqueRefs(candidates.flatMap((candidate) => candidate.refs ?? [])),
      ...hitMetadata(hits.find((hit) => hasSessionMetadata(hit))),
    }];
  }
  return hits.slice(0, limit);
}

async function extractionHit(client: NativeTables, row: Extraction): Promise<RecallHit> {
  return {
    memoryId: `ext:${row.id}`,
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
    memoryId: row.latestSnapshotId,
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

async function ownershipFromTurnRefs(client: NativeTables, refs: string[]): Promise<Partial<RecallHit>> {
  for (const ref of refs) {
    const turnId = turnMemoryId(ref);
    if (!turnId) {
      continue;
    }
    const rawTurn = await client.turnTable?.getTurn?.(turnId);
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
    ? await client.sessionSnapshotTable.threadSnapshots(sessionId).catch(() => [])
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

function turnMemoryId(ref: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.startsWith('turn:') ? trimmed : null;
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

  async getTurn(memoryId: string): Promise<TurnRow | null> {
    return getTurn(this.client, memoryId);
  }

  async listTurns(params: {
    mode: ListModeInput;
    project?: string;
    agent?: string;
    sessionId?: string;
  }): Promise<TurnRow[]> {
    return listTurns(this.client, params);
  }

  async getSession(memoryId: string): Promise<SessionSnapshotRow | null> {
    return getSessionSnapshotRow(this.client, memoryId);
  }

  async listSessions(params: {
    mode: ListModeInput;
    extractor?: string;
  }): Promise<SessionSnapshotRow[]> {
    return listSessionSnapshotRows(this.client, params);
  }

  async get(memoryId: string): Promise<RenderedMemory | null> {
    if (memoryId.startsWith('ext:')) {
      const extraction = await getExtraction(this.client, memoryId);
      return extraction ? renderExtraction(extraction) : null;
    }
    if (memoryId.startsWith('session:')) {
      const snapshot = await getSessionSnapshotRow(this.client, memoryId);
      return snapshot ? renderSessionSnapshotRow(snapshot) : null;
    }
    const turn = await getTurn(this.client, memoryId);
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

  async explainContextId(contextId: string): Promise<ContextReadRow> {
    if (contextId.startsWith('turn_')) {
      throw new Error('muninn_explain only supports session_* context ids');
    }
    const identity = parseSessionContextId(contextId);
    const session = await this.getSessionRow(identity);
    const snapshot = await this.client.sessionSnapshotTable.getSnapshot(session.latestSnapshotId);
    if (!snapshot) {
      throw new Error(`session snapshot not found: ${session.latestSnapshotId}`);
    }
    const provenance = await this.renderSourceProvenance(snapshot.references);
    return {
      contextId,
      title: trimText(session.title),
      content: [
        '# Muninn Explain',
        '',
        `Explained: ${contextId}`,
        '',
        '## Source Provenance',
        '',
        provenance,
      ].join('\n'),
    };
  }

  async list(params: { mode: ListModeInput }): Promise<RenderedMemory[]> {
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
      .filter((memory): memory is RenderedMemory => Boolean(memory));
    combined.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    if (params.mode.type === 'recency') {
      const selected = combined.slice(0, params.mode.limit);
      return selected.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    }
    return combined.slice(params.mode.offset, params.mode.offset + params.mode.limit);
  }

  async timeline(params: {
    memoryId: string;
    beforeLimit?: number;
    afterLimit?: number;
  }): Promise<RenderedMemory[]> {
    if (params.memoryId.startsWith('session:')) {
      return (await timelineSessionSnapshotRows(this.client, params))
        .map(renderSessionSnapshotRow)
        .filter((memory): memory is RenderedMemory => Boolean(memory));
    }
    return (await timelineTurns(this.client, params))
      .map(renderTurn)
      .filter((memory): memory is RenderedMemory => Boolean(memory));
  }

  async recall(
    query: string,
    limit?: number,
    options?: { mode?: RecallPublicMode; budget?: number; queryLimit?: number; thinkingRatio?: number },
  ): Promise<RecallHit[]> {
    return recallMemories(this.client, query, limit, options);
  }

  private async readContextId(contextId: string): Promise<ContextReadRow> {
    if (contextId.startsWith('session_')) {
      return this.readSessionContextId(contextId);
    }
    if (contextId.startsWith('turn_')) {
      return this.readTurnContextId(contextId);
    }
    throw new Error(`unsupported context id: ${contextId}`);
  }

  private async readSessionContextId(contextId: string): Promise<ContextReadRow> {
    const session = await this.getSessionRow(parseSessionContextId(contextId));
    const title = trimText(session.title);
    const summary = trimText(session.summary) ?? '';
    return {
      contextId,
      title,
      content: `# ${title ?? session.latestSnapshotId}\n\n${summary}`,
    };
  }

  private async readTurnContextId(contextId: string): Promise<ContextReadRow> {
    const memoryId = parseTurnContextId(contextId);
    const turn = await getTurn(this.client, memoryId);
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

  private async getSessionRow(identity: SessionIdentity): Promise<SessionRow> {
    const rows = await this.client.sessionTable.get({ identities: [identity] });
    const row = rows[0];
    if (!row) {
      throw new Error(`session context not found: ${sessionContextId(identity)}`);
    }
    return row;
  }

  private async renderSourceProvenance(references: string[]): Promise<string> {
    const sections: string[] = [];
    for (const ref of references) {
      const memoryId = turnMemoryId(ref);
      if (!memoryId) {
        continue;
      }
      const turn = await getTurn(this.client, memoryId);
      if (!turn) {
        continue;
      }
      sections.push([
        `### ${turnContextId(memoryId)}`,
        '',
        renderTurnDetail(turn) ?? '(no readable turn content)',
      ].join('\n'));
    }
    return sections.length > 0 ? sections.join('\n\n') : '_No source turn provenance found._';
  }
}

function isExpectedContextReadError(error: unknown): error is Error {
  if (!(error instanceof Error)) {
    return false;
  }
  return [
    'unsupported context id:',
    'invalid session context id:',
    'invalid memory id:',
    'invalid memory id layer:',
    'session context not found:',
    'turn context not found:',
    'turn context has no readable content:',
  ].some((prefix) => error.message.startsWith(prefix));
}

function renderTurnContextMarkdown(contextId: string, memory: RenderedMemory): string {
  const sections = [`# ${contextId}`];
  sections.push('', '## Created At', '', memory.createdAt);
  sections.push('', '## Updated At', '', memory.updatedAt);
  if (memory.detail) {
    sections.push('', '## Detail', '', memory.detail);
  }
  return sections.join('\n');
}
