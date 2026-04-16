import type { SessionTurn } from '../client.js';
import type { RecentSessionCheckpoint, RecentTurn } from '../checkpoint.js';
import type { NativeTables } from '../native.js';
import { Session } from './session.js';
import { normalizeSessionId, sessionKey } from './key.js';

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

  restoreSession(sessionId: string | undefined, agent: string, recentTurns: RecentTurn[]): void {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const key = sessionKey(normalizedSessionId, agent, this.observerName);
    const session = new Session(this.client, {
      sessionId: normalizedSessionId,
      agent,
      observer: this.observerName,
      recentTurns,
    });
    this.sessions.set(key, {
      promise: Promise.resolve(session),
      resolved: session,
    });
  }

  rememberTurn(turn: SessionTurn): void {
    const normalizedSessionId = normalizeSessionId(turn.sessionId ?? undefined);
    const key = sessionKey(normalizedSessionId, turn.agent, this.observerName);
    const existing = this.sessions.get(key)?.resolved;
    if (existing) {
      existing.rememberTurn(turn);
      return;
    }
    const session = new Session(this.client, {
      sessionId: normalizedSessionId,
      agent: turn.agent,
      observer: this.observerName,
    });
    session.rememberTurn(turn);
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
        const session = new Session(this.client, {
          sessionId: normalizedSessionId,
          agent,
          observer: this.observerName,
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

  exportRecentSessions(): RecentSessionCheckpoint[] {
    const sessions: RecentSessionCheckpoint[] = [];
    for (const entry of this.sessions.values()) {
      const session = entry.resolved?.exportRecentSession();
      if (session) {
        sessions.push(session);
      }
    }
    sessions.sort((left, right) => {
      const leftUpdatedAt = left.turns[left.turns.length - 1]?.updatedAt ?? '';
      const rightUpdatedAt = right.turns[right.turns.length - 1]?.updatedAt ?? '';
      return leftUpdatedAt.localeCompare(rightUpdatedAt);
    });
    return sessions;
  }
}
