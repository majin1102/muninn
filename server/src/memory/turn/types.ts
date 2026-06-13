import type { Turn } from '../backend.js';
import { normalizeSessionId } from './key.js';

type TurnPayload = Turn & { session_id?: string | null };

export function readTurn(turn: Turn): Turn {
  const payload = turn as TurnPayload;
  const sessionId = normalizeSessionId(turn.sessionId ?? payload.session_id);
  return {
    turnId: turn.turnId,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
    sessionId: sessionId ?? null,
    project: turn.project,
    cwd: turn.cwd,
    agent: turn.agent,
    observer: turn.observer,
    title: turn.title,
    summary: turn.summary,
    events: turn.events ?? [],
    artifacts: turn.artifacts,
    metadata: turn.metadata,
    prompt: turn.prompt,
    response: turn.response,
    observingEpoch: turn.observingEpoch,
  } as Turn;
}

export function serializeTurn(turn: Turn): Record<string, unknown> {
  const payload = turn as TurnPayload;
  const sessionId = normalizeSessionId(turn.sessionId);
  return {
    turnId: turn.turnId,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
    session_id: sessionId ?? null,
    project: turn.project,
    cwd: turn.cwd,
    agent: turn.agent,
    observer: turn.observer,
    title: turn.title ?? null,
    summary: turn.summary ?? null,
    events: turn.events,
    artifacts: turn.artifacts ?? null,
    metadata: turn.metadata ?? null,
    prompt: turn.prompt ?? null,
    response: turn.response ?? null,
    observingEpoch: turn.observingEpoch ?? null,
  };
}
