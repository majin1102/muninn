import type { Extraction, NativeTables } from '../native.js';
import type { RecallHit, Turn } from '../backend.js';
import { embedText } from '../llm/embedding-provider.js';
import { getRecallConfig, parseRecallMode, type RecallMode } from '../config.js';
import { sessionKey as buildSessionKey } from '../turn/key.js';
import { readTurn } from '../turn/types.js';
import {
  recallMemoryContext,
  validateMemoryRecallResult,
  type MemoryRecallInput,
  type MemoryRecallResult,
} from './memory-recaller.js';

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

export type { RecallMode };

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
      const turn = readTurn(rawTurn);
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

async function displaySession(client: NativeTables, turn: Turn): Promise<string> {
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
