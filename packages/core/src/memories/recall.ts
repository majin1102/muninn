import type { CoreBinding } from '../native.js';
import type { RecallHit } from '../client.js';
import { embedText } from '../llm/embedding-provider.js';

type SemanticIndexRow = {
  id: string;
  memoryId: string;
  text: string;
  vector: number[];
  importance: number;
  category: string;
  createdAt: string;
};

type CandidateGroup = {
  memoryId: string;
  bestText: string;
  reciprocalRankScore: number;
  hitCount: number;
  bestRank: number;
  maxImportance: number;
  newestCreatedAt: string;
};

export async function recallMemories(
  client: CoreBinding,
  query: string,
  limit = 10,
): Promise<RecallHit[]> {
  if (!query.trim() || limit <= 0) {
    return [];
  }
  const vector = await embedText(query.trim());
  let fetchLimit = Math.max(limit * 4, limit);
  let groups: CandidateGroup[] = [];

  while (true) {
    const rows = await client.semanticIndexTable.nearest({
      vector,
      limit: fetchLimit,
    });
    groups = mergeSemanticCandidates(rows);
    if (groups.length >= limit || rows.length < fetchLimit) {
      break;
    }
    fetchLimit *= 2;
  }

  return groups.slice(0, limit).map((group) => ({
    memoryId: group.memoryId,
    text: group.bestText,
  }));
}

function mergeSemanticCandidates(rows: SemanticIndexRow[]): CandidateGroup[] {
  const merged = new Map<string, CandidateGroup>();
  rows.forEach((row, index) => {
    const rankScore = 1 / (index + 1);
    const current = merged.get(row.memoryId);
    if (!current) {
      merged.set(row.memoryId, {
        memoryId: row.memoryId,
        bestText: row.text,
        reciprocalRankScore: rankScore,
        hitCount: 1,
        bestRank: index,
        maxImportance: row.importance,
        newestCreatedAt: row.createdAt,
      });
      return;
    }
    current.reciprocalRankScore += rankScore;
    current.hitCount += 1;
    if (index < current.bestRank) {
      current.bestRank = index;
      current.bestText = row.text;
    }
    current.maxImportance = Math.max(current.maxImportance, row.importance);
    if (row.createdAt > current.newestCreatedAt) {
      current.newestCreatedAt = row.createdAt;
    }
  });

  return [...merged.values()].sort((left, right) => (
    right.reciprocalRankScore - left.reciprocalRankScore
    || right.hitCount - left.hitCount
    || left.bestRank - right.bestRank
    || right.maxImportance - left.maxImportance
    || right.newestCreatedAt.localeCompare(left.newestCreatedAt)
  ));
}
