import type { RecentSessionCheckpoint, RecentTurn } from '../checkpoint.js';
import type { NativeTables, TurnRow } from '../native.js';
import type { TurnContent } from '@muninn/common';
import path from 'node:path';

export function sessionKey(
  sessionId: string | undefined,
  agent: string,
  extractor: string,
  ownership: { project: string; cwd: string } = {
    project: 'default',
    cwd: process.cwd(),
  },
): string {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const scope = `cwd:${ownership.cwd}`;
  if (normalizedSessionId) {
    return `${scope}|session:${normalizedSessionId}|agent:${agent}|extractor:${extractor}`;
  }
  return `${scope}|agent:${agent}|extractor:${extractor}`;
}

export function normalizeSessionId(sessionId: string | null | undefined): string | undefined {
  if (!hasText(sessionId)) {
    return undefined;
  }
  return sessionId.trim();
}

export function hasText(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

type TurnPayload = TurnRow & { session_id?: string | null; turn_sequence?: number | null };

export function readTurnRow(turn: TurnRow): TurnRow {
  const payload = turn as TurnPayload;
  const sessionId = normalizeSessionId(turn.sessionId ?? payload.session_id);
  return {
    turnId: turn.turnId,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
    sessionId: sessionId ?? null,
    turnSequence: turn.turnSequence ?? payload.turn_sequence ?? null,
    project: turn.project,
    cwd: turn.cwd,
    agent: turn.agent,
    extractor: turn.extractor,
    events: turn.events ?? [],
    artifacts: turn.artifacts,
    metadata: turn.metadata,
    prompt: turn.prompt,
    response: turn.response,
    extractionEpoch: turn.extractionEpoch,
  } as TurnRow;
}

export function serializeTurnRow(turn: TurnRow): Record<string, unknown> {
  const sessionId = normalizeSessionId(turn.sessionId);
  return {
    turnId: turn.turnId,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
    session_id: sessionId ?? null,
    turn_sequence: turn.turnSequence ?? null,
    project: turn.project,
    cwd: turn.cwd,
    agent: turn.agent,
    extractor: turn.extractor,
    events: turn.events,
    artifacts: turn.artifacts ?? null,
    metadata: turn.metadata ?? null,
    prompt: turn.prompt ?? null,
    response: turn.response ?? null,
    extractionEpoch: turn.extractionEpoch ?? null,
  };
}


const PENDING_TURN_ID = 'turn:18446744073709551615';
const RECENT_TURN_WINDOW = 3;

export type AcceptedIngestTurn = {
  turn: TurnRow | null;
  deduped: boolean;
};

export class IngestSession {
  private recentTurns: RecentTurn[];
  private lastUsedAt = Date.now();
  private acceptQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly client: NativeTables,
    private readonly config: {
      sessionId?: string;
      agent: string;
      extractor: string;
      project: string;
      cwd: string;
      recentTurns?: RecentTurn[];
    },
  ) {
    this.recentTurns = (config.recentTurns ?? []).slice(-RECENT_TURN_WINDOW);
    this.config.sessionId = normalizeSessionId(this.config.sessionId);
  }

  async accept(content: TurnContent, extractionEpoch: number): Promise<AcceptedIngestTurn> {
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
      const turn = buildTurnRow(
        this.config,
        content,
        sessionId,
        ownership,
        extractionEpoch,
      );
      const rows = await this.client.turnTable.insert({
        turns: [serializeTurnRow(turn)],
      });
      const persisted = readTurnRow(rows[0]);
      this.rememberTurn(persisted);
      this.touch();
      return {
        turn: decorateAcceptedTurn(persisted, recentContext, previousTurnSummary),
        deduped: false,
      };
    });
  }

  async acceptBatch(contents: TurnContent[], extractionEpoch: number): Promise<AcceptedIngestTurn[]> {
    if (contents.length === 0) {
      return [];
    }
    return this.runAcceptExclusive(async () => {
      this.touch();
      const recentTurns = this.recentTurns.map((turn) => ({ ...turn }));
      const pendingTurns: TurnRow[] = [];
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
        const turn = buildTurnRow(
          this.config,
          content,
          sessionId,
          resolveTurnOwnership(content),
          extractionEpoch,
        );
        const pendingIndex = pendingTurns.push(turn) - 1;
        accepted.push({ pendingIndex });
        rememberRecentTurn(recentTurns, recentTurnFromTurn(turn, `batch-pending:${pendingIndex}`));
      }

      const rows = pendingTurns.length > 0
        ? await this.client.turnTable.insert({
          turns: pendingTurns.map(serializeTurnRow),
        })
        : [];
      const persisted = rows.map(readTurnRow);
      const result = accepted.map((acceptedTurn): AcceptedIngestTurn => {
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

  rememberTurn(turn: TurnRow): void {
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

function buildTurnRow(
  config: { sessionId?: string; agent: string; extractor: string },
  content: TurnContent,
  sessionId: string | undefined,
  ownership: { project: string; cwd: string },
  extractionEpoch: number,
): TurnRow {
  const now = new Date().toISOString();
  const createdAt = content.createdAt ?? content.updatedAt ?? now;
  const updatedAt = content.updatedAt ?? createdAt;
  const turn: TurnRow = {
    turnId: PENDING_TURN_ID,
    createdAt,
    updatedAt,
    sessionId: sessionId ?? null,
    turnSequence: content.turnSequence ?? null,
    project: ownership.project,
    cwd: ownership.cwd,
    agent: config.agent,
    extractor: config.extractor,
    events: content.events.map((event) => ({ ...event })),
    artifacts: content.artifacts?.map((artifact) => ({ ...artifact })) ?? null,
    metadata: content.metadata ?? null,
    prompt: content.prompt,
    response: content.response,
  };
  if (isExtractable(turn)) {
    turn.extractionEpoch = extractionEpoch;
  }
  return turn;
}

function validateTurnContent(
  config: { sessionId?: string; agent: string; extractor: string; project: string; cwd: string },
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
  if ('title' in content) {
    throw new Error('turn.title is not supported');
  }
  if ('summary' in content) {
    throw new Error('turn.summary is not supported');
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

function recentTurnFromTurn(turn: TurnRow, turnId: string): RecentTurn {
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
  const parts = [
    hasText(turn.prompt) ? `Prompt: ${turn.prompt.trim()}` : null,
    hasText(turn.response) ? `Response: ${turn.response.trim()}` : null,
  ].filter(Boolean);
  const text = parts.join('\n\n');
  return text || null;
}

function decorateAcceptedTurn(
  turn: TurnRow,
  recentContext: RecentTurn[],
  previousTurnSummary: string | null,
): TurnRow {
  return {
    ...turn,
    ...(previousTurnSummary ? { previousTurnSummary } : {}),
    ...(recentContext.length > 0 ? { recentContext } : {}),
  };
}

function isExtractable(turn: TurnRow): boolean {
  return hasText(turn.response);
}


const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

type IngestSessionEntry = {
  promise: Promise<IngestSession>;
  resolved?: IngestSession;
};

type SessionOwnership = {
  project: string;
  cwd: string;
};

export class IngestSessionRegistry {
  private readonly sessions = new Map<string, IngestSessionEntry>();

  constructor(
    private readonly client: NativeTables,
    readonly extractorName: string,
  ) {}

  restoreSession(
    sessionId: string | undefined,
    agent: string,
    ownership: SessionOwnership,
    recentTurns: RecentTurn[],
  ): void {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const key = sessionKey(normalizedSessionId, agent, this.extractorName, ownership);
    const session = new IngestSession(this.client, {
      sessionId: normalizedSessionId,
      agent,
      extractor: this.extractorName,
      project: ownership.project,
      cwd: ownership.cwd,
      recentTurns,
    });
    this.sessions.set(key, {
      promise: Promise.resolve(session),
      resolved: session,
    });
  }

  rememberTurn(turn: TurnRow): void {
    const normalizedSessionId = normalizeSessionId(turn.sessionId ?? undefined);
    const ownership = { project: turn.project, cwd: turn.cwd };
    const key = sessionKey(normalizedSessionId, turn.agent, this.extractorName, ownership);
    const existing = this.sessions.get(key)?.resolved;
    if (existing) {
      existing.rememberTurn(turn);
      return;
    }
    const session = new IngestSession(this.client, {
      sessionId: normalizedSessionId,
      agent: turn.agent,
      extractor: this.extractorName,
      project: ownership.project,
      cwd: ownership.cwd,
    });
    session.rememberTurn(turn);
    this.sessions.set(key, {
      promise: Promise.resolve(session),
      resolved: session,
    });
  }

  async load(sessionId: string | undefined, agent: string, ownership: SessionOwnership): Promise<IngestSession> {
    this.evictExpired();
    const normalizedSessionId = normalizeSessionId(sessionId);
    const key = sessionKey(normalizedSessionId, agent, this.extractorName, ownership);
    const existing = this.sessions.get(key);
    if (existing) {
      const session = await existing.promise;
      session.touch();
      return session;
    }

    const entry: IngestSessionEntry = {
      promise: Promise.resolve().then(async () => {
        const session = new IngestSession(this.client, {
          sessionId: normalizedSessionId,
          agent,
          extractor: this.extractorName,
          project: ownership.project,
          cwd: ownership.cwd,
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
