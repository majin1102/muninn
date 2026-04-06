import type { SessionTurnRecord } from '../client.js';

export type TurnMetadataSource = 'fallback' | 'generated' | 'user';

export type SessionTurnRow = {
  turnId: string;
  createdAt: string;
  updatedAt: string;
  sessionId?: string | null;
  agent: string;
  observer: string;
  title?: string | null;
  summary?: string | null;
  titleSource?: TurnMetadataSource | null;
  summarySource?: TurnMetadataSource | null;
  toolCalling?: string[] | null;
  artifacts?: Record<string, string> | null;
  prompt?: string | null;
  response?: string | null;
  observingEpoch?: number | null;
};

export type SessionUpdate = {
  sessionId?: string;
  agent: string;
  observer: string;
  title?: string;
  summary?: string;
  titleSource?: TurnMetadataSource;
  summarySource?: TurnMetadataSource;
  toolCalling?: string[];
  artifacts?: Record<string, string>;
  prompt?: string;
  response?: string;
  observingEpoch?: number;
};

export function fromWireTurn(turn: SessionTurnRecord): SessionTurnRow {
  return {
    turnId: turn.turnId,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
    sessionId: turn.session_id,
    agent: turn.agent,
    observer: turn.observer,
    title: turn.title,
    summary: turn.summary,
    toolCalling: turn.toolCalling,
    artifacts: turn.artifacts,
    prompt: turn.prompt,
    response: turn.response,
    observingEpoch: turn.observingEpoch,
  };
}

export function toWireTurn(turn: SessionTurnRow): Record<string, unknown> {
  return {
    turnId: turn.turnId,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
    session_id: turn.sessionId ?? null,
    agent: turn.agent,
    observer: turn.observer,
    title: turn.title ?? null,
    summary: turn.summary ?? null,
    titleSource: turn.titleSource ?? null,
    summarySource: turn.summarySource ?? null,
    toolCalling: turn.toolCalling ?? null,
    artifacts: turn.artifacts ?? null,
    prompt: turn.prompt ?? null,
    response: turn.response ?? null,
    observingEpoch: turn.observingEpoch ?? null,
  };
}

export function toPublicTurn(turn: SessionTurnRow): SessionTurnRecord {
  return {
    turnId: turn.turnId,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
    session_id: turn.sessionId ?? null,
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

export function cloneTurn(turn: SessionTurnRow): SessionTurnRow {
  return {
    ...turn,
    toolCalling: turn.toolCalling ? [...turn.toolCalling] : turn.toolCalling,
    artifacts: turn.artifacts ? { ...turn.artifacts } : turn.artifacts,
  };
}
