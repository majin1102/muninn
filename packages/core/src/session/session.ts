import type { CoreBinding } from '../native.js';
import type { SessionMessageInput } from '../client.js';
import type { Window } from '../observer/window.js';
import { buildSessionUpdate } from './update.js';
import { cloneTurn, fromWireTurn, toWireTurn, type SessionTurnRow, type SessionUpdate, type TurnMetadataSource } from './types.js';
import { hasText, sessionKey } from './key.js';

const PENDING_TURN_ID = 'session:18446744073709551615';

export class Session {
  private openTurn?: SessionTurnRow;
  private lastUsedAt = Date.now();

  constructor(
    private readonly client: CoreBinding,
    private readonly config: {
      sessionId?: string;
      agent: string;
      observer: string;
      openTurn?: SessionTurnRow;
    },
  ) {
    this.openTurn = config.openTurn ? cloneTurn(config.openTurn) : undefined;
  }

  previewPrompt(incoming?: string): string | undefined {
    return mergePrompt(this.openTurn?.prompt, incoming);
  }

  async accept(content: SessionMessageInput, window: Window): Promise<SessionTurnRow> {
    this.touch();
    const update = await buildSessionUpdate(this, content, this.config.observer, window.epoch);
    let turn = this.openTurn ? cloneTurn(this.openTurn) : newPendingTurn(this.config);
    turn = applyUpdate(turn, update);
    const rows = await this.client.sessionUpsert({
      turns: [toWireTurn(turn)],
    });
    const persisted = fromWireTurn(rows[0]);
    this.openTurn = isOpen(persisted) ? cloneTurn(persisted) : undefined;
    this.touch();
    return persisted;
  }

  touch(): void {
    this.lastUsedAt = Date.now();
  }

  expired(ttlMs: number): boolean {
    return Date.now() - this.lastUsedAt > ttlMs;
  }
}

function newPendingTurn(config: { sessionId?: string; agent: string; observer: string }): SessionTurnRow {
  const now = new Date().toISOString();
  return {
    turnId: PENDING_TURN_ID,
    createdAt: now,
    updatedAt: now,
    sessionId: config.sessionId ?? null,
    agent: config.agent,
    observer: config.observer,
  };
}

function applyUpdate(turn: SessionTurnRow, update: SessionUpdate): SessionTurnRow {
  const next = cloneTurn(turn);
  const currentKey = sessionKey(next.sessionId ?? undefined, next.agent, next.observer);
  const incomingKey = sessionKey(update.sessionId, update.agent, update.observer);
  if (currentKey !== incomingKey) {
    throw new Error('message session does not match open turn');
  }
  mergeMetadataField(next, 'title', 'titleSource', update.title, update.titleSource);
  mergeMetadataField(next, 'summary', 'summarySource', update.summary, update.summarySource);
  next.prompt = mergePrompt(next.prompt, update.prompt);
  if (hasText(update.response)) {
    next.response = update.response;
  }
  next.toolCalling = mergeToolCalling(next.toolCalling, update.toolCalling);
  next.artifacts = mergeArtifacts(next.artifacts, update.artifacts);
  next.updatedAt = new Date().toISOString();
  if (isObservable(next)) {
    next.observingEpoch = update.observingEpoch;
  }
  return next;
}

function mergeMetadataField(
  turn: SessionTurnRow,
  field: 'title' | 'summary',
  sourceField: 'titleSource' | 'summarySource',
  incoming: string | undefined,
  incomingSource: TurnMetadataSource | undefined,
) {
  if (!hasText(incoming)) {
    return;
  }
  const currentValue = turn[field] ?? undefined;
  const currentSource = turn[sourceField] ?? undefined;
  const shouldReplace = !hasText(currentValue) || sourceRank(incomingSource) >= sourceRank(currentSource);
  if (shouldReplace) {
    turn[field] = incoming;
    turn[sourceField] = incomingSource;
  }
}

function sourceRank(source: TurnMetadataSource | undefined): number {
  switch (source) {
    case 'fallback':
      return 0;
    case 'generated':
      return 1;
    case 'user':
      return 2;
    default:
      return -1;
  }
}

function mergePrompt(current?: string | null, incoming?: string): string | undefined {
  const currentText = hasText(current) ? current.trim() : undefined;
  const incomingText = hasText(incoming) ? incoming.trim() : undefined;
  if (currentText && incomingText) {
    return currentText === incomingText ? currentText : `${currentText}\n\n${incomingText}`;
  }
  return currentText ?? incomingText;
}

function mergeToolCalling(current?: string[] | null, incoming?: string[]): string[] | undefined {
  if (!incoming || incoming.length === 0) {
    return current ?? undefined;
  }
  return [...(current ?? []), ...incoming];
}

function mergeArtifacts(
  current?: Record<string, string> | null,
  incoming?: Record<string, string>,
): Record<string, string> | undefined {
  if (!incoming || Object.keys(incoming).length === 0) {
    return current ?? undefined;
  }
  return {
    ...(current ?? {}),
    ...incoming,
  };
}

export function isObservable(turn: SessionTurnRow): boolean {
  return hasText(turn.response) && hasText(turn.summary);
}

function isOpen(turn: SessionTurnRow): boolean {
  return !hasText(turn.response);
}
