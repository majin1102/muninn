import type {
  ListModeInput,
  NativeTables,
  ExtractionRow as Extraction,
  SessionSnapshotRow,
  TurnRow,
} from '../native.js';
import { embedText } from '../llm/embedding-provider.js';
import { generateText } from '../llm/provider.js';
import { loadPromptTemplate, renderPromptTemplate } from '../llm/prompts.js';
import { getRecallConfig, parseRecallMode, type RecallMode } from '../config.js';
import { readTurnRow, sessionKey as buildSessionKey, normalizeSessionId } from '../pipeline/ingest.js';

export type { RecallMode };

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
  if (layer !== 'extraction' || !id || extra !== undefined) {
    throw new Error(`invalid extraction memory id: ${memoryId}`);
  }
  return id;
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
  if (memoryId.startsWith('extraction:')) {
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
    memoryId: `extraction:${memory.id}`,
    title: memory.title,
    summary: memory.summary,
    detail,
    createdAt: memory.createdAt,
    updatedAt: memory.createdAt,
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
  return client.sessionTable.getSnapshot(memoryId);
}

export async function listSessionSnapshotRows(
  client: NativeTables,
  params: { mode: ListModeInput; extractor?: string },
): Promise<SessionSnapshotRow[]> {
  const rows = await client.sessionTable.listSnapshots({
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
  const snapshots = await client.sessionTable.threadSnapshots(anchor.sessionId);
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
  mode?: RecallMode;
  budget?: number;
  queryLimit?: number;
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
  const mode = parseRecallMode(options.mode ?? getRecallConfig().mode);
  const vector = mode === 'fts'
    ? []
    : await (options.embed ?? embedText)(trimmed);
  const extractionRows = await client.extractionTable.search({
    query: trimmed,
    vector,
    limit: queryLimit,
    mode,
  });
  const hits = await Promise.all(extractionRows.map((row) => extractionHit(client, row)));
  if (budget > 0) {
    if (hits.length === 0) {
      return [];
    }
    const candidates = extractionRows.map((row) => ({
      memoryId: `extraction:${row.id}`,
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
    memoryId: `extraction:${row.id}`,
    title: row.title,
    summary: row.summary,
    content: row.content,
    references: row.turnRefs,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...await ownershipFromTurnRefs(client, row.turnRefs),
  };
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
  const snapshots = typeof client.sessionTable?.threadSnapshots === 'function'
    ? await client.sessionTable.threadSnapshots(sessionId).catch(() => [])
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
    if (memoryId.startsWith('extraction:')) {
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
    options?: { mode?: RecallMode; budget?: number; queryLimit?: number },
  ): Promise<RecallHit[]> {
    return recallMemories(this.client, query, limit, options);
  }
}
