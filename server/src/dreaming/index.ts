import type { DreamingRow, NativeTables } from '../native.js';
import type { DreamingIndexCheckpoint, DreamingIndexEntry } from '../checkpoint.js';

export class DreamingIndex {
  private entries = new Map<string, DreamingIndexEntry>();
  private baseline: DreamingIndexCheckpoint['baseline'];
  private dirty = false;

  constructor(checkpoint: DreamingIndexCheckpoint | null) {
    this.baseline = checkpoint?.baseline ?? { dreaming: 0 };
    for (const entry of checkpoint?.entries ?? []) {
      this.entries.set(entry.project, { ...entry });
    }
  }

  markDirty(): void {
    this.dirty = true;
  }

  async list(client: NativeTables): Promise<DreamingIndexEntry[]> {
    await this.ensureFresh(client);
    return [...this.entries.values()]
      .map((entry) => ({ ...entry }))
      .sort((left, right) => left.project.localeCompare(right.project));
  }

  async latest(client: NativeTables, project: string): Promise<DreamingIndexEntry | null> {
    await this.ensureFresh(client);
    const entry = this.entries.get(project);
    return entry ? { ...entry } : null;
  }

  async exportCheckpoint(client: NativeTables): Promise<DreamingIndexCheckpoint> {
    await this.ensureFresh(client);
    return {
      baseline: { ...this.baseline },
      entries: this.sortedEntries(),
    };
  }

  sessionSnapshotFloor(): number | null {
    const versions = [...this.entries.values()].map((entry) => entry.sessionSnapshotVersion);
    return versions.length === 0 ? null : Math.min(...versions);
  }

  private async ensureFresh(client: NativeTables): Promise<void> {
    if (this.dirty || this.baseline.dreaming === 0) {
      await this.rebuild(client);
      return;
    }

    const delta = await client.dreamingTable.delta({ baselineVersion: this.baseline.dreaming });
    this.applyRows(delta.rows);
    this.baseline = { dreaming: delta.sourceVersion };
  }

  private async rebuild(client: NativeTables): Promise<void> {
    const rows = await client.dreamingTable.list();
    this.entries.clear();
    this.applyRows(rows);
    const stats = await client.dreamingTable.stats();
    this.baseline = { dreaming: stats?.version ?? 0 };
    this.dirty = false;
  }

  private applyRows(rows: DreamingRow[]): void {
    for (const row of rows) {
      const next = this.entry(row);
      const current = this.entries.get(row.project);
      if (!current || rowId(next.dreamingId) > rowId(current.dreamingId)) {
        this.entries.set(row.project, next);
      }
    }
  }

  private entry(row: DreamingRow): DreamingIndexEntry {
    return {
      project: row.project,
      dreamingId: row.dreamingId,
      ...(row.parentId == null ? {} : { parentId: `dreaming:${row.parentId}` }),
      createdAt: row.createdAt,
      sessionSnapshotVersion: row.sessionSnapshotVersion,
    };
  }

  private sortedEntries(): DreamingIndexEntry[] {
    return [...this.entries.values()]
      .map((entry) => ({ ...entry }))
      .sort((left, right) => left.project.localeCompare(right.project));
  }
}

function rowId(dreamingId: string): number {
  const match = /^dreaming:(\d+)$/.exec(dreamingId);
  if (!match) {
    throw new Error(`invalid dreaming id: ${dreamingId}`);
  }
  return Number(match[1]);
}
