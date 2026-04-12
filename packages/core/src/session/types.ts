import type { SessionTurn } from '../client.js';
import { normalizeSessionId } from './key.js';

type SessionTurnPayload = SessionTurn & { session_id?: string | null };

export type SessionUpdate = {
  sessionId?: string;
  agent: string;
  observer: string;
  title?: string;
  summary?: string;
  toolCalling?: string[];
  artifacts?: Record<string, string>;
  prompt?: string;
  response?: string;
  observingEpoch?: number;
};

export function readSessionTurn(turn: SessionTurn): SessionTurn {
  const payload = turn as SessionTurnPayload;
  const sessionId = normalizeSessionId(turn.sessionId ?? payload.session_id);
  return {
    turnId: turn.turnId,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
    sessionId: sessionId ?? null,
    agent: turn.agent,
    observer: turn.observer,
    title: turn.title,
    summary: turn.summary,
    toolCalling: turn.toolCalling,
    artifacts: turn.artifacts,
    prompt: turn.prompt,
    response: turn.response,
    observingEpoch: turn.observingEpoch,
  } as SessionTurn;
}

export function serializeSessionTurn(turn: SessionTurn): Record<string, unknown> {
  const payload = turn as SessionTurnPayload;
  const sessionId = normalizeSessionId(turn.sessionId);
  return {
    turnId: turn.turnId,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
    session_id: sessionId ?? null,
    agent: turn.agent,
    observer: turn.observer,
    title: turn.title ?? null,
    summary: turn.summary ?? null,
    toolCalling: turn.toolCalling ?? null,
    artifacts: turn.artifacts ?? null,
    prompt: turn.prompt ?? null,
    response: turn.response ?? null,
    observingEpoch: turn.observingEpoch ?? null,
  };
}

export function toSessionTurn(turn: SessionTurn): SessionTurn {
  const sessionId = normalizeSessionId(turn.sessionId);
  return {
    turnId: turn.turnId,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
    sessionId: sessionId ?? null,
    agent: turn.agent,
    observer: turn.observer,
    title: turn.title ?? null,
    summary: turn.summary ?? null,
    toolCalling: turn.toolCalling ?? null,
    artifacts: turn.artifacts ?? null,
    prompt: turn.prompt ?? null,
    response: turn.response ?? null,
    observingEpoch: turn.observingEpoch ?? null,
  };
}

export function cloneTurn<T extends SessionTurn>(turn: T): T {
  return {
    ...turn,
    toolCalling: turn.toolCalling ? [...turn.toolCalling] : turn.toolCalling,
    artifacts: turn.artifacts ? { ...turn.artifacts } : turn.artifacts,
  } as T;
}
