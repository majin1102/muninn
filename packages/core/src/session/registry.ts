import type { CoreBinding } from '../native.js';
import { Session } from './session.js';
import { sessionKey } from './key.js';
import { readSessionTurn } from './types.js';

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

    const openTurn = await this.client.sessionTable.loadOpenTurn({
      sessionId,
      agent,
      observer: this.observerName,
    });
    const session = new Session(this.client, {
      sessionId,
      agent,
      observer: this.observerName,
      openTurn: openTurn ? readSessionTurn(openTurn) : undefined,
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
