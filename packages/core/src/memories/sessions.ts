import type { CoreBinding } from '../native.js';
import type { ListModeInput, SessionTurnRecord } from '../client.js';
import { fromWireTurn, toPublicTurn, type SessionTurnRow } from '../session/types.js';
import { assertMemoryIdLayer } from './types.js';

export async function getSessionTurn(
  client: CoreBinding,
  memoryId: string,
): Promise<SessionTurnRecord | null> {
  assertMemoryIdLayer(memoryId, 'session');
  const turn = await client.sessionGetTurn(memoryId);
  return turn ? toPublicTurn(fromWireTurn(turn)) : null;
}

export async function listSessionTurns(
  client: CoreBinding,
  params: { mode: ListModeInput; agent?: string; sessionId?: string },
): Promise<SessionTurnRecord[]> {
  const turns = await client.sessionListTurns({
    mode: params.mode,
    agent: params.agent,
    sessionId: params.sessionId,
  });
  return turns.map((turn) => toPublicTurn(fromWireTurn(turn)));
}

export async function timelineSessionTurns(
  client: CoreBinding,
  params: { memoryId: string; beforeLimit?: number; afterLimit?: number },
): Promise<SessionTurnRow[]> {
  assertMemoryIdLayer(params.memoryId, 'session');
  const turns = await client.sessionTimelineTurns({
    memoryId: params.memoryId,
    beforeLimit: params.beforeLimit,
    afterLimit: params.afterLimit,
  });
  return turns.map(fromWireTurn);
}
