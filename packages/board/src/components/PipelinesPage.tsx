import type { PipelineTask, PipelineTaskKind, PipelineTaskStatus, PipelineTasksResponse } from '@muninn/types';
import { ChevronDown, Circle, Eye, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { BoardClient } from '../lib/api.js';
import {
  defaultSelectedPipelineTaskId,
  filterPipelineTasks,
  type PipelineStatusFilter,
  type PipelineTaskFilter,
  type PipelineTimeFilter,
} from '../lib/pipeline_model.js';
import { asErrorMessage } from '../lib/utils.js';

type PipelinesPageProps = {
  client: BoardClient;
};

const TASK_FILTERS: Array<{ value: PipelineTaskFilter; label: string }> = [
  { value: 'all', label: 'Type: All' },
  { value: 'session-observing', label: 'Session observing' },
  { value: 'global-observing', label: 'Global observing' },
  { value: 'wiki-compiling', label: 'Wiki compiling' },
];

const STATUS_FILTERS: Array<{ value: PipelineStatusFilter; label: string }> = [
  { value: 'active', label: 'Status: Active' },
  { value: 'all', label: 'Status: All' },
  { value: 'running', label: 'Running' },
  { value: 'queued', label: 'Queued' },
  { value: 'failed', label: 'Failed' },
  { value: 'done', label: 'Done' },
];

const TIME_FILTERS: Array<{ value: PipelineTimeFilter; label: string }> = [
  { value: 'last_24h', label: 'Last 24h' },
  { value: 'last_7d', label: 'Last 7d' },
  { value: 'all', label: 'All time' },
];

export function PipelinesPage({ client }: PipelinesPageProps) {
  const [response, setResponse] = useState<PipelineTasksResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [taskFilter, setTaskFilter] = useState<PipelineTaskFilter>('all');
  const [statusFilter, setStatusFilter] = useState<PipelineStatusFilter>('all');
  const [timeFilter, setTimeFilter] = useState<PipelineTimeFilter>('last_24h');
  const [inspectedTaskId, setInspectedTaskId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    client.getPipelineTasks()
      .then((nextResponse) => {
        if (cancelled) {
          return;
        }
        setResponse(nextResponse);
        setInspectedTaskId(null);
      })
      .catch((loadError: unknown) => {
        if (cancelled) {
          return;
        }
        setResponse(null);
        setError(asErrorMessage(loadError));
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [client]);

  const tasks = response?.tasks ?? [];
  const visibleTasks = useMemo(
    () => filterPipelineTasks(tasks, taskFilter, statusFilter, timeFilter),
    [statusFilter, taskFilter, tasks, timeFilter],
  );
  const inspectedTask = tasks.find((task) => task.id === inspectedTaskId) ?? null;
  const fallbackTaskId = useMemo(() => defaultSelectedPipelineTaskId(visibleTasks), [visibleTasks]);

  return (
    <section className={inspectedTask ? 'pipelines-page pipelines-page-inspecting' : 'pipelines-page'}>
      <div className="pipelines-content">
        <header className="pipelines-header">
          <div>
            <h1>Pipelines</h1>
            <p>Observing, Dreaming, Wiki compiling..</p>
          </div>
          <PipelineSummary summary={response?.summary ?? null} />
        </header>

        <div className="pipelines-toolbar">
          <label className="pipeline-search">
            <Circle aria-hidden="true" />
            <input type="search" placeholder="Search memories" readOnly />
          </label>
          <PipelineSelect
            label="Task"
            value={taskFilter}
            options={TASK_FILTERS}
            onChange={(value) => setTaskFilter(value as PipelineTaskFilter)}
          />
          <PipelineSelect
            label="Status"
            value={statusFilter}
            options={STATUS_FILTERS}
            onChange={(value) => setStatusFilter(value as PipelineStatusFilter)}
          />
          <PipelineSelect
            label="Time"
            value={timeFilter}
            options={TIME_FILTERS}
            onChange={(value) => setTimeFilter(value as PipelineTimeFilter)}
          />
        </div>

        {loading ? <div className="pipeline-empty">Loading pipelines...</div> : null}
        {error ? <div className="pipeline-empty pipeline-empty-error">{error}</div> : null}
        {!loading && !error && visibleTasks.length === 0 ? (
          <div className="pipeline-empty">No pipeline tasks match the current filters.</div>
        ) : null}

        <div className="pipeline-list">
          {visibleTasks.map((task) => (
            <PipelineCard
              key={task.id}
              task={task}
              selected={inspectedTaskId === task.id || (!inspectedTaskId && fallbackTaskId === task.id)}
              onInspect={() => setInspectedTaskId(task.id)}
            />
          ))}
        </div>
      </div>

      {inspectedTask ? (
        <PipelineInspector task={inspectedTask} onClose={() => setInspectedTaskId(null)} />
      ) : null}
    </section>
  );
}

function PipelineSummary({ summary }: { summary: PipelineTasksResponse['summary'] | null }) {
  return (
    <div className="pipeline-summary" aria-label="Pipeline summary">
      <SummaryItem status="running" label={`${summary?.running ?? 0} running`} />
      <SummaryItem status="queued" label={`${summary?.queued ?? 0} queued`} />
      <SummaryItem status="failed" label={`${summary?.failed ?? 0} failed`} />
      <span>updated {relativeTime(summary?.updatedAt ?? null)}</span>
    </div>
  );
}

function SummaryItem({ status, label }: { status: PipelineTaskStatus; label: string }) {
  return (
    <span className="pipeline-summary-item">
      <span className={`pipeline-dot pipeline-dot-${status}`} />
      {label}
    </span>
  );
}

function PipelineSelect<T extends string>(props: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange(value: string): void;
}) {
  return (
    <label className="pipeline-select">
      <span className="sr-only">{props.label}</span>
      <select value={props.value} onChange={(event) => props.onChange(event.target.value)}>
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <ChevronDown aria-hidden="true" />
    </label>
  );
}

function PipelineCard({ task, selected, onInspect }: {
  task: PipelineTask;
  selected: boolean;
  onInspect(): void;
}) {
  return (
    <article className={selected ? `pipeline-card pipeline-card-${task.status} pipeline-card-selected` : `pipeline-card pipeline-card-${task.status}`}>
      <div className="pipeline-card-top">
        <span className={`pipeline-dot pipeline-dot-${task.status}`} />
        <div className="pipeline-card-title">
          <strong>{kindLabel(task.kind)}</strong>
          <span>{task.target}</span>
        </div>
        <span className={`pipeline-status-text pipeline-status-text-${task.status}`}>{statusLabel(task.status)}</span>
        <button className="pipeline-inspect-button" type="button" aria-label={`Inspect ${task.title}`} onClick={onInspect}>
          <Eye />
        </button>
      </div>
      <p className="pipeline-status-line">
        <span>{capitalizeSentence(task.statusText)}</span>
      </p>
      <div className="pipeline-io-grid">
        <PipelineMetricBox label="Input" metric={task.input} status={task.status} />
        {task.output ? (
          <PipelineMetricBox label="Output" metric={task.output} status={task.status} />
        ) : (
          <PipelineToolCallsBox calls={task.toolCalls} status={task.status} />
        )}
      </div>
      <p className="pipeline-lifecycle-line">{pipelineLifecycleSummary(task)}</p>
    </article>
  );
}

function PipelineMetricBox({ label, metric, status }: { label: string; metric: PipelineTask['input']; status: PipelineTaskStatus }) {
  return (
    <div className={`pipeline-io-box pipeline-io-box-${status}`}>
      <span>{label}</span>
      <strong className="pipeline-metric-value">
        <span>{formatBytes(metric.bytes)}</span>
        <span>{formatTokens(metric.tokens)}</span>
      </strong>
    </div>
  );
}

function PipelineToolCallsBox({ calls, status }: { calls: PipelineTask['toolCalls']; status: PipelineTaskStatus }) {
  const visibleCalls = calls.slice(0, 2);
  return (
    <div className={`pipeline-io-box pipeline-io-box-${status}`}>
      <span>Tool calls</span>
      {visibleCalls.length > 0 ? (
        <strong className="pipeline-metric-value">
          {visibleCalls.map((call) => (
            <span key={call.name}>{call.name} x {call.count}</span>
          ))}
        </strong>
      ) : null}
    </div>
  );
}

function PipelineInspector({ task, onClose }: { task: PipelineTask; onClose(): void }) {
  return (
    <aside className="pipeline-inspector">
      <div className="pipeline-inspector-header">
        <div>
          <span className={`pipeline-status-text pipeline-status-text-${task.status}`}>{statusLabel(task.status)}</span>
          <h2>{kindLabel(task.kind)}</h2>
          <p>{task.target}</p>
        </div>
        <button className="pipeline-inspector-close" type="button" aria-label="Close pipeline inspector" onClick={onClose}>
          <X />
        </button>
      </div>
      <dl className="pipeline-inspector-meta">
        {pipelineLifecycleDetails(task).map((item) => (
          <div key={item.label}>
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          </div>
        ))}
      </dl>
      <PipelineInspectorSection title="Input" items={task.inputDetails} fallback={`${formatBytes(task.input.bytes)} · ${formatTokens(task.input.tokens)}`} />
      <PipelineInspectorSection title="Tool calls" items={toolCallItems(task.toolCalls)} fallback="None yet" tone={task.toolCalls.length > 0 ? 'default' : 'muted'} />
      {task.output ? (
        <PipelineInspectorSection title="Output" items={task.outputDetails} fallback={`${formatBytes(task.output.bytes)} · ${formatTokens(task.output.tokens)}`} />
      ) : null}
      <PipelineInspectorSection title="Trace" items={task.trace} fallback={task.statusText} />
      <PipelineInspectorSection title="Errors" items={task.errors} fallback="No errors" tone={task.errors.length > 0 ? 'error' : 'muted'} />
    </aside>
  );
}

function PipelineInspectorSection({ title, items, fallback, tone = 'default' }: {
  title: string;
  items: string[];
  fallback: string;
  tone?: 'default' | 'error' | 'muted';
}) {
  const values = items.length > 0 ? items : [fallback];
  return (
    <section className={`pipeline-inspector-section pipeline-inspector-section-${tone}`}>
      <h3>{title}</h3>
      <ul>
        {values.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

function kindLabel(kind: PipelineTaskKind): string {
  switch (kind) {
    case 'session-observing':
      return 'Session observing';
    case 'global-observing':
      return 'Global observing';
    case 'wiki-compiling':
      return 'Wiki compiling';
  }
}

function statusLabel(status: PipelineTaskStatus): string {
  switch (status) {
    case 'running':
      return 'Running';
    case 'queued':
      return 'Queued';
    case 'failed':
      return 'Failed';
    case 'done':
      return 'Done';
  }
}

function capitalizeSentence(value: string): string {
  return value.length > 0 ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
}

function toolCallItems(calls: PipelineTask['toolCalls']): string[] {
  return calls.map((call) => `${call.name} x ${call.count}`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${formatNumber(kb)} KB`;
  }
  return `${formatNumber(kb / 1024)} MB`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) {
    return `${tokens} tokens`;
  }
  return `${formatNumber(tokens / 1000)}K tokens`;
}

function formatNumber(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1);
}

function pipelineLifecycleSummary(task: PipelineTask): string {
  const summary = `Duration ${durationForTask(task)}`;
  if (task.status === 'done' && task.toolCalls.length > 0) {
    return `${summary} · Tool calls: ${toolCallItems(task.toolCalls).join(' | ')}`;
  }
  return summary;
}

function pipelineLifecycleDetails(task: PipelineTask): Array<{ label: string; value: string }> {
  const endLabel = task.status === 'failed' ? 'Failed' : 'Ended';
  const endValue = task.status === 'running' || task.status === 'queued'
    ? 'In progress'
    : formatDateTime(task.endedAt ?? task.updatedAt);

  return [
    { label: task.status === 'queued' ? 'Queued' : 'Started', value: formatDateTime(task.status === 'queued' ? task.updatedAt : task.startedAt) },
    { label: endLabel, value: endValue },
    { label: 'Duration', value: durationForTask(task) },
    { label: 'Updated', value: formatDateTime(task.updatedAt) },
  ];
}

function durationForTask(task: PipelineTask): string {
  const start = task.status === 'queued' ? task.updatedAt : task.startedAt;
  const end = task.status === 'running' || task.status === 'queued'
    ? null
    : task.endedAt ?? task.updatedAt;
  return formatDuration(start, end);
}

function formatDateTime(value: string | undefined | null): string {
  if (!value) {
    return 'unknown';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'unknown';
  }
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function formatDuration(start: string | undefined | null, end: string | undefined | null): string {
  if (!start) {
    return 'unknown';
  }
  const startMs = new Date(start).getTime();
  const endMs = end ? new Date(end).getTime() : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return 'unknown';
  }
  const totalMinutes = Math.max(1, Math.round((endMs - startMs) / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) {
    return `${minutes}m`;
  }
  if (minutes === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${minutes}m`;
}

function relativeTime(value: string | null): string {
  if (!value) {
    return 'just now';
  }
  const diffMs = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) {
    return 'just now';
  }
  const seconds = Math.round(diffMs / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
}
