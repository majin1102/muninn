import type { NativeTables } from '../native.js';
import type { ListModeInput, SessionSnapshot } from '../client.js';
import { assertMemoryIdLayer } from './types.js';

export async function getSessionSnapshot(
  client: NativeTables,
  memoryId: string,
): Promise<SessionSnapshot | null> {
  assertMemoryIdLayer(memoryId, 'session');
  return client.sessionTable.getSnapshot(memoryId);
}

export async function listSessionSnapshots(
  client: NativeTables,
  params: { mode: ListModeInput; observer?: string },
): Promise<SessionSnapshot[]> {
  const rows = await client.sessionTable.listSnapshots({
    observer: params.observer,
  });
  return applyObservingListMode(rows, params.mode);
}

export async function timelineSessionSnapshots(
  client: NativeTables,
  params: { memoryId: string; beforeLimit?: number; afterLimit?: number },
): Promise<SessionSnapshot[]> {
  assertMemoryIdLayer(params.memoryId, 'session');
  const anchor = await getSessionSnapshot(client, params.memoryId);
  if (!anchor) {
    return [];
  }
  const snapshots = await client.sessionTable.threadSnapshots(anchor.sessionId);
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

function applyObservingListMode(rows: SessionSnapshot[], mode: ListModeInput): SessionSnapshot[] {
  const latestBySessionId = new Map<string, SessionSnapshot>();
  for (const row of rows) {
    const current = latestBySessionId.get(row.sessionId);
    if (!current
      || row.snapshotSequence > current.snapshotSequence
      || (row.snapshotSequence === current.snapshotSequence && row.createdAt > current.createdAt)
    ) {
      latestBySessionId.set(row.sessionId, row);
    }
  }

  const latest = [...latestBySessionId.values()];
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
