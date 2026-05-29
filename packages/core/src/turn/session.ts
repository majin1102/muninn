import type { RecentSessionCheckpoint, RecentTurn } from '../checkpoint.js';
import type { NativeTables } from '../native.js';
import type { Turn, TurnContent } from '../client.js';
import { resolveTurnSummary } from '../llm/turn-generator.js';
import { readTurn, serializeTurn } from './types.js';
import { hasText, normalizeSessionId } from './key.js';

const PENDING_TURN_ID = 'turn:18446744073709551615';
const RECENT_TURN_WINDOW = 3;

export type AcceptedTurn = {
  turn: Turn | null;
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
        const persisted = await this.client.turnTable.getTurn(duplicate.turnId);
        if (persisted) {
          this.touch();
          return {
            turn: null,
            deduped: true,
          };
        }
        this.removeRecentTurn(duplicate.turnId);
      }
      const recentContext = this.recentTurns.map((turn) => ({ ...turn }));
      const previousTurnSummary = summarizeRecentTurn(recentContext.at(-1));
      const turn = await buildTurn(
        this.config,
        content,
        sessionId,
        observingEpoch,
      );
      const rows = await this.client.turnTable.insert({
        turns: [serializeTurn(turn)],
      });
      const persisted = readTurn(rows[0]);
      this.rememberTurn(persisted);
      this.touch();
      return {
        turn: decorateAcceptedTurn(persisted, recentContext, previousTurnSummary),
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

  rememberTurn(turn: Turn): void {
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
): Promise<Turn> {
  const summary = await resolveTurnSummary({
    prompt: content.prompt,
    response: content.response,
  });
  const now = new Date().toISOString();
  const turn: Turn = {
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

function summarizeRecentTurn(turn: RecentTurn | undefined): string | null {
  if (!turn) {
    return null;
  }
  const text = [turn.prompt, turn.response]
    .filter((value) => value && value.trim())
    .join('\nResponse: ')
    .split(/\s+/)
    .join(' ')
    .trim();
  return text || null;
}

function decorateAcceptedTurn(
  turn: Turn,
  recentContext: RecentTurn[],
  previousTurnSummary: string | null,
): Turn {
  return {
    ...turn,
    ...(previousTurnSummary ? { previousTurnSummary } : {}),
    ...(recentContext.length > 0 ? { recentContext } : {}),
  };
}

export function isObservable(turn: Turn): boolean {
  return hasText(turn.response) && hasText(turn.summary);
}
