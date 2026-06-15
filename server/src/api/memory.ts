import type {
  ListModeInput,
  NativeTables,
  ExtractionRow as Extraction,
  ObservationRow as Observation,
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



export function parseObservationMemoryId(memoryId: string): string {
  const prefix = 'observation:';
  if (!memoryId.startsWith(prefix)) {
    throw new Error(`invalid observation memory id: ${memoryId}`);
  }
  const id = memoryId.slice(prefix.length);
  if (!id) {
    throw new Error(`invalid observation memory id: ${memoryId}`);
  }
  return id;
}

export async function getObservation(
  client: NativeTables,
  memoryId: string,
): Promise<Observation | null> {
  const id = parseObservationMemoryId(memoryId);
  const rows = await client.observationTable.get({ ids: [id] });
  return rows[0] ?? null;
}



export function inferRenderedMemoryKind(memoryId: string): 'turn' | 'session' | 'extraction' | 'observation' {
  if (memoryId.startsWith('turn:')) {
    return 'turn';
  }
  if (memoryId.startsWith('extraction:')) {
    return 'extraction';
  }
  if (memoryId.startsWith('observation:')) {
    return 'observation';
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

export function renderObservation(memory: Observation): RenderedMemory {
  const references = memory.extractionRefs.length > 0
    ? `References:\n${memory.extractionRefs.map((ref) => `- ${renderExtractionRef(ref)}`).join('\n')}`
    : undefined;
  return {
    memoryId: `observation:${memory.id}`,
    title: memory.text,
    summary: memory.text,
    detail: references,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}

function renderExtractionRef(ref: string): string {
  return ref.startsWith('extraction:') ? ref : `extraction:${ref}`;
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
  params: { mode: ListModeInput; agent?: string; sessionId?: string },
): Promise<TurnRow[]> {
  const turns = await client.turnTable.listTurns({
    mode: params.mode,
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
  params: { mode: ListModeInput; observer?: string },
): Promise<SessionSnapshotRow[]> {
  const rows = await client.sessionTable.listSnapshots({
    observer: params.observer,
  });
  return applyObservingListMode(rows, params.mode);
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

function applyObservingListMode(rows: SessionSnapshotRow[], mode: ListModeInput): SessionSnapshotRow[] {
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
      const raw = await generateText('observer', {
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
  includeObservations?: boolean;
  embed?: (text: string) => Promise<number[]>;
  recallMemory?: (input: MemoryRecallInput) => Promise<MemoryRecallResult>;
};

type RouteHit = RecallHit & {
  route: 'curated' | 'raw';
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
  const includeObservations = options.includeObservations !== false;
  const leafObservationIds = includeObservations ? await loadLeafObservationIds(client) : null;
  const observationLimit = leafObservationIds ? queryLimit * 4 : queryLimit;
  const [observationRows, extractionRows] = await Promise.all([
    includeObservations
      ? client.observationTable.search({
        query: trimmed,
        vector,
        limit: observationLimit,
        mode,
      })
      : Promise.resolve([]),
    client.extractionTable.search({
      query: trimmed,
      vector,
      limit: queryLimit,
      mode,
    }),
  ]);
  const filteredObservationRows = leafObservationIds
    ? observationRows.filter((row) => leafObservationIds.has(row.id))
    : observationRows;
  const observationRefs = await loadObservationContextRefs(client, filteredObservationRows.map((row) => row.id));
  const extractionDetails = await loadExtractionDetails(
    client,
    filteredObservationRows.flatMap((row) => row.extractionRefs),
  );
  const curatedHits: RouteHit[] = filteredObservationRows.map((row) => ({
    route: 'curated',
    memoryId: `observation:${row.id}`,
    title: row.text,
    summary: row.text,
    content: renderObservationHit(row.text, row.extractionRefs, extractionDetails),
    references: observationRefs.get(row.id) ?? row.extractionRefs,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
  const rawHits = await Promise.all(extractionRows.map(async (row) => ({
    ...(await extractionHit(client, row)),
    route: 'raw' as const,
  })));
  const merged = mergeRoutes(curatedHits, rawHits, budget > 0 ? queryLimit : limit);
  if (budget > 0) {
    if (merged.length === 0) {
      return [];
    }
    const extractionById = new Map(extractionRows.map((row) => [`extraction:${row.id}`, row]));
    const observationById = new Map(observationRows.map((row) => [`observation:${row.id}`, row]));
    const hitById = new Map(merged.map((hit) => [hit.memoryId, hit]));
    const candidates = merged.map((hit) => {
      if (hit.route === 'curated') {
        const row = observationById.get(hit.memoryId);
        if (!row) {
          throw new Error(`missing recalled observation row: ${hit.memoryId}`);
        }
        return {
          memoryId: hit.memoryId,
          content: hitById.get(hit.memoryId)?.content ?? row.text,
          refs: hit.references,
        };
      }
      const row = extractionById.get(hit.memoryId);
      if (!row) {
        throw new Error(`missing recalled extraction row: ${hit.memoryId}`);
      }
      return {
        memoryId: hit.memoryId,
        content: row.content,
        refs: row.turnRefs,
      };
    });
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
      ...hitMetadata(merged.find((hit) => hasSessionMetadata(hit))),
    }];
  }
  return merged.slice(0, limit).map(({ route: _route, ...hit }) => hit);
}


type ExtractionDetail = {
  id: string;
  title: string;
  summary: string;
  content: string;
  turnRefs: string[];
  createdAt: string;
  updatedAt: string;
};

async function loadExtractionDetails(
  client: NativeTables,
  refs: string[],
): Promise<Map<string, ExtractionDetail>> {
  const ids = uniqueRefs(refs.map((ref) => extractionRowId(ref)).filter((id): id is string => Boolean(id)));
  if (ids.length === 0 || typeof client.extractionTable.get !== 'function') {
    return new Map();
  }
  const rows = await client.extractionTable.get({ ids });
  return new Map(rows.map((row) => [row.id, row]));
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
        sessionKey: buildSessionKey(turn.sessionId ?? undefined, turn.agent, turn.observer, {
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

function hitMetadata(hit: RouteHit | undefined): Partial<RecallHit> {
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

function hasSessionMetadata(hit: RouteHit): boolean {
  return Boolean(hit.project && hit.agent && hit.cwd);
}

async function loadObservationContextRefs(
  client: NativeTables,
  ids: string[],
): Promise<Map<string, string[]>> {
  const uniqueIds = uniqueRefs(ids);
  if (uniqueIds.length === 0 || typeof client.observationContextTable?.get !== 'function') {
    return new Map();
  }
  const rows = await client.observationContextTable.get({ ids: uniqueIds });
  return new Map(rows.map((row) => [
    row.id,
    uniqueRefs(row.sourceRefs ?? []),
  ]));
}

function renderObservationHit(
  text: string,
  refs: string[],
  details: Map<string, ExtractionDetail>,
): string {
  const replaced = replaceSourcePlaceholders(text, details);
  const lines = [`OBSERVATION: ${replaced.text}`];
  for (const ref of refs) {
    const id = extractionRowId(ref);
    if (id && replaced.embeddedRefs.has(id)) {
      continue;
    }
    const detail = id ? details.get(id) : undefined;
    if (!detail) {
      continue;
    }
    lines.push(`EXTRACTION: ${detail.content}`);
  }
  return lines.join('\n');
}

function replaceSourcePlaceholders(
  text: string,
  details: Map<string, ExtractionDetail>,
): { text: string; embeddedRefs: Set<string> } {
  const lines = text.split('\n');
  const sourceIndex = lines.findIndex((line) => /^Source extractions:\s*$/i.test(line.trim()));
  if (sourceIndex < 0) {
    return { text, embeddedRefs: new Set() };
  }
  const embeddedRefs = new Set<string>();
  const replaced = lines.map((line, index) => (
    index > sourceIndex ? replaceSourceLine(line, details, embeddedRefs) : line
  )).join('\n');
  return { text: replaced, embeddedRefs };
}

function replaceSourceLine(
  line: string,
  details: Map<string, ExtractionDetail>,
  embeddedRefs: Set<string>,
): string {
  return line.replace(
    /^(\s*-\s*)\[([^\]]+)\](?:[^\S\r\n]+(.*\S))?\s*$/,
    (original, prefix: string, rawRefs: string, rewritten?: string) => {
      if (rewritten?.trim()) {
        return `${prefix}${rewritten.trim()}`;
      }
      const refs = rawRefs.split(',').map((ref) => ref.trim()).filter(Boolean);
      if (refs.length !== 1) {
        return original;
      }
      const id = extractionRowId(refs[0]!);
      const detail = id ? details.get(id) : undefined;
      if (!id || !detail) {
        return original;
      }
      embeddedRefs.add(id);
      const continuationPrefix = prefix.replace(/-\s*$/, '  ');
      return `${prefix}extraction: ${formatInlineBlock(detail.content, continuationPrefix)}`;
    },
  );
}

function formatInlineBlock(text: string, prefix: string): string {
  return text.trim().split('\n').map((line, index) => (
    index === 0 ? line.trim() : `${prefix}${line.trim()}`
  )).join('\n');
}

async function loadLeafObservationIds(client: NativeTables): Promise<Set<string> | null> {
  try {
    const contexts = await client.observationContextTable.list({});
    if (contexts.length === 0) {
      return null;
    }
    const parentIds = new Set(
      contexts
        .map((context) => context.parentId?.trim())
        .filter((id): id is string => Boolean(id)),
    );
    return new Set(contexts.filter((context) => !parentIds.has(context.id)).map((context) => context.id));
  } catch {
    return null;
  }
}

function curatedQuota(limit: number): number {
  return Math.ceil(limit * 0.7);
}

function sourceExtractionIds(hits: RouteHit[]): Set<string> {
  const sources = new Set<string>();
  for (const hit of hits) {
    if (hit.route !== 'curated') {
      continue;
    }
    for (const ref of hit.references ?? []) {
      const id = extractionMemoryId(ref);
      if (id) {
        sources.add(id);
      }
    }
  }
  return sources;
}

function extractionRowId(ref: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.startsWith('extraction:') ? trimmed.slice('extraction:'.length).trim() || null : trimmed;
}

function extractionMemoryId(ref: string): string | null {
  const id = extractionRowId(ref);
  return id ? `extraction:${id}` : null;
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

function mergeRoutes(curated: RouteHit[], raw: RouteHit[], limit: number): RouteHit[] {
  if (limit <= 0) {
    return [];
  }
  const firstCurated = curated.slice(0, curatedQuota(limit));
  const sourceIds = sourceExtractionIds(firstCurated);
  const rawFallback = raw.filter((hit) => !sourceIds.has(hit.memoryId));
  const rawQuota = limit - firstCurated.length;
  const selected = firstCurated.concat(rawFallback.slice(0, rawQuota));
  if (selected.length >= limit) {
    return selected.slice(0, limit);
  }
  const selectedIds = new Set(selected.map((hit) => hit.memoryId));
  for (const hit of curated.concat(rawFallback)) {
    if (selected.length >= limit) {
      break;
    }
    if (!selectedIds.has(hit.memoryId)) {
      selected.push(hit);
      selectedIds.add(hit.memoryId);
    }
  }
  return selected;
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
    observer?: string;
  }): Promise<SessionSnapshotRow[]> {
    return listSessionSnapshotRows(this.client, params);
  }

  async get(memoryId: string): Promise<RenderedMemory | null> {
    if (memoryId.startsWith('extraction:')) {
      const observation = await getExtraction(this.client, memoryId);
      return observation ? renderExtraction(observation) : null;
    }
    if (memoryId.startsWith('observation:')) {
      const observation = await getObservation(this.client, memoryId);
      return observation ? renderObservation(observation) : null;
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
    options?: { mode?: RecallMode; budget?: number; queryLimit?: number; includeObservations?: boolean },
  ): Promise<RecallHit[]> {
    return recallMemories(this.client, query, limit, options);
  }
}
