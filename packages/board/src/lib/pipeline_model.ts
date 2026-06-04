import type { PipelineTask, PipelineTaskKind, PipelineTaskStatus, PipelineTasksResponse } from '@muninn/types';

export type PipelineTaskFilter = PipelineTaskKind | 'all';
export type PipelineStatusFilter = PipelineTaskStatus | 'active' | 'all';
export type PipelineTimeFilter = 'last_24h' | 'last_7d' | 'all';

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
  nowMs = Date.now(),
): PipelineTask[] {
  const cutoff = timeFilter === 'all'
    ? null
    : nowMs - (timeFilter === 'last_24h' ? 24 : 24 * 7) * 60 * 60 * 1000;

  return tasks
    .filter((task) => taskFilter === 'all' || task.kind === taskFilter)
    .filter((task) => statusFilter === 'all' || (statusFilter === 'active' ? task.status !== 'done' : task.status === statusFilter))
    .filter((task) => cutoff === null || new Date(task.updatedAt).getTime() >= cutoff)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
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
