import type { RecentSessionCheckpoint, RecentTurn } from '../checkpoint.js';
import type { NativeTables } from '../native.js';
import type { SessionTurn, TurnContent } from '../client.js';
import { resolveTurnSummary } from '../llm/turn-generator.js';
import { readSessionTurn, serializeSessionTurn } from './types.js';
import { hasText, normalizeSessionId } from './key.js';

const PENDING_TURN_ID = 'session:18446744073709551615';
const RECENT_TURN_WINDOW = 3;

export type AcceptedTurn = {
  turn: SessionTurn | null;
  deduped: boolean;
};

export class Session {
  private recentTurns: RecentTurn[];
  private lastUsedAt = Date.now();
  private acceptQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly client: NativeTables,
    private readonly config: {
      sessionId?: string;
      agent: string;
      observer: string;
      recentTurns?: RecentTurn[];
    },
  ) {
    this.recentTurns = (config.recentTurns ?? []).slice(-RECENT_TURN_WINDOW);
    this.config.sessionId = normalizeSessionId(this.config.sessionId);
  }

  async accept(content: TurnContent, observingEpoch: number): Promise<AcceptedTurn> {
    return this.runAcceptExclusive(async () => {
      this.touch();
      const sessionId = normalizeSessionId(content.sessionId);
      validateTurnContent(this.config, content, sessionId);
      while (true) {
        const duplicate = this.findRecentDuplicate(content);
        if (!duplicate) {
          break;
        }
        const persisted = await this.client.sessionTable.getTurn(duplicate.turnId);
        if (persisted) {
          this.touch();
          return {
            turn: null,
            deduped: true,
          };
        }
        this.removeRecentTurn(duplicate.turnId);
      }
      const turn = await buildTurn(
        this.config,
        content,
        sessionId,
        observingEpoch,
      );
      const rows = await this.client.sessionTable.insert({
        turns: [serializeSessionTurn(turn)],
      });
      const persisted = readSessionTurn(rows[0]);
      this.rememberTurn(persisted);
      this.touch();
      return {
        turn: persisted,
        deduped: false,
      };
    });
  }

  touch(): void {
    this.lastUsedAt = Date.now();
  }

  expired(ttlMs: number): boolean {
    return Date.now() - this.lastUsedAt > ttlMs;
  }

  exportRecentSession(): RecentSessionCheckpoint | null {
    if (this.recentTurns.length === 0) {
      return null;
    }
    return {
      sessionId: this.config.sessionId ?? null,
      agent: this.config.agent,
      turns: [...this.recentTurns],
    };
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

  rememberTurn(turn: SessionTurn): void {
    this.touch();
    this.recentTurns.push({
      turnId: turn.turnId,
      updatedAt: turn.updatedAt,
      prompt: turn.prompt ?? '',
      response: turn.response ?? '',
    });
    if (this.recentTurns.length > RECENT_TURN_WINDOW) {
      this.recentTurns.splice(0, this.recentTurns.length - RECENT_TURN_WINDOW);
    }
  }

  private findRecentDuplicate(turn: Pick<TurnContent, 'prompt' | 'response'>): RecentTurn | undefined {
    for (let index = this.recentTurns.length - 1; index >= 0; index -= 1) {
      const recentTurn = this.recentTurns[index];
      if (samePromptResponse(recentTurn, turn)) {
        return recentTurn;
      }
    }
    return undefined;
  }

  private removeRecentTurn(turnId: string): void {
    const index = this.recentTurns.findIndex((turn) => turn.turnId === turnId);
    if (index >= 0) {
      this.recentTurns.splice(index, 1);
    }
  }
}

async function buildTurn(
  config: { sessionId?: string; agent: string; observer: string },
  content: TurnContent,
  sessionId: string | undefined,
  observingEpoch: number,
): Promise<SessionTurn> {
  const summary = await resolveTurnSummary({
    prompt: content.prompt,
    response: content.response,
  });
  const now = new Date().toISOString();
  const turn: SessionTurn = {
    turnId: PENDING_TURN_ID,
    createdAt: now,
    updatedAt: now,
    sessionId: sessionId ?? null,
    agent: config.agent,
    observer: config.observer,
    title: summary.title ?? null,
    summary: summary.summary ?? null,
    toolCalls: content.toolCalls?.map((toolCall) => ({ ...toolCall })) ?? null,
    artifacts: content.artifacts?.map((artifact) => ({ ...artifact })) ?? null,
    prompt: content.prompt,
    response: content.response,
  };
  if (isObservable(turn)) {
    turn.observingEpoch = observingEpoch;
  }
  return turn;
}

function validateTurnContent(
  config: { sessionId?: string; agent: string; observer: string },
  content: TurnContent,
  sessionId: string | undefined,
): void {
  if (!hasText(content.sessionId)) {
    throw new Error('turn must include sessionId');
  }
  if (!hasText(content.agent)) {
    throw new Error('turn must include agent');
  }
  if (!hasText(content.prompt)) {
    throw new Error('turn must include prompt');
  }
  if (!hasText(content.response)) {
    throw new Error('turn must include response');
  }

  if (content.agent !== config.agent) {
    throw new Error('turn session does not match loaded session');
  }
  if (sessionId !== config.sessionId) {
    throw new Error('turn session does not match loaded session');
  }
}

function samePromptResponse(
  left: Pick<RecentTurn, 'prompt' | 'response'>,
  right: Pick<TurnContent, 'prompt' | 'response'>,
): boolean {
  return left.prompt === right.prompt
    && left.response === right.response;
}

export function isObservable(turn: SessionTurn): boolean {
  return hasText(turn.response) && hasText(turn.summary);
}
