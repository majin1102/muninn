import type { NativeTables, Observation } from '../native.js';

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
