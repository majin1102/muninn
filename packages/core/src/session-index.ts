import type { NativeTables } from './native.js';
import type { SessionIndexCheckpoint, SessionIndexEntry } from './checkpoint.js';
import type { SessionSnapshot } from './extractor/types.js';
import { readTurn } from './turn/types.js';

type IndexedTurn = {
  sessionId?: string | null;
  agent: string;
  observer?: string | null;
  summary?: string | null;
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
      this.entries.set(entryKey(entry.sessionId, entry.agent), { ...entry });
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
        observer: this.extractorName,
        baselineVersion: this.baseline.turn,
      }),
      client.sessionTable.delta({
        observer: this.extractorName,
        baselineVersion: this.baseline.session,
      }),
    ]);

    for (const turn of turnDelta) {
      this.upsertTurn(readTurn(turn));
    }
    this.applySnapshots(sessionDelta);

    const [turnStats, sessionStats] = await Promise.all([
      client.turnTable.stats(),
      client.sessionTable.stats(),
    ]);
    this.baseline = {
      turn: turnStats?.version ?? this.baseline.turn,
      session: sessionStats?.version ?? this.baseline.session,
    };
  }

  private async rebuild(client: NativeTables): Promise<void> {
    const [turnRows, snapshotRows, turnStats, sessionStats] = await Promise.all([
      client.turnTable.listTurns({
        mode: { type: 'page', offset: 0, limit: REBUILD_LIMIT },
      }),
      client.sessionTable.listSnapshots({}),
      client.turnTable.stats(),
      client.sessionTable.stats(),
    ]);

    this.entries.clear();
    for (const turn of turnRows) {
      this.upsertTurn(readTurn(turn));
    }
    this.applySnapshots(snapshotRows);
    this.baseline = {
      turn: turnStats?.version ?? 0,
      session: sessionStats?.version ?? 0,
    };
    this.dirty = false;
  }

  private upsertTurn(turn: IndexedTurn): void {
    if (!turn.sessionId || !turn.summary?.trim()) {
      return;
    }
    const key = entryKey(turn.sessionId, turn.agent);
    const current = this.entries.get(key);
    if (!current) {
      this.entries.set(key, {
        sessionId: turn.sessionId,
        agent: turn.agent,
        latestUpdatedAt: turn.updatedAt,
      });
      return;
    }
    if (turn.updatedAt > current.latestUpdatedAt) {
      this.entries.set(key, {
        ...current,
        latestUpdatedAt: turn.updatedAt,
      });
    }
  }

  private applySnapshots(snapshots: SessionSnapshot[]): void {
    const latestBySession = new Map<string, SessionSnapshot>();
    for (const snapshot of snapshots) {
      const current = latestBySession.get(snapshot.sessionId);
      if (
        !current
        || snapshot.snapshotSequence > current.snapshotSequence
        || (
          snapshot.snapshotSequence === current.snapshotSequence
          && snapshot.updatedAt > current.updatedAt
        )
      ) {
        latestBySession.set(snapshot.sessionId, snapshot);
      }
    }

    for (const snapshot of latestBySession.values()) {
      for (const entry of this.entries.values()) {
        if (entry.sessionId === snapshot.sessionId) {
          entry.snapshotId = snapshot.snapshotId;
          entry.title = snapshot.title;
        }
      }
    }
  }
}

function entryKey(sessionId: string, agent: string): string {
  return `${agent}\0${sessionId}`;
}
