import type { NativeTables } from '../native.js';
import type { SessionTurn, TurnContent } from '../client.js';
import { buildSessionUpdate } from './update.js';
import { cloneTurn, readSessionTurn, serializeSessionTurn, type SessionUpdate, type TurnMetadataSource } from './types.js';
import { hasText, normalizeSessionId, sessionKey } from './key.js';

const PENDING_TURN_ID = 'session:18446744073709551615';
type SessionTurnWithSource = SessionTurn & {
  titleSource?: TurnMetadataSource | null;
  summarySource?: TurnMetadataSource | null;
};

export class Session {
  private openTurn?: SessionTurn;
  private lastUsedAt = Date.now();
  private acceptQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly client: NativeTables,
    private readonly config: {
      sessionId?: string;
      agent: string;
      observer: string;
      openTurn?: SessionTurn;
    },
  ) {
    this.openTurn = config.openTurn ? cloneTurn(config.openTurn) : undefined;
    this.config.sessionId = normalizeSessionId(this.config.sessionId);
  }

  previewPrompt(incoming?: string): string | undefined {
    return mergePrompt(this.openTurn?.prompt, incoming);
  }

  async accept(content: TurnContent, observingEpoch: number): Promise<SessionTurn> {
    return this.runAcceptExclusive(async () => {
      this.touch();
      const update = await buildSessionUpdate(this, content, this.config.observer, observingEpoch);
      let turn = this.openTurn ? cloneTurn(this.openTurn) : newPendingTurn(this.config);
      turn = applyUpdate(turn, update);
      const rows = this.openTurn
        ? await this.client.sessionTable.update({
          turns: [serializeSessionTurn(turn)],
        })
        : await this.client.sessionTable.insert({
        turns: [serializeSessionTurn(turn)],
      });
      const persisted = readSessionTurn(rows[0]);
      this.openTurn = isOpen(persisted) ? cloneTurn(persisted) : undefined;
      this.touch();
      return persisted;
    });
  }

  touch(): void {
    this.lastUsedAt = Date.now();
  }

  expired(ttlMs: number): boolean {
    return Date.now() - this.lastUsedAt > ttlMs;
  }

  private async runAcceptExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.acceptQueue;
    let releaseCurrent: (() => void) | undefined;
    this.acceptQueue = new Promise((resolve) => {
      releaseCurrent = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      releaseCurrent?.();
    }
  }
}

function newPendingTurn(config: { sessionId?: string; agent: string; observer: string }): SessionTurn {
  const now = new Date().toISOString();
  return {
    turnId: PENDING_TURN_ID,
    createdAt: now,
    updatedAt: now,
    sessionId: normalizeSessionId(config.sessionId) ?? null,
    agent: config.agent,
    observer: config.observer,
  };
}

function applyUpdate(turn: SessionTurn, update: SessionUpdate): SessionTurn {
  const next = cloneTurn(turn);
  const nextWithSource = next as SessionTurnWithSource;
  const currentKey = sessionKey(next.sessionId ?? undefined, next.agent, next.observer);
  const incomingKey = sessionKey(update.sessionId, update.agent, update.observer);
  if (currentKey !== incomingKey) {
    throw new Error('message session does not match open turn');
  }

  if (hasText(update.title)) {
    const currentSource = nextWithSource.titleSource ?? undefined;
    const shouldReplaceTitle = !hasText(next.title) || sourceRank(update.titleSource) >= sourceRank(currentSource);
    if (shouldReplaceTitle) {
      next.title = update.title;
      nextWithSource.titleSource = update.titleSource;
    }
  }

  if (hasText(update.summary)) {
    const currentSource = nextWithSource.summarySource ?? undefined;
    const shouldReplaceSummary = !hasText(next.summary) || sourceRank(update.summarySource) >= sourceRank(currentSource);
    if (shouldReplaceSummary) {
      next.summary = update.summary;
      nextWithSource.summarySource = update.summarySource;
    }
  }

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

export function isObservable(turn: SessionTurn): boolean {
  return hasText(turn.response) && hasText(turn.summary);
}

function isOpen(turn: SessionTurn): boolean {
  return !hasText(turn.response);
}
