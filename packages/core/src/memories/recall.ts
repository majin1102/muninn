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
  const leafGlobalObservationIds = await loadLeafGlobalObservationIds(client);
  const observationLimit = leafGlobalObservationIds ? queryLimit * 4 : queryLimit;
  const [observationRows, extractionRows] = await Promise.all([
    client.globalObservationTable.search({
      query: trimmed,
      vector,
      limit: observationLimit,
      mode,
    }),
    client.sessionObservationTable.search({
      query: trimmed,
      vector,
      limit: queryLimit,
      mode,
    }),
  ]);
  const filteredGlobalObservationRows = leafGlobalObservationIds
    ? observationRows.filter((row) => leafGlobalObservationIds.has(row.id))
    : observationRows;
  const observationRefs = await loadGlobalObservationContextRefs(client, filteredGlobalObservationRows.map((row) => row.id));
  const extractionDetails = await loadSessionObservationDetails(
    client,
    filteredGlobalObservationRows.flatMap((row) => row.sessionObservationRefs),
  );
  const curatedHits: RouteHit[] = filteredGlobalObservationRows.map((row) => ({
    route: 'curated',
    memoryId: `global_observation:${row.id}`,
    text: renderGlobalObservationHit(row.text, row.sessionObservationRefs, extractionDetails),
    references: observationRefs.get(row.id) ?? row.sessionObservationRefs,
  }));
  const rawHits: RouteHit[] = extractionRows.map((row) => ({
    route: 'raw',
    memoryId: `session_observation:${row.id}`,
    text: row.content,
    references: row.turnRefs,
  }));
  const merged = mergeRoutes(curatedHits, rawHits, budget > 0 ? queryLimit : limit);
  if (budget > 0) {
    if (merged.length === 0) {
      return [];
    }
    const extractionById = new Map(extractionRows.map((row) => [`session_observation:${row.id}`, row]));
    const observationById = new Map(observationRows.map((row) => [`global_observation:${row.id}`, row]));
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
      text: recalled.content,
      references: uniqueRefs(candidates.flatMap((candidate) => candidate.refs ?? [])),
    }];
  }
  return merged.slice(0, limit).map(({ route: _route, ...hit }) => hit);
}

export type { RecallMode };

type SessionObservationDetail = {
  id: string;
  title: string;
  summary: string;
  content: string;
};

async function loadSessionObservationDetails(
  client: NativeTables,
  refs: string[],
): Promise<Map<string, SessionObservationDetail>> {
  const ids = uniqueRefs(refs.map((ref) => extractionRowId(ref)).filter((id): id is string => Boolean(id)));
  if (ids.length === 0 || typeof client.sessionObservationTable.get !== 'function') {
    return new Map();
  }
  const rows = await client.sessionObservationTable.get({ ids });
  return new Map(rows.map((row) => [row.id, row]));
}

async function loadGlobalObservationContextRefs(
  client: NativeTables,
  ids: string[],
): Promise<Map<string, string[]>> {
  const uniqueIds = uniqueRefs(ids);
  if (uniqueIds.length === 0 || typeof client.globalObservationContextTable?.get !== 'function') {
    return new Map();
  }
  const rows = await client.globalObservationContextTable.get({ ids: uniqueIds });
  return new Map(rows.map((row) => [
    row.id,
    uniqueRefs(row.sourceRefs ?? []),
  ]));
}

function renderGlobalObservationHit(
  text: string,
  refs: string[],
  details: Map<string, SessionObservationDetail>,
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
  details: Map<string, SessionObservationDetail>,
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
  details: Map<string, SessionObservationDetail>,
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
      return `${prefix}session_observation: ${formatInlineBlock(detail.content, continuationPrefix)}`;
    },
  );
}

function formatInlineBlock(text: string, prefix: string): string {
  return text.trim().split('\n').map((line, index) => (
    index === 0 ? line.trim() : `${prefix}${line.trim()}`
  )).join('\n');
}

async function loadLeafGlobalObservationIds(client: NativeTables): Promise<Set<string> | null> {
  try {
    const contexts = await client.globalObservationContextTable.list({});
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

function sourceSessionObservationIds(hits: RouteHit[]): Set<string> {
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
  return trimmed.startsWith('session_observation:') ? trimmed.slice('session_observation:'.length).trim() || null : trimmed;
}

function extractionMemoryId(ref: string): string | null {
  const id = extractionRowId(ref);
  return id ? `session_observation:${id}` : null;
}

function mergeRoutes(curated: RouteHit[], raw: RouteHit[], limit: number): RouteHit[] {
  if (limit <= 0) {
    return [];
  }
  const firstCurated = curated.slice(0, curatedQuota(limit));
  const sourceIds = sourceSessionObservationIds(firstCurated);
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
