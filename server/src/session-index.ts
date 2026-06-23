import type { NativeTables, SessionSnapshotRow, TurnRow } from './native.js';
import type { SessionIndexCheckpoint, SessionIndexEntry } from './checkpoint.js';
import { sessionIdentityKey } from '@muninn/common/session-identity';
import { readTurnRow } from './pipeline/ingest.js';

type IndexedTurn = {
  sessionId?: string | null;
  agent: string;
  project: string;
  cwd: string;
  extractor?: string | null;
  metadata?: Record<string, unknown> | null;
  response?: string | null;
  turnSequence?: number | null;
  updatedAt: string;
};

const REBUILD_LIMIT = 1_000_000;

export class SessionIndex {
  private entries = new Map<string, SessionIndexEntry>();
  private baseline: SessionIndexCheckpoint['baseline'];
  private dirty = false;

  constructor(
    checkpoint: SessionIndexCheckpoint | null,
    private readonly extractorName: string | null,
  ) {
    this.baseline = checkpoint?.baseline ?? { turn: 0, session: 0 };
    for (const entry of checkpoint?.entries ?? []) {
      this.entries.set(entryKey(entry), { ...entry });
    }
  }

  markDirty(): void {
    this.dirty = true;
  }

  async list(client: NativeTables): Promise<SessionIndexEntry[]> {
    await this.ensureFresh(client);
    return [...this.entries.values()]
      .map((entry) => ({ ...entry }))
      .sort((left, right) => right.latestUpdatedAt.localeCompare(left.latestUpdatedAt));
  }

  async exportCheckpoint(client: NativeTables): Promise<SessionIndexCheckpoint> {
    await this.ensureFresh(client);
    return this.currentCheckpoint();
  }

  currentCheckpoint(): SessionIndexCheckpoint {
    return {
      baseline: { ...this.baseline },
      entries: [...this.entries.values()].map((entry) => ({ ...entry })),
    };
  }

  private async ensureFresh(client: NativeTables): Promise<void> {
    if (this.dirty || this.baseline.turn === 0 || this.baseline.session === 0 || !this.extractorName) {
      await this.rebuild(client);
      return;
    }

    const [turnDelta, sessionDelta] = await Promise.all([
      client.turnTable.delta({
        extractor: this.extractorName,
        baselineVersion: this.baseline.turn,
      }),
      client.sessionTable.delta({
        extractor: this.extractorName,
        baselineVersion: this.baseline.session,
      }),
    ]);

    for (const turn of turnDelta) {
      this.upsertTurn(readTurnRow(turn));
    }
    this.applySnapshots(sessionDelta.rows);

    const turnStats = await client.turnTable.stats();
    this.baseline = {
      turn: turnStats?.version ?? this.baseline.turn,
      session: sessionDelta.sourceVersion,
    };
  }

  private async rebuild(client: NativeTables): Promise<void> {
    const [snapshotRows, turnStats] = await Promise.all([
      client.sessionTable.listSnapshotsWithVersion(this.extractorName ? { extractor: this.extractorName } : {}),
      client.turnTable.stats(),
    ]);
    const turnRows = await this.listAllTurns(client, turnStats?.rowCount);

    this.entries.clear();
    for (const turn of turnRows) {
      const decoded = readTurnRow(turn);
      if (!this.extractorName || decoded.extractor === this.extractorName) {
        this.upsertTurn(decoded);
      }
    }
    this.applySnapshots(this.extractorName
      ? snapshotRows.rows.filter((snapshot) => snapshot.extractor === this.extractorName)
      : snapshotRows.rows);
    this.baseline = {
      turn: turnStats?.version ?? 0,
      session: snapshotRows.sourceVersion,
    };
    this.dirty = false;
  }

  private async listAllTurns(client: NativeTables, rowCount?: number): Promise<TurnRow[]> {
    const rows: TurnRow[] = [];
    let offset = 0;
    while (true) {
      const page = await client.turnTable.listTurns({
        mode: { type: 'page', offset, limit: REBUILD_LIMIT },
        ...(this.extractorName ? { extractor: this.extractorName } : {}),
      });
      if (page.length === 0) {
        break;
      }
      rows.push(...page);
      offset += REBUILD_LIMIT;
      if (rowCount === undefined) {
        if (page.length < REBUILD_LIMIT) {
          break;
        }
      } else if (offset >= rowCount) {
        break;
      }
    }
    return rows;
  }

  private upsertTurn(turn: IndexedTurn): void {
    if (!turn.sessionId || !turn.response?.trim()) {
      return;
    }
    const sequence = turnSequence(turn);
    const entryBase = {
      sessionId: turn.sessionId,
      agent: turn.agent,
      project: turn.project,
      cwd: turn.cwd,
    };
    const key = entryKey(entryBase);
    const current = this.entries.get(key);
    if (!current) {
      this.entries.set(key, {
        ...entryBase,
        latestUpdatedAt: turn.updatedAt,
        ...(sequence !== undefined ? { firstTurnSequence: sequence } : {}),
      });
      return;
    }
    const firstTurnSequence = sequence === undefined
      ? current.firstTurnSequence
      : Math.min(current.firstTurnSequence ?? sequence, sequence);
    if (turn.updatedAt > current.latestUpdatedAt) {
      this.entries.set(key, {
        ...current,
        cwd: turn.cwd,
        latestUpdatedAt: turn.updatedAt,
        ...(firstTurnSequence !== undefined ? { firstTurnSequence } : {}),
      });
      return;
    }
    if (firstTurnSequence !== current.firstTurnSequence) {
      this.entries.set(key, {
        ...current,
        firstTurnSequence,
      });
    }
  }

  private applySnapshots(snapshots: SessionSnapshotRow[]): void {
    const latestBySession = new Map<string, SessionSnapshotRow>();
    for (const snapshot of snapshots) {
      const current = latestBySession.get(entryKey(snapshot));
      if (
        !current
        || snapshot.snapshotSequence > current.snapshotSequence
        || (
          snapshot.snapshotSequence === current.snapshotSequence
          && snapshot.updatedAt > current.updatedAt
        )
      ) {
        latestBySession.set(entryKey(snapshot), snapshot);
      }
    }

    for (const snapshot of latestBySession.values()) {
      for (const entry of this.entries.values()) {
        if (entryKey(entry) === entryKey(snapshot)) {
          entry.snapshotId = snapshot.snapshotId;
          entry.title = snapshot.title;
        }
      }
    }
  }
}

function entryKey(value: {
  sessionId: string;
  agent: string;
  project: string;
}): string {
  return sessionIdentityKey({
    project: value.project,
    agent: value.agent,
    sessionId: value.sessionId,
  });
}

function turnSequence(turn: IndexedTurn): number | undefined {
  const value = turn.turnSequence;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}
