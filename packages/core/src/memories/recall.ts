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
  const [observationRows, extractionRows] = await Promise.all([
    client.observationTable.search({
      query: trimmed,
      vector,
      limit: queryLimit,
      mode,
    }),
    client.extractionTable.search({
      query: trimmed,
      vector,
      limit: queryLimit,
      mode,
    }),
  ]);
  const curatedHits: RouteHit[] = observationRows.map((row) => ({
    route: 'curated',
    memoryId: `observation:${row.id}`,
    text: row.text,
    references: row.references,
  }));
  const rawHits: RouteHit[] = extractionRows.map((row) => ({
    route: 'raw',
    memoryId: `extraction:${row.id}`,
    text: row.text,
    references: row.references,
  }));
  const merged = mergeRoutes(curatedHits, rawHits, budget > 0 ? queryLimit : limit);
  if (budget > 0) {
    if (merged.length === 0) {
      return [];
    }
    const extractionById = new Map(extractionRows.map((row) => [`extraction:${row.id}`, row]));
    const observationById = new Map(observationRows.map((row) => [`observation:${row.id}`, row]));
    const candidates = merged.map((hit) => {
      if (hit.route === 'curated') {
        const row = observationById.get(hit.memoryId);
        if (!row) {
          throw new Error(`missing recalled observation row: ${hit.memoryId}`);
        }
        return {
          memoryId: hit.memoryId,
          content: row.text,
          refs: row.references,
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
        refs: row.references,
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
      references: uniqueRefs(candidates.flatMap((candidate) => candidate.refs)),
    }];
  }
  return merged.slice(0, limit).map(({ route: _route, ...hit }) => hit);
}

export type { RecallMode };

function curatedQuota(limit: number): number {
  return Math.ceil(limit * 0.7);
}

function coveredExtractionIds(hits: RouteHit[]): Set<string> {
  const covered = new Set<string>();
  for (const hit of hits) {
    if (hit.route !== 'curated') {
      continue;
    }
    for (const ref of hit.references ?? []) {
      if (ref.startsWith('extraction:')) {
        covered.add(ref);
      }
    }
  }
  return covered;
}

function mergeRoutes(curated: RouteHit[], raw: RouteHit[], limit: number): RouteHit[] {
  if (limit <= 0) {
    return [];
  }
  const firstCurated = curated.slice(0, curatedQuota(limit));
  const covered = coveredExtractionIds(firstCurated);
  const rawFallback = raw.filter((hit) => !covered.has(hit.memoryId));
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
