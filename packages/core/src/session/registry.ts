import type { OpenTurnRef } from '../checkpoint.js';
import type { NativeTables } from '../native.js';
import type { SessionTurn } from '../client.js';
import { Session } from './session.js';
import { normalizeSessionId, sessionKey } from './key.js';
import { cloneTurn, readSessionTurn } from './types.js';

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
  ) {}

  restoreSession(sessionId: string | undefined, agent: string, openTurn: SessionTurn): void {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const key = sessionKey(normalizedSessionId, agent, this.observerName);
    const session = new Session(this.client, {
      sessionId: normalizedSessionId,
      agent,
      observer: this.observerName,
      openTurn: cloneTurn(openTurn),
    });
    this.sessions.set(key, {
      promise: Promise.resolve(session),
      resolved: session,
    });
  }

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
        const openTurn = await this.loadOpenTurn(normalizedSessionId, agent);
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
      if (entry.resolved?.expired(SESSION_TTL_MS) && !entry.resolved.exportOpenTurn()) {
        this.sessions.delete(key);
      }
    }
  }

  exportOpenTurns(): OpenTurnRef[] {
    const turns: OpenTurnRef[] = [];
    for (const entry of this.sessions.values()) {
      const turn = entry.resolved?.exportOpenTurn();
      if (turn) {
        turns.push(turn);
      }
    }
    turns.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    return turns;
  }

  private async loadOpenTurn(sessionId: string | undefined, agent: string) {
    return this.client.sessionTable.loadOpenTurn({
      sessionId,
      agent,
      observer: this.observerName,
    });
  }
}
