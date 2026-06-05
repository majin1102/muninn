import type { NativeTables, GlobalObservation } from '../native.js';

export function parseGlobalObservationMemoryId(memoryId: string): string {
  const prefix = 'global_observation:';
  if (!memoryId.startsWith(prefix)) {
    throw new Error(`invalid global observation memory id: ${memoryId}`);
  }
  const id = memoryId.slice(prefix.length);
  if (!id) {
    throw new Error(`invalid global observation memory id: ${memoryId}`);
  }
  return id;
}

export async function getGlobalObservation(
  client: NativeTables,
  memoryId: string,
): Promise<GlobalObservation | null> {
  const id = parseGlobalObservationMemoryId(memoryId);
  const rows = await client.globalObservationTable.get({ ids: [id] });
  return rows[0] ?? null;
}
