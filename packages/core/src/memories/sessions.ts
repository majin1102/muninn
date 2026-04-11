import type { NativeTables } from '../native.js';
import type { ListModeInput, SessionTurn } from '../client.js';
import { readSessionTurn, toSessionTurn } from '../session/types.js';
import { assertMemoryIdLayer } from './types.js';

export async function getSessionTurn(
  client: NativeTables,
  memoryId: string,
): Promise<SessionTurn | null> {
  assertMemoryIdLayer(memoryId, 'session');
  const turn = await client.sessionTable.getTurn(memoryId);
  return turn ? toSessionTurn(readSessionTurn(turn)) : null;
}

export async function listSessionTurns(
  client: NativeTables,
  params: { mode: ListModeInput; agent?: string; sessionId?: string },
): Promise<SessionTurn[]> {
  const turns = await client.sessionTable.listTurns({
    mode: params.mode,
    agent: params.agent,
    sessionId: params.sessionId,
  });
  return turns.map((turn) => toSessionTurn(readSessionTurn(turn)));
}

export async function timelineSessionTurns(
  client: NativeTables,
  params: { memoryId: string; beforeLimit?: number; afterLimit?: number },
): Promise<SessionTurn[]> {
  assertMemoryIdLayer(params.memoryId, 'session');
  const turns = await client.sessionTable.timelineTurns({
    memoryId: params.memoryId,
    beforeLimit: params.beforeLimit,
    afterLimit: params.afterLimit,
  });
  return turns.map(readSessionTurn);
}
