import type { NativeTables } from '../native.js';
import type { RecallHit } from '../client.js';
import { embedText } from '../llm/embedding-provider.js';
import { getRecallConfig, parseRecallMode, type RecallMode } from '../config.js';
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
  const leafObservationIds = await loadLeafObservationIds(client);
  const observationLimit = leafObservationIds ? queryLimit * 4 : queryLimit;
  const [observationRows, extractionRows] = await Promise.all([
    client.observationTable.search({
      query: trimmed,
      vector,
      limit: observationLimit,
      mode,
    }),
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
  const curatedHits: RouteHit[] = filteredObservationRows.map((row) => ({
    route: 'curated',
    memoryId: `observation:${row.id}`,
    text: `OBSERVATION: ${row.text}`,
    references: observationRefs.get(row.id)?.sourceRefs ?? row.extractionRefs,
  }));
  const rawHits: RouteHit[] = extractionRows.map((row) => ({
    route: 'raw',
    memoryId: `extraction:${row.id}`,
    text: row.text,
    references: row.turnRefs,
  }));
  const merged = mergeRoutes(curatedHits, rawHits, budget > 0 ? queryLimit : limit);
  if (budget > 0) {
    if (merged.length === 0) {
      return [];
    }
    const extractionById = new Map(extractionRows.map((row) => [`extraction:${row.id}`, row]));
    const observationById = new Map(observationRows.map((row) => [`observation:${row.id}`, row]));
    const curatedTextById = new Map(curatedHits.map((hit) => [hit.memoryId, hit.text]));
    const candidates = merged.map((hit) => {
      if (hit.route === 'curated') {
        const row = observationById.get(hit.memoryId);
        if (!row) {
          throw new Error(`missing recalled observation row: ${hit.memoryId}`);
        }
        return {
          memoryId: hit.memoryId,
          content: curatedTextById.get(hit.memoryId) ?? row.text,
          refs: hit.references ?? [],
        };
      }
      const row = extractionById.get(hit.memoryId);
      if (!row) {
        throw new Error(`missing recalled extraction row: ${hit.memoryId}`);
      }
      return {
        memoryId: hit.memoryId,
        content: row.text,
        context: row.context,
        anchors: row.anchors,
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
      text: recalled.content,
      references: uniqueRefs(candidates.flatMap((candidate) => candidate.refs ?? [])),
    }];
  }
  return merged.slice(0, limit).map(({ route: _route, ...hit }) => hit);
}

export type { RecallMode };

type ObservationRefs = {
  sourceRefs: string[];
  expandRefs: string[];
};

async function loadObservationContextRefs(
  client: NativeTables,
  ids: string[],
): Promise<Map<string, ObservationRefs>> {
  const uniqueIds = uniqueRefs(ids);
  if (uniqueIds.length === 0 || typeof client.observationContextTable?.get !== 'function') {
    return new Map();
  }
  const rows = await client.observationContextTable.get({ ids: uniqueIds });
  return new Map(rows.map((row) => [
    row.id,
    {
      sourceRefs: uniqueRefs(row.sourceRefs ?? []),
      expandRefs: uniqueRefs(row.expandRefs ?? []),
    },
  ]));
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
