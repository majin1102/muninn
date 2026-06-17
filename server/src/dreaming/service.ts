import type { DreamingRow, NativeTables, SessionSnapshotRow, SourceRows } from '../native.js';
import { parseProjectDreamSignals, type ProjectDreamSignals } from './content.js';
import { DreamingIndex } from './index.js';
import { mergeProjectDream } from './project-dreamer.js';

export type ProjectDreamCreateResult = {
  created: boolean;
  dream: DreamingRow | null;
};

export class ProjectDreamingService {
  constructor(
    private readonly client: NativeTables,
    private readonly index: DreamingIndex,
    private readonly extractorName: string | null,
    private readonly deps: { merge?: typeof mergeProjectDream } = {},
  ) {}

  async latest(project: string): Promise<DreamingRow | null> {
    const entry = await this.index.latest(this.client, project);
    return entry ? this.getDream(entry.dreamingId) : null;
  }

  async signals(project: string, limit = 5): Promise<ProjectDreamSignals | null> {
    const dream = await this.latest(project);
    return dream ? parseProjectDreamSignals(dream.content, limit) : null;
  }

  async create(project: string): Promise<ProjectDreamCreateResult> {
    if (!this.extractorName) {
      throw new Error('extractor is not configured');
    }

    const parent = await this.index.latest(this.client, project);
    const parentRow = parent ? await this.getDream(parent.dreamingId) : null;
    const source = parent
      ? await this.client.sessionTable.delta({
        observer: this.extractorName,
        baselineVersion: parent.sessionSnapshotVersion,
      })
      : await this.client.sessionTable.listSnapshotsWithVersion({ observer: this.extractorName });
    const selected = selectedSignals(source, project);
    if (selected.length === 0) {
      return parentRow
        ? { created: false, dream: parentRow }
        : { created: false, dream: null };
    }

    const merge = this.deps.merge ?? mergeProjectDream;
    const content = await merge({
      project,
      parentDream: parentRow?.content ?? '',
      incrementalSignals: selected.map((row) => row.signals.trim()).join('\n\n'),
    });
    const row: DreamingRow = {
      dreamingId: 'dreaming:18446744073709551615',
      project,
      parentId: parent ? Number(rowId(parent.dreamingId)) : null,
      createdAt: new Date().toISOString(),
      sessionSnapshotVersion: source.sourceVersion,
      content,
    };
    const dream = await this.client.dreamingTable.append({ row });
    this.index.markDirty();
    return { created: true, dream };
  }

  private async getDream(dreamingId: string): Promise<DreamingRow | null> {
    return this.client.dreamingTable.get(dreamingId);
  }
}

function selectedSignals(source: SourceRows<SessionSnapshotRow>, project: string): SessionSnapshotRow[] {
  const latest = new Map<string, SessionSnapshotRow>();
  for (const row of source.rows) {
    if (row.project !== project || row.signals.trim().length === 0) {
      continue;
    }
    const key = dreamSessionKey(row);
    const current = latest.get(key);
    if (!current || compareSnapshots(row, current) > 0) {
      latest.set(key, row);
    }
  }
  return [...latest.values()].sort((left, right) => compareSnapshots(left, right));
}

function compareSnapshots(left: SessionSnapshotRow, right: SessionSnapshotRow): number {
  return left.snapshotSequence - right.snapshotSequence
    || left.updatedAt.localeCompare(right.updatedAt)
    || Number(rowId(left.snapshotId) - rowId(right.snapshotId));
}

function rowId(id: string): bigint {
  const match = /:(\d+)$/.exec(id);
  if (!match) {
    return 0n;
  }
  return BigInt(match[1]);
}

function dreamSessionKey(value: {
  sessionId: string;
  agent: string;
  project: string;
  cwd: string;
}): string {
  return [value.project, value.agent, value.sessionId, value.cwd].join('\u001f');
}
