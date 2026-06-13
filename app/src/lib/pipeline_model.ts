import type { PipelineTask, PipelineTaskKind, PipelineTaskStatus, PipelineTasksResponse } from '@muninn/types';

export type PipelineTaskFilter = PipelineTaskKind | 'all';
export type PipelineStatusFilter = PipelineTaskStatus | 'active' | 'all';
export type PipelineTimeFilter = 'all' | 'last_6h' | 'last_24h' | 'last_7d' | 'last_30d' | 'custom';

export function summarizePipelineTasks(tasks: PipelineTask[]): PipelineTasksResponse['summary'] {
  const summary: PipelineTasksResponse['summary'] = {
    running: 0,
    queued: 0,
    failed: 0,
    updatedAt: null,
  };

  for (const task of tasks) {
    if (task.status === 'running') {
      summary.running += 1;
    } else if (task.status === 'queued') {
      summary.queued += 1;
    } else if (task.status === 'failed') {
      summary.failed += 1;
    }
    if (summary.updatedAt === null || task.updatedAt > summary.updatedAt) {
      summary.updatedAt = task.updatedAt;
    }
  }

  return summary;
}

export function defaultSelectedPipelineTaskId(tasks: PipelineTask[]): string | null {
  const bestByStatus: Partial<Record<PipelineTaskStatus, PipelineTask>> = {};
  for (const task of tasks) {
    const current = bestByStatus[task.status];
    if (current === undefined || task.updatedAt > current.updatedAt) {
      bestByStatus[task.status] = task;
    }
  }

  return (
    bestByStatus.running
    ?? bestByStatus.failed
    ?? bestByStatus.queued
    ?? bestByStatus.done
    ?? null
  )?.id ?? null;
}

export function filterPipelineTasks(
  tasks: PipelineTask[],
  taskFilter: PipelineTaskFilter,
  statusFilter: PipelineStatusFilter,
  timeFilter: PipelineTimeFilter,
  customTimeRange: { from: Date | null; to: Date | null } = { from: null, to: null },
  nowMs = Date.now(),
): PipelineTask[] {
  const range = resolvePipelineTimeRange(timeFilter, customTimeRange, nowMs);

  return tasks
    .filter((task) => taskFilter === 'all' || task.kind === taskFilter)
    .filter((task) => statusFilter === 'all' || (statusFilter === 'active' ? task.status !== 'done' : task.status === statusFilter))
    .filter((task) => isPipelineTaskInRange(task.updatedAt, range))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function resolvePipelineTimeRange(
  timeFilter: PipelineTimeFilter,
  customTimeRange: { from: Date | null; to: Date | null },
  nowMs: number,
): { from: Date | null; to: Date | null } {
  if (timeFilter === 'all') {
    return { from: null, to: null };
  }
  if (timeFilter === 'custom') {
    return customTimeRange;
  }
  const hours = timeFilter === 'last_6h'
    ? 6
    : timeFilter === 'last_24h'
      ? 24
      : timeFilter === 'last_7d'
        ? 24 * 7
        : 24 * 30;
  return {
    from: new Date(nowMs - hours * 60 * 60 * 1000),
    to: new Date(nowMs),
  };
}

function isPipelineTaskInRange(value: string, range: { from: Date | null; to: Date | null }): boolean {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) {
    return false;
  }
  if (range.from && time < range.from.getTime()) {
    return false;
  }
  if (range.to && time > range.to.getTime()) {
    return false;
  }
  return true;
}

export function shiftPipelineTaskTimes(tasks: PipelineTask[], nowMs = Date.now()): PipelineTask[] {
  const latestUpdatedMs = tasks.reduce<number | null>((latest, task) => {
    const updatedMs = new Date(task.updatedAt).getTime();
    if (!Number.isFinite(updatedMs)) {
      return latest;
    }
    return latest === null || updatedMs > latest ? updatedMs : latest;
  }, null);
  if (latestUpdatedMs === null) {
    return tasks;
  }

  const offsetMs = nowMs - latestUpdatedMs;
  return tasks.map((task) => ({
    ...task,
    startedAt: shiftTimestamp(task.startedAt, offsetMs),
    endedAt: shiftTimestamp(task.endedAt, offsetMs),
    updatedAt: shiftTimestamp(task.updatedAt, offsetMs) ?? task.updatedAt,
  }));
}

function shiftTimestamp(value: string | undefined, offsetMs: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const timestampMs = new Date(value).getTime();
  if (!Number.isFinite(timestampMs)) {
    return value;
  }
  return new Date(timestampMs + offsetMs).toISOString();
}
