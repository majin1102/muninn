import type { RecentSessionCheckpoint, RecentTurn } from '../checkpoint.js';
import type { NativeTables } from '../native.js';
import type { Turn, TurnContent } from '../backend.js';
import path from 'node:path';
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
      project: string;
      cwd: string;
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
      const ownership = resolveTurnOwnership(content);
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
        ownership,
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

  async acceptBatch(contents: TurnContent[], observingEpoch: number): Promise<AcceptedTurn[]> {
    if (contents.length === 0) {
      return [];
    }
    return this.runAcceptExclusive(async () => {
      this.touch();
      const recentTurns = this.recentTurns.map((turn) => ({ ...turn }));
      const pendingTurns: Turn[] = [];
      const accepted: Array<{ pendingIndex?: number }> = [];

      for (const content of contents) {
        const sessionId = normalizeSessionId(content.sessionId);
        validateTurnContent(this.config, content, sessionId);
        let deduped = false;
        while (true) {
          const duplicate = this.findRecentDuplicate(content, recentTurns);
          if (!duplicate) {
            break;
          }
          if (duplicate.turnId.startsWith('batch-pending:')) {
            accepted.push({});
            deduped = true;
            break;
          }
          const persisted = await this.client.turnTable.getTurn(duplicate.turnId);
          if (persisted) {
            accepted.push({});
            deduped = true;
            break;
          }
          this.removeRecentTurn(duplicate.turnId);
          removeRecentTurn(recentTurns, duplicate.turnId);
        }
        if (deduped) {
          continue;
        }
        const turn = buildRawTurn(
          this.config,
          content,
          sessionId,
          resolveTurnOwnership(content),
          observingEpoch,
        );
        const pendingIndex = pendingTurns.push(turn) - 1;
        accepted.push({ pendingIndex });
        rememberRecentTurn(recentTurns, recentTurnFromTurn(turn, `batch-pending:${pendingIndex}`));
      }

      const rows = pendingTurns.length > 0
        ? await this.client.turnTable.insert({
          turns: pendingTurns.map(serializeTurn),
        })
        : [];
      const persisted = rows.map(readTurn);
      const result = accepted.map((acceptedTurn): AcceptedTurn => {
        if (acceptedTurn.pendingIndex === undefined) {
          return {
            turn: null,
            deduped: true,
          };
        }
        const turn = persisted[acceptedTurn.pendingIndex] ?? null;
        if (turn) {
          this.rememberTurn(turn);
        }
        return {
          turn,
          deduped: false,
        };
      });
      this.touch();
      return result;
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
      project: this.config.project,
      cwd: this.config.cwd,
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
    this.recentTurns.push(recentTurnFromTurn(turn, turn.turnId));
    if (this.recentTurns.length > RECENT_TURN_WINDOW) {
      this.recentTurns.splice(0, this.recentTurns.length - RECENT_TURN_WINDOW);
    }
  }

  private findRecentDuplicate(
    turn: Pick<TurnContent, 'turnSequence'>,
    recentTurns = this.recentTurns,
  ): RecentTurn | undefined {
    for (let index = recentTurns.length - 1; index >= 0; index -= 1) {
      const recentTurn = recentTurns[index];
      if (sameTurnSequence(recentTurn, turn)) {
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
  ownership: { project: string; cwd: string },
  observingEpoch: number,
): Promise<Turn> {
  const summary = await resolveTurnSummary({
    prompt: content.prompt,
    title: content.title,
    summary: content.summary,
    response: content.response,
  });
  return buildStoredTurn(config, content, sessionId, ownership, observingEpoch, summary);
}

function buildRawTurn(
  config: { sessionId?: string; agent: string; observer: string },
  content: TurnContent,
  sessionId: string | undefined,
  ownership: { project: string; cwd: string },
  observingEpoch: number,
): Turn {
  return buildStoredTurn(config, content, sessionId, ownership, observingEpoch, {
    title: content.title ?? null,
    summary: content.summary ?? null,
  });
}

function buildStoredTurn(
  config: { sessionId?: string; agent: string; observer: string },
  content: TurnContent,
  sessionId: string | undefined,
  ownership: { project: string; cwd: string },
  observingEpoch: number,
  summary: { title?: string | null; summary?: string | null },
): Turn {
  const now = new Date().toISOString();
  const createdAt = content.createdAt ?? content.updatedAt ?? now;
  const updatedAt = content.updatedAt ?? createdAt;
  const turn: Turn = {
    turnId: PENDING_TURN_ID,
    createdAt,
    updatedAt,
    sessionId: sessionId ?? null,
    turnSequence: content.turnSequence ?? null,
    project: ownership.project,
    cwd: ownership.cwd,
    agent: config.agent,
    observer: config.observer,
    title: summary.title ?? null,
    summary: summary.summary ?? null,
    events: content.events.map((event) => ({ ...event })),
    artifacts: content.artifacts?.map((artifact) => ({ ...artifact })) ?? null,
    metadata: content.metadata ?? null,
    prompt: content.prompt,
    response: content.response,
  };
  if (isExtractable(turn)) {
    turn.observingEpoch = observingEpoch;
  }
  return turn;
}

function validateTurnContent(
  config: { sessionId?: string; agent: string; observer: string; project: string; cwd: string },
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
  if (content.title !== undefined && !hasText(content.title)) {
    throw new Error('turn.title must be a non-empty string');
  }
  if (content.summary !== undefined && !hasText(content.summary)) {
    throw new Error('turn.summary must be a non-empty string');
  }
  if (content.project !== undefined && !hasText(content.project)) {
    throw new Error('turn.project must be a non-empty string');
  }
  if (content.cwd !== undefined && !hasText(content.cwd)) {
    throw new Error('turn.cwd must be a non-empty string');
  }
  if (content.metadata !== undefined && !isMetadataObject(content.metadata)) {
    throw new Error('turn.metadata must be an object or null');
  }
  if (content.turnSequence !== undefined && turnSequence(content.turnSequence) === undefined) {
    throw new Error('turn.turnSequence must be a non-negative safe integer');
  }
  if (content.createdAt !== undefined && !isTimestamp(content.createdAt)) {
    throw new Error('turn.createdAt must be an ISO timestamp');
  }
  if (content.updatedAt !== undefined && !isTimestamp(content.updatedAt)) {
    throw new Error('turn.updatedAt must be an ISO timestamp');
  }
  if (!Array.isArray(content.events) || content.events.length === 0) {
    throw new Error('turn.events must be a non-empty array');
  }

  if (content.agent !== config.agent) {
    throw new Error('turn session does not match loaded session');
  }
  if (sessionId !== config.sessionId) {
    throw new Error('turn session does not match loaded session');
  }
  const ownership = resolveTurnOwnership(content);
  if (ownership.project !== config.project || ownership.cwd !== config.cwd) {
    throw new Error('turn ownership does not match loaded session');
  }
}

function resolveTurnOwnership(content: TurnContent): { project: string; cwd: string } {
  const cwd = hasText(content.cwd) ? content.cwd.trim() : process.cwd();
  const project = hasText(content.project)
    ? content.project.trim()
    : path.basename(cwd) || 'default';
  return { project, cwd };
}

function isMetadataObject(value: unknown): value is Record<string, unknown> | null {
  return value === null || (typeof value === 'object' && !Array.isArray(value));
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function sameTurnSequence(
  left: Pick<RecentTurn, 'turnSequence'>,
  right: Pick<TurnContent, 'turnSequence'>,
): boolean {
  const leftSequence = turnSequence(left.turnSequence);
  const rightSequence = turnSequence(right.turnSequence);
  return leftSequence !== undefined
    && rightSequence !== undefined
    && leftSequence === rightSequence;
}

function turnSequence(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function recentTurnFromTurn(turn: Turn, turnId: string): RecentTurn {
  const sequence = turnSequence(turn.turnSequence);
  return {
    turnId,
    updatedAt: turn.updatedAt,
    ...(sequence !== undefined ? { turnSequence: sequence } : {}),
    prompt: turn.prompt ?? '',
    response: turn.response ?? '',
  };
}

function rememberRecentTurn(recentTurns: RecentTurn[], turn: RecentTurn): void {
  recentTurns.push(turn);
  if (recentTurns.length > RECENT_TURN_WINDOW) {
    recentTurns.splice(0, recentTurns.length - RECENT_TURN_WINDOW);
  }
}

function removeRecentTurn(recentTurns: RecentTurn[], turnId: string): void {
  const index = recentTurns.findIndex((turn) => turn.turnId === turnId);
  if (index >= 0) {
    recentTurns.splice(index, 1);
  }
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

function isExtractable(turn: Turn): boolean {
  return hasText(turn.response) && hasText(turn.summary);
}
