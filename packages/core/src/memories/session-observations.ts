import type { NativeTables, SessionObservation } from '../native.js';

export function parseSessionObservationMemoryId(memoryId: string): string {
  const [layer, id, extra] = memoryId.split(':');
  if (layer !== 'session_observation' || !id || extra !== undefined) {
    throw new Error(`invalid session observation memory id: ${memoryId}`);
  }
  return id;
}

export async function getSessionObservation(
  client: NativeTables,
  memoryId: string,
): Promise<SessionObservation | null> {
  const id = parseSessionObservationMemoryId(memoryId);
  const rows = await client.sessionObservationTable.get({ ids: [id] });
  return rows[0] ?? null;
}
