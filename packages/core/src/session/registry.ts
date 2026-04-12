import type { NativeTables } from '../native.js';
import { Session } from './session.js';
import { hasText, normalizeSessionId, sessionKey } from './key.js';
import { readSessionTurn } from './types.js';

const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

type SessionEntry = {
  promise: Promise<Session>;
  resolved?: Session;
};

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(
    private readonly client: NativeTables,
    readonly observerName: string,
    private readonly lookupCheckpointTurnId?: (
      sessionId: string | undefined,
      agent: string,
    ) => string | undefined,
  ) {}

  async load(sessionId: string | undefined, agent: string): Promise<Session> {
    this.evictExpired();
    const normalizedSessionId = normalizeSessionId(sessionId);
    const key = sessionKey(normalizedSessionId, agent, this.observerName);
    const existing = this.sessions.get(key);
    if (existing) {
      const session = await existing.promise;
      session.touch();
      return session;
    }

    const entry: SessionEntry = {
      promise: Promise.resolve().then(async () => {
        const hintedTurnId = this.lookupCheckpointTurnId?.(normalizedSessionId, agent);
        const openTurn = await this.loadOpenTurn(normalizedSessionId, agent, hintedTurnId);
        const session = new Session(this.client, {
          sessionId: normalizedSessionId,
          agent,
          observer: this.observerName,
          openTurn: openTurn ? readSessionTurn(openTurn) : undefined,
        });
        entry.resolved = session;
        return session;
      }),
    };
    this.sessions.set(key, entry);

    try {
      const session = await entry.promise;
      session.touch();
      return session;
    } catch (error) {
      if (this.sessions.get(key) === entry) {
        this.sessions.delete(key);
      }
      throw error;
    }
  }

  private evictExpired() {
    for (const [key, entry] of this.sessions.entries()) {
      if (entry.resolved?.expired(SESSION_TTL_MS)) {
        this.sessions.delete(key);
      }
    }
  }

  private async loadOpenTurn(
    sessionId: string | undefined,
    agent: string,
    hintedTurnId?: string,
  ) {
    if (hintedTurnId) {
      const hinted = await this.client.sessionTable.getTurn(hintedTurnId);
      if (hinted && this.matchesOpenTurn(hinted, sessionId, agent)) {
        return hinted;
      }
    }
    return this.client.sessionTable.loadOpenTurn({
      sessionId,
      agent,
      observer: this.observerName,
    });
  }

  private matchesOpenTurn(
    turn: Awaited<ReturnType<NativeTables['sessionTable']['getTurn']>>,
    sessionId: string | undefined,
    agent: string,
  ): boolean {
    if (!turn) {
      return false;
    }
    return normalizeSessionId(turn.sessionId) === sessionId
      && turn.agent === agent
      && turn.observer === this.observerName
      && !hasText(turn.response);
  }
}
