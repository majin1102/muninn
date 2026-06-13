import type { NativeTables } from './native.js';
import type { ListModeInput, Turn } from './backend.js';
import { normalizeSessionId } from './turn/key.js';
import { readTurn } from './turn/types.js';
import { assertMemoryIdLayer } from './memory-id.js';

export async function getTurn(
  client: NativeTables,
  memoryId: string,
): Promise<Turn | null> {
  assertMemoryIdLayer(memoryId, 'turn');
  const turn = await client.turnTable.getTurn(memoryId);
  return turn ? readTurn(turn) : null;
}

export async function listTurns(
  client: NativeTables,
  params: { mode: ListModeInput; agent?: string; sessionId?: string },
): Promise<Turn[]> {
  const turns = await client.turnTable.listTurns({
    mode: params.mode,
    agent: params.agent,
    sessionId: normalizeSessionId(params.sessionId),
  });
  return turns.map(readTurn);
}

export async function timelineTurns(
  client: NativeTables,
  params: { memoryId: string; beforeLimit?: number; afterLimit?: number },
): Promise<Turn[]> {
  assertMemoryIdLayer(params.memoryId, 'turn');
  const turns = await client.turnTable.timelineTurns({
    memoryId: params.memoryId,
    beforeLimit: params.beforeLimit,
    afterLimit: params.afterLimit,
  });
  return turns.map(readTurn);
}
