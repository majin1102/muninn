import type { NativeTables } from '../native.js';
import type { RecallHit } from '../client.js';
import { embedText } from '../llm/embedding-provider.js';

export async function recallMemories(
  client: NativeTables,
  query: string,
  limit = 10,
): Promise<RecallHit[]> {
  if (!query.trim() || limit <= 0) {
    return [];
  }
  const vector = await embedText(query.trim());
  const rows = await client.observationTable.nearest({
    vector,
    limit,
  });
  return rows.slice(0, limit).map((row) => ({
    memoryId: `observation:${row.id}`,
    text: row.text,
  }));
}
