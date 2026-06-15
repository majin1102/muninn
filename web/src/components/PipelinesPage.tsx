import type { PipelineTask, PipelineTaskKind, PipelineTaskStatus, PipelineTasksResponse } from '@muninn/common';
import { ChevronDown, Eye, Search, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppClient } from '../lib/api.js';
import {
  filterPipelineTasks,
  type PipelineStatusFilter,
  type PipelineTaskFilter,
  type PipelineTimeFilter,
} from '../lib/pipeline-model.js';
import { asErrorMessage } from '../lib/utils.js';

type PipelinesPageProps = {
  client: AppClient;
};

type PipelineFilterMenu = 'type' | 'status' | 'time';

const TASK_FILTERS: Array<{ value: PipelineTaskFilter; label: string }> = [
  { value: 'all', label: 'Type: All' },
  { value: 'session-observing', label: 'Extraction' },
  { value: 'observation', label: 'Observation' },
  { value: 'wiki-compiling', label: 'Dreaming' },
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
  { value: 'all', label: 'All' },
  { value: 'last_6h', label: 'Last 6 hours' },
  { value: 'last_24h', label: 'Last 24 hours' },
  { value: 'last_7d', label: 'Last 7 days' },
  { value: 'last_30d', label: 'Last 30 days' },
];
const PIPELINE_REFRESH_INTERVAL_MS = 10_000;

export function PipelinesPage({ client }: PipelinesPageProps) {
  const [response, setResponse] = useState<PipelineTasksResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [taskFilter, setTaskFilter] = useState<PipelineTaskFilter>('all');
  const [statusFilter, setStatusFilter] = useState<PipelineStatusFilter>('all');
  const [timeFilter, setTimeFilter] = useState<PipelineTimeFilter>('last_24h');
  const [customFromDate, setCustomFromDate] = useState(() => dateInputValue(daysAgo(1)));
  const [customFromTime, setCustomFromTime] = useState('00:00');
  const [customToDate, setCustomToDate] = useState(() => dateInputValue(new Date()));
  const [customToTime, setCustomToTime] = useState('23:59');
  const [draftTimeFilter, setDraftTimeFilter] = useState<PipelineTimeFilter>('last_24h');
  const [draftCustomFromDate, setDraftCustomFromDate] = useState(() => dateInputValue(daysAgo(1)));
  const [draftCustomFromTime, setDraftCustomFromTime] = useState('00:00');
  const [draftCustomToDate, setDraftCustomToDate] = useState(() => dateInputValue(new Date()));
  const [draftCustomToTime, setDraftCustomToTime] = useState('23:59');
  const [inspectedTaskId, setInspectedTaskId] = useState<string | null>(null);
  const [openFilter, setOpenFilter] = useState<PipelineFilterMenu | null>(null);
  const requestSeqRef = useRef(0);
  const toolbarRef = useRef<HTMLDivElement>(null);

  const loadPipelineTasks = useCallback(async (options: { silent: boolean }, isCancelled: () => boolean) => {
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    const isStale = () => isCancelled() || requestSeq !== requestSeqRef.current;

    if (!options.silent) {
      setLoading(true);
    }
    setError(null);

    try {
      const nextResponse = await client.getPipelineTasks();
      if (isStale()) {
        return;
      }
      setResponse(nextResponse);
      setInspectedTaskId((currentTaskId) => (
        currentTaskId !== null && !nextResponse.tasks.some((task) => task.id === currentTaskId)
          ? null
          : currentTaskId
      ));
    } catch (loadError: unknown) {
      if (isStale()) {
        return;
      }
      if (!options.silent) {
        setResponse(null);
      }
      setError(asErrorMessage(loadError));
    } finally {
      if (!isStale() && !options.silent) {
        setLoading(false);
      }
    }
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    let refreshId: number | null = null;
    const isCancelled = () => cancelled;
    void loadPipelineTasks({ silent: false }, isCancelled).then(() => {
      if (cancelled) {
        return;
      }
      refreshId = window.setInterval(() => {
        void loadPipelineTasks({ silent: true }, isCancelled);
      }, PIPELINE_REFRESH_INTERVAL_MS);
    });

    return () => {
      cancelled = true;
      if (refreshId !== null) {
        window.clearInterval(refreshId);
      }
    };
  }, [loadPipelineTasks]);

  useEffect(() => {
    if (openFilter === null) {
      return;
    }

    const closeOnOutsidePointer = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && toolbarRef.current?.contains(event.target)) {
        return;
      }
      setOpenFilter(null);
    };

    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [openFilter]);

  const tasks = response?.tasks ?? [];
  const customTimeRange = useMemo(() => ({
    from: parseDateTime(customFromDate, customFromTime),
    to: parseDateTime(customToDate, customToTime),
  }), [customFromDate, customFromTime, customToDate, customToTime]);
  const visibleTasks = useMemo(
    () => filterPipelineTasks(tasks, taskFilter, statusFilter, timeFilter, customTimeRange),
    [customTimeRange, statusFilter, taskFilter, tasks, timeFilter],
  );
  const inspectedTask = tasks.find((task) => task.id === inspectedTaskId) ?? null;

  function syncDraftTimeFilter() {
    setDraftTimeFilter(timeFilter);
    if (timeFilter === 'custom') {
      setDraftCustomFromDate(customFromDate);
      setDraftCustomFromTime(customFromTime);
      setDraftCustomToDate(customToDate);
      setDraftCustomToTime(customToTime);
      return;
    }
    const range = resolvePresetRange(timeFilter);
    setDraftCustomFromDate(dateInputValue(range.from));
    setDraftCustomFromTime(timeInputValue(range.from));
    setDraftCustomToDate(dateInputValue(range.to));
    setDraftCustomToTime(timeInputValue(range.to));
  }

  function selectDraftTimeFilter(value: PipelineTimeFilter) {
    setDraftTimeFilter(value);
    if (value !== 'custom') {
      const range = resolvePresetRange(value);
      setDraftCustomFromDate(dateInputValue(range.from));
      setDraftCustomFromTime(timeInputValue(range.from));
      setDraftCustomToDate(dateInputValue(range.to));
      setDraftCustomToTime(timeInputValue(range.to));
    }
  }

  function applyDraftTimeFilter() {
    setTimeFilter(draftTimeFilter);
    setCustomFromDate(draftCustomFromDate);
    setCustomFromTime(draftCustomFromTime);
    setCustomToDate(draftCustomToDate);
    setCustomToTime(draftCustomToTime);
    setOpenFilter(null);
  }

  return (
    <section className={inspectedTask ? 'pipelines-page pipelines-page-inspecting' : 'pipelines-page'}>
      <div className="pipelines-content">
        <header className="pipelines-header">
          <div>
            <h1>
              Pipelines
            </h1>
            <div className="pipelines-subtitle-row">
              <p>Memory pipelines including session extracting, observing and dreaming...</p>
              <PipelineUpdatedAt updatedAt={response?.summary.updatedAt ?? null} />
            </div>
          </div>
        </header>

        <div ref={toolbarRef} className="pipelines-toolbar">
          <label className="pipeline-search">
            <Search aria-hidden="true" />
            <input type="search" placeholder="Search sessions, conversations..." readOnly />
          </label>
          <PipelineFilter<PipelineTaskFilter>
            id="type"
            label="Type"
            value={taskFilter}
            options={TASK_FILTERS}
            open={openFilter === 'type'}
            onToggle={() => setOpenFilter(openFilter === 'type' ? null : 'type')}
            onChange={(value) => {
              setTaskFilter(value);
              setOpenFilter(null);
            }}
          />
          <PipelineFilter<PipelineStatusFilter>
            id="status"
            label="Status"
            value={statusFilter}
            options={STATUS_FILTERS}
            open={openFilter === 'status'}
            onToggle={() => setOpenFilter(openFilter === 'status' ? null : 'status')}
            onChange={(value) => {
              setStatusFilter(value);
              setOpenFilter(null);
            }}
          />
          <PipelineTimeFilterControl
            value={timeFilter}
            open={openFilter === 'time'}
            draftValue={draftTimeFilter}
            draftFromDate={draftCustomFromDate}
            draftFromTime={draftCustomFromTime}
            draftToDate={draftCustomToDate}
            draftToTime={draftCustomToTime}
            onToggle={() => {
              if (openFilter !== 'time') {
                syncDraftTimeFilter();
              }
              setOpenFilter(openFilter === 'time' ? null : 'time');
            }}
            onSelectDraft={selectDraftTimeFilter}
            onFromDateChange={setDraftCustomFromDate}
            onFromTimeChange={setDraftCustomFromTime}
            onToDateChange={setDraftCustomToDate}
            onToTimeChange={setDraftCustomToTime}
            onApply={applyDraftTimeFilter}
          />
        </div>

        <PipelineSummary tasks={visibleTasks} />
        <PipelineStatusStrip tasks={visibleTasks} />

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
              selected={inspectedTaskId === task.id}
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

function PipelineUpdatedAt({ updatedAt }: { updatedAt: PipelineTasksResponse['summary']['updatedAt'] }) {
  return <span className="pipeline-updated-at">Updated at {formatTime(updatedAt)}</span>;
}

function PipelineSummary({ tasks }: { tasks: PipelineTask[] }) {
  const metrics = useMemo(() => summarizeVisiblePipelineTasks(tasks), [tasks]);
  return (
    <div className="pipeline-summary" aria-label="Pipeline summary">
      <UsageItem label="Input" metric={metrics.input} />
      <span className="pipeline-summary-divider" aria-hidden="true" />
      <UsageItem label="Output" metric={metrics.output} />
    </div>
  );
}

function PipelineStatusStrip({ tasks }: { tasks: PipelineTask[] }) {
  const metrics = useMemo(() => summarizeVisiblePipelineTasks(tasks), [tasks]);
  return (
    <div className="pipeline-status-strip" aria-label="Pipeline state">
      <SummaryItem status="running" label={`running ${metrics.running}`} />
      <SummaryItem status="done" label={`done ${metrics.done}`} />
      <SummaryItem status="queued" label={`queued ${metrics.queued}`} />
      <SummaryItem status="failed" label={`failed ${metrics.failed}`} />
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

function UsageItem({ label, metric }: { label: string; metric: PipelineTask['input'] }) {
  return (
    <span className="pipeline-summary-usage-item">
      <span className="pipeline-summary-usage-metric">
        <span className="pipeline-summary-usage-label">{label} Data</span>
        <span className="pipeline-summary-usage-value">{formatBytes(metric.bytes)}</span>
      </span>
      <span className="pipeline-summary-usage-metric">
        <span className="pipeline-summary-usage-label">{label} Tokens</span>
        <span className="pipeline-summary-usage-value">{formatTokenCount(metric.tokens)}</span>
      </span>
    </span>
  );
}

function PipelineFilter<T extends string>(props: {
  id: PipelineFilterMenu;
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  open: boolean;
  onToggle(): void;
  onChange(value: T): void;
}) {
  const selected = props.options.find((option) => option.value === props.value) ?? props.options[0];
  return (
    <div className={`toolbar-popover pipeline-filter-popover pipeline-filter-popover-${props.id}`}>
      <button
        className="session-filter pipeline-filter-trigger"
        type="button"
        aria-haspopup="menu"
        aria-expanded={props.open}
        onClick={props.onToggle}
      >
        <span>{selected?.label ?? props.label}</span>
        <ChevronDown aria-hidden="true" />
      </button>
      {props.open ? (
        <div className="session-popover pipeline-filter-menu" role="menu">
          <div className="session-popover-title">{props.label}</div>
          <div className="session-popover-section">
            {props.options.map((option) => (
              <button
                key={option.value}
                className={option.value === props.value ? 'session-menu-item session-menu-item-active' : 'session-menu-item'}
                type="button"
                role="menuitemradio"
                aria-checked={option.value === props.value}
                onClick={() => props.onChange(option.value)}
              >
                <span className={option.value === props.value ? 'menu-radio menu-radio-active' : 'menu-radio'} />
                <span>{option.label}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PipelineTimeFilterControl(props: {
  value: PipelineTimeFilter;
  open: boolean;
  draftValue: PipelineTimeFilter;
  draftFromDate: string;
  draftFromTime: string;
  draftToDate: string;
  draftToTime: string;
  onToggle(): void;
  onSelectDraft(value: PipelineTimeFilter): void;
  onFromDateChange(value: string): void;
  onFromTimeChange(value: string): void;
  onToDateChange(value: string): void;
  onToTimeChange(value: string): void;
  onApply(): void;
}) {
  return (
    <div className="toolbar-popover pipeline-filter-popover pipeline-filter-popover-time">
      <button
        className="session-filter session-time-filter pipeline-filter-trigger"
        type="button"
        aria-haspopup="menu"
        aria-expanded={props.open}
        onClick={props.onToggle}
      >
        <span>{pipelineTimeTriggerLabel(props.value)}</span>
        <ChevronDown aria-hidden="true" />
      </button>
      {props.open ? (
        <div className="session-popover session-time-popover pipeline-time-popover">
          <div className="time-filter-heading">Time Range</div>
          <div className="time-filter-card">
            <div className="session-popover-section">
              {TIME_FILTERS.map((preset) => (
                <button
                  key={preset.value}
                  className={props.draftValue === preset.value ? 'session-menu-item session-menu-item-active' : 'session-menu-item'}
                  type="button"
                  onClick={() => props.onSelectDraft(preset.value)}
                >
                  <span className={props.draftValue === preset.value ? 'menu-radio menu-radio-active' : 'menu-radio'} />
                  <span>{preset.label}</span>
                </button>
              ))}
              <button
                className={props.draftValue === 'custom' ? 'session-menu-item session-menu-item-active' : 'session-menu-item'}
                type="button"
                onClick={() => props.onSelectDraft('custom')}
              >
                <span className={props.draftValue === 'custom' ? 'menu-radio menu-radio-active' : 'menu-radio'} />
                <span>Custom</span>
              </button>
            </div>
            <div className={props.draftValue === 'custom' ? 'custom-time' : 'custom-time custom-time-disabled'}>
              <label className="time-input-row">
                <span>From</span>
                <input disabled={props.draftValue !== 'custom'} type="date" value={props.draftFromDate} onChange={(event) => props.onFromDateChange(event.target.value)} />
                <input disabled={props.draftValue !== 'custom'} type="time" value={props.draftFromTime} onChange={(event) => props.onFromTimeChange(event.target.value)} />
              </label>
              <label className="time-input-row">
                <span>To</span>
                <input disabled={props.draftValue !== 'custom'} type="date" value={props.draftToDate} onChange={(event) => props.onToDateChange(event.target.value)} />
                <input disabled={props.draftValue !== 'custom'} type="time" value={props.draftToTime} onChange={(event) => props.onToTimeChange(event.target.value)} />
              </label>
            </div>
          </div>
          <div className="custom-time-actions">
            <button type="button" className="time-action-button time-action-button-primary" onClick={props.onApply}>Apply</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PipelineCard({ task, selected, onInspect }: {
  task: PipelineTask;
  selected: boolean;
  onInspect(): void;
}) {
  return (
    <article
      className={selected ? `pipeline-card pipeline-card-${task.status} pipeline-card-selected` : `pipeline-card pipeline-card-${task.status}`}
    >
      <div className="pipeline-card-top">
        <span className={`pipeline-dot pipeline-dot-${task.status}`} />
        <div className="pipeline-card-title">
          <strong>{kindLabel(task.kind)}</strong>
          <span>{task.target}</span>
        </div>
        <span className={`pipeline-status-text pipeline-status-text-${task.status}`}>{statusLabel(task.status)}</span>
        <button
          className="pipeline-inspect-button"
          type="button"
          aria-label={`Inspect ${task.title}`}
          onClick={onInspect}
        >
          <Eye />
        </button>
      </div>
      <div className="pipeline-io-grid">
        <PipelineMetricBox label="Input" metric={task.input} status={task.status} />
        {task.output ? (
          <PipelineMetricBox label="Output" metric={task.output} status={task.status} />
        ) : (
          <PipelineToolCallsBox calls={task.toolCalls} status={task.status} />
        )}
      </div>
      <PipelineLifecycleLine task={task} />
    </article>
  );
}

function PipelineLifecycleLine({ task }: { task: PipelineTask }) {
  const createdAt = task.status === 'queued' ? task.updatedAt : task.startedAt;
  return (
    <p className="pipeline-lifecycle-line">
      <span>Created at {formatCreatedTime(createdAt)} Duration {durationForTask(task)}</span>
    </p>
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
      return 'Extraction';
    case 'observation':
      return 'Observation';
    case 'wiki-compiling':
      return 'Dreaming';
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

function toolCallItems(calls: PipelineTask['toolCalls']): string[] {
  return calls.map((call) => `${call.name} x ${call.count}`);
}

function pipelineTimeTriggerLabel(value: PipelineTimeFilter): string {
  if (value === 'all') {
    return 'Time: All';
  }
  if (value === 'custom') {
    return 'Custom';
  }
  return TIME_FILTERS.find((item) => item.value === value)?.label ?? 'Time';
}

function resolvePresetRange(value: PipelineTimeFilter): { from: Date; to: Date } {
  const to = new Date();
  if (value === 'all' || value === 'custom') {
    return {
      from: daysAgo(1),
      to,
    };
  }
  const hours = value === 'last_6h'
    ? 6
    : value === 'last_24h'
      ? 24
      : value === 'last_7d'
        ? 24 * 7
        : 24 * 30;
  return {
    from: new Date(to.getTime() - hours * 60 * 60 * 1000),
    to,
  };
}

function parseDateTime(date: string, time: string): Date | null {
  const value = new Date(`${date}T${time || '00:00'}:00`);
  return Number.isFinite(value.getTime()) ? value : null;
}

function daysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

function dateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function timeInputValue(date: Date): string {
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${hour}:${minute}`;
}

function summarizeVisiblePipelineTasks(tasks: PipelineTask[]): {
  running: number;
  queued: number;
  failed: number;
  done: number;
  input: PipelineTask['input'];
  output: PipelineTask['input'];
} {
  const summary = {
    running: 0,
    queued: 0,
    failed: 0,
    done: 0,
    input: { bytes: 0, tokens: 0 },
    output: { bytes: 0, tokens: 0 },
  };

  for (const task of tasks) {
    summary[task.status] += 1;
    summary.input.bytes += task.input.bytes;
    summary.input.tokens += task.input.tokens;
    if (task.output !== undefined) {
      summary.output.bytes += task.output.bytes;
      summary.output.tokens += task.output.tokens;
    }
  }

  return summary;
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

function formatTokenCount(tokens: number): string {
  if (tokens < 1000) {
    return String(tokens);
  }
  return `${formatNumber(tokens / 1000)}K`;
}

function formatNumber(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1);
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

function formatTime(value: string | undefined | null, includeSeconds = false): string {
  if (!value) {
    return 'unknown';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'unknown';
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: includeSeconds ? '2-digit' : undefined,
    hour12: false,
  }).format(date);
}

function formatCreatedTime(value: string | undefined | null): string {
  if (!value) {
    return 'unknown';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'unknown';
  }
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const time = formatClockTime(date);
  if (sameDay) {
    return time;
  }
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${time}`;
}

function formatClockTime(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
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
