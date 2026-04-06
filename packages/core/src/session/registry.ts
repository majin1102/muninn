import type { CoreBinding } from '../native.js';
import type { SessionTurnRecord } from '../client.js';
import { Session } from './session.js';
import { sessionKey } from './key.js';
import { fromWireTurn } from './types.js';

const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly client: CoreBinding,
    readonly observerName: string,
  ) {}

  async load(sessionId: string | undefined, agent: string): Promise<Session> {
    this.evictExpired();
    const key = sessionKey(sessionId, agent, this.observerName);
    const existing = this.sessions.get(key);
    if (existing) {
      existing.touch();
      return existing;
    }

    const openTurn = await this.client.sessionLoadOpenTurn({
      sessionId,
      agent,
      observer: this.observerName,
    });
    const session = new Session(this.client, {
      sessionId,
      agent,
      observer: this.observerName,
      openTurn: openTurn ? fromWireTurn(openTurn) : undefined,
    });
    this.sessions.set(key, session);
    return session;
  }

  private evictExpired() {
    for (const [key, session] of this.sessions.entries()) {
      if (session.expired(SESSION_TTL_MS)) {
        this.sessions.delete(key);
      }
    }
  }
}
