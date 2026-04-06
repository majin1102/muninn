import type { CoreBinding } from '../native.js';
import type { ListModeInput, ObservingSnapshot } from '../client.js';
import { assertMemoryIdLayer } from './types.js';

export async function getObservingSnapshot(
  client: CoreBinding,
  memoryId: string,
): Promise<ObservingSnapshot | null> {
  assertMemoryIdLayer(memoryId, 'observing');
  return client.observingTable.getSnapshot(memoryId);
}

export async function listObservingSnapshots(
  client: CoreBinding,
  params: { mode: ListModeInput; observer?: string },
): Promise<ObservingSnapshot[]> {
  const rows = await client.observingTable.listSnapshots({
    observer: params.observer,
  });
  return applyObservingListMode(rows, params.mode);
}

export async function timelineObservingSnapshots(
  client: CoreBinding,
  params: { memoryId: string; beforeLimit?: number; afterLimit?: number },
): Promise<ObservingSnapshot[]> {
  assertMemoryIdLayer(params.memoryId, 'observing');
  const anchor = await getObservingSnapshot(client, params.memoryId);
  if (!anchor) {
    return [];
  }
  const snapshots = await client.observingTable.threadSnapshots(anchor.observingId);
  snapshots.sort((left, right) => (
    left.snapshotSequence - right.snapshotSequence
    || left.createdAt.localeCompare(right.createdAt)
  ));
  const anchorIndex = snapshots.findIndex((row) => row.snapshotId === params.memoryId);
  if (anchorIndex < 0) {
    return [];
  }
  const beforeLimit = params.beforeLimit ?? 3;
  const afterLimit = params.afterLimit ?? 3;
  const start = Math.max(0, anchorIndex - beforeLimit);
  const end = Math.min(snapshots.length, anchorIndex + afterLimit + 1);
  return snapshots.slice(start, end);
}

function applyObservingListMode(rows: ObservingSnapshot[], mode: ListModeInput): ObservingSnapshot[] {
  const latestByObservingId = new Map<string, ObservingSnapshot>();
  for (const row of rows) {
    const current = latestByObservingId.get(row.observingId);
    if (!current
      || row.snapshotSequence > current.snapshotSequence
      || (row.snapshotSequence === current.snapshotSequence && row.createdAt > current.createdAt)
    ) {
      latestByObservingId.set(row.observingId, row);
    }
  }

  const latest = [...latestByObservingId.values()];
  latest.sort((left, right) => (
    right.createdAt.localeCompare(left.createdAt)
    || right.snapshotSequence - left.snapshotSequence
  ));

  if (mode.type === 'recency') {
    const selected = latest.slice(0, mode.limit);
    return selected.sort((left, right) => (
      left.createdAt.localeCompare(right.createdAt)
      || left.snapshotSequence - right.snapshotSequence
    ));
  }

  return latest.slice(mode.offset, mode.offset + mode.limit);
}
