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
  const rows = await client.extractionTable.search({
    query: trimmed,
    vector,
    limit: queryLimit,
    mode,
  });
  if (budget > 0) {
    if (rows.length === 0) {
      return [];
    }
    const candidates = rows.map((row) => ({
      memoryId: `extraction:${row.id}`,
      content: row.text,
      context: row.context,
      anchors: row.anchors,
      refs: row.references,
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
      text: recalled.content,
      references: uniqueRefs(candidates.flatMap((candidate) => candidate.refs)),
    }];
  }
  return rows.slice(0, limit).map((row) => ({
    memoryId: `extraction:${row.id}`,
    text: row.text,
    references: row.references,
  }));
}

export type { RecallMode };

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
