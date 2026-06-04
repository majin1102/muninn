import type { PipelineTask, PipelineTaskKind, PipelineTaskStatus, PipelineTasksResponse } from '@muninn/types';

export type PipelineTaskFilter = PipelineTaskKind | 'all';
export type PipelineStatusFilter = PipelineTaskStatus | 'active' | 'all';
export type PipelineTimeFilter = 'last_24h' | 'last_7d' | 'all';

export function summarizePipelineTasks(tasks: PipelineTask[]): PipelineTasksResponse['summary'] {
  return {
    running: tasks.filter((task) => task.status === 'running').length,
    queued: tasks.filter((task) => task.status === 'queued').length,
    failed: tasks.filter((task) => task.status === 'failed').length,
    updatedAt: tasks.reduce<string | null>((latest, task) => (
      latest === null || task.updatedAt > latest ? task.updatedAt : latest
    ), null),
  };
}

export function defaultSelectedPipelineTaskId(tasks: PipelineTask[]): string | null {
  return (
    newestPipelineTask(tasks.filter((task) => task.status === 'running'))
    ?? newestPipelineTask(tasks.filter((task) => task.status === 'failed'))
    ?? newestPipelineTask(tasks.filter((task) => task.status === 'queued'))
    ?? newestPipelineTask(tasks.filter((task) => task.status === 'done'))
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

function newestPipelineTask(tasks: PipelineTask[]): PipelineTask | null {
  return [...tasks].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
}
