# Pipelines Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Muninn Board `Pipelines` view with task cards, aligned search/filter toolbar, custom icon, demo/API data, and an inspectable right-side task panel.

**Architecture:** Add a normalized `PipelineTask` API contract in `@muninn/types`, expose demo and board-server task responses, then render a new `PipelinesPage` route in `packages/board`. The first implementation prioritizes the approved UI and stable normalized shape; backend task data can be derived or demo-backed without adding new pipeline execution behavior.

**Tech Stack:** TypeScript, React 19, Vite, Hono, `@muninn/types`, `@muninn/core`, existing Board CSS.

---

## File Structure

- Modify `packages/types/src/api.ts`
  - Adds `PipelineTask`, `PipelineTasksResponse`, status/kind unions.
- Modify `packages/board/src/demo/data.ts`
  - Adds demo pipeline task rows.
- Modify `packages/board/src/demo/provider.ts`
  - Adds `getDemoPipelineTasks()`.
- Create `packages/board/src/lib/pipeline_model.ts`
  - Adds summary, default selection, and filter helpers for pipeline tasks.
- Modify `packages/board/src/lib/api.ts`
  - Adds `PrimaryView = 'pipelines'`, client method `getPipelineTasks()`, and imported types.
- Modify `packages/board/src/server/app.ts`
  - Adds `GET /api/v1/ui/pipelines/tasks`.
  - Returns a normalized response; first pass can use derived static data when core runtime detail is unavailable.
- Modify `packages/board/src/components/App.tsx`
  - Adds `Pipelines` nav item and route rendering.
  - Adds custom `PipelineIcon`.
- Create `packages/board/src/components/PipelinesPage.tsx`
  - Owns polling, selected task state, filters, toolbar, cards, inspector.
- Modify `packages/board/src/styles.css`
  - Adds scoped `.pipelines-*` styles.
- Create `packages/board/test/pipeline-model.test.mjs`
  - Tests summary, default selection, and filter behavior from `pipeline_model.ts`.

---

### Task 1: Add Shared Pipeline API Types

**Files:**
- Modify: `packages/types/src/api.ts`

- [ ] **Step 1: Add the API types**

Append these exports after `ObservingListResponse` and before `SettingsConfigResponse`:

```ts
export type PipelineTaskStatus = 'running' | 'queued' | 'failed' | 'done';

export type PipelineTaskKind =
  | 'session-observing'
  | 'observation'
  | 'wiki-compiling';

export interface PipelineTask {
  id: string;
  kind: PipelineTaskKind;
  title: string;
  target: string;
  status: PipelineTaskStatus;
  statusText: string;
  updatedAt: string;
  inputSummary: string;
  outputSummary: string;
  inputDetails: string[];
  outputDetails: string[];
  trace: string[];
  errors: string[];
}

export interface PipelineTasksResponse {
  summary: {
    running: number;
    queued: number;
    failed: number;
    updatedAt: string | null;
  };
  tasks: PipelineTask[];
  requestId: string;
}
```

- [ ] **Step 2: Run the types build**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/types build
```

Expected: command exits `0`.

- [ ] **Step 3: Commit**

Run:

```bash
git add packages/types/src/api.ts
git commit -m "feat: add pipeline task API types"
```

Expected: commit succeeds.

---

### Task 2: Add Pipeline Model Helpers And Demo Data

**Files:**
- Create: `packages/board/src/lib/pipeline_model.ts`
- Modify: `packages/board/src/demo/data.ts`
- Modify: `packages/board/src/demo/provider.ts`

- [ ] **Step 1: Create model helpers**

Create `packages/board/src/lib/pipeline_model.ts`:

```ts
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
```

- [ ] **Step 2: Extend demo data types**

In `packages/board/src/demo/data.ts`, import the new type and add an alias:

```ts
import type { PipelineTask, ToolCall } from '@muninn/types';

export type DemoPipelineTask = PipelineTask;
```

If the file already imports `ToolCall`, replace that import with the combined import above.

- [ ] **Step 3: Add demo tasks**

Append this export near the other demo exports:

```ts
export const demoPipelineTasks: DemoPipelineTask[] = [
  {
    id: 'pipeline:observation:lance-row-id',
    kind: 'observation',
    title: 'Observation',
    target: 'Entity: Lance row id',
    status: 'running',
    statusText: 'generating draft from 16 session observations',
    updatedAt: '2026-06-04T08:38:12.000Z',
    inputSummary: '16 session observations from 3 turns',
    outputSummary: 'Observation draft in progress',
    inputDetails: [
      '16 session observations',
      '3 source turns',
      'Batch: 16 / threshold 8',
    ],
    outputDetails: [
      'Draft observation markdown is being generated.',
      'Committed ids will appear after validation.',
    ],
    trace: [
      'selected input: done',
      'generating draft: running',
      'commit output: pending',
      'trace ref: observer-run-42',
    ],
    errors: ['No errors for this task.'],
  },
  {
    id: 'pipeline:session:codex-import-timeline',
    kind: 'session-observing',
    title: 'Session observing',
    target: 'codex session import timeline',
    status: 'done',
    statusText: 'produced 12 session observations and queued observation work',
    updatedAt: '2026-06-04T08:36:12.000Z',
    inputSummary: '100 turn window',
    outputSummary: '12 session observations',
    inputDetails: ['100 turn window', 'agent: codex'],
    outputDetails: ['12 session observations', 'queued observation work'],
    trace: [
      'read turns: done',
      'extracted observations: done',
      'queued observation work: done',
    ],
    errors: ['No errors for this task.'],
  },
  {
    id: 'pipeline:wiki:memory-architecture',
    kind: 'wiki-compiling',
    title: 'Wiki compiling',
    target: 'LLM Wiki: Memory architecture',
    status: 'queued',
    statusText: 'waiting for observations before compiling wiki draft',
    updatedAt: '2026-06-04T08:35:12.000Z',
    inputSummary: 'Observation tree',
    outputSummary: 'Wiki document draft',
    inputDetails: ['Observation tree'],
    outputDetails: ['Wiki document draft will be generated after input is ready.'],
    trace: ['waiting for observations'],
    errors: ['No errors for this task.'],
  },
  {
    id: 'pipeline:observation:prompt-design',
    kind: 'observation',
    title: 'Observation',
    target: 'Entity: Muninn prompt design',
    status: 'queued',
    statusText: 'waiting for session observations before observation rewrite',
    updatedAt: '2026-06-04T08:34:12.000Z',
    inputSummary: '5 session observations',
    outputSummary: 'Observation draft',
    inputDetails: ['5 session observations', 'below observer threshold'],
    outputDetails: ['Observation draft will start after threshold is reached.'],
    trace: ['waiting for more session observations'],
    errors: ['No errors for this task.'],
  },
  {
    id: 'pipeline:observation:board-settings',
    kind: 'observation',
    title: 'Observation',
    target: 'Entity: Board settings',
    status: 'failed',
    statusText: 'parser validation failed after 8 session observations · retry retained',
    updatedAt: '2026-06-04T08:32:12.000Z',
    inputSummary: '8 session observations',
    outputSummary: 'Blocked by parser validation',
    inputDetails: ['8 session observations', 'retry retained'],
    outputDetails: ['No committed output for this attempt.'],
    trace: [
      'selected input: done',
      'generated draft: done',
      'parser validation: failed',
    ],
    errors: ['parser validation failed'],
  },
];
```

- [ ] **Step 4: Add the provider helper**

In `packages/board/src/demo/provider.ts`, import `demoPipelineTasks` and `PipelineTasksResponse`:

```ts
import type { PipelineTasksResponse } from '@muninn/types';
```

Update the data import to include `demoPipelineTasks`. Import the summary helper:

```ts
import { summarizePipelineTasks } from '../lib/pipeline_model.js';
```

Then append:

```ts
export async function getDemoPipelineTasks(): Promise<PipelineTasksResponse> {
  return {
    summary: summarizePipelineTasks(demoPipelineTasks),
    tasks: demoPipelineTasks,
    requestId: 'demo-pipelines',
  };
}
```

- [ ] **Step 5: Run board TypeScript**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/board exec tsc -p tsconfig.json --noEmit
```

Expected: command exits `0`.

- [ ] **Step 6: Commit**

Run:

```bash
git add packages/board/src/lib/pipeline_model.ts packages/board/src/demo/data.ts packages/board/src/demo/provider.ts
git commit -m "feat: add pipeline demo data"
```

Expected: commit succeeds.

---

### Task 3: Add Board Client And Server Endpoint

**Files:**
- Modify: `packages/board/src/lib/api.ts`
- Modify: `packages/board/src/server/app.ts`

- [ ] **Step 1: Update the board client contract**

In `packages/board/src/lib/api.ts`, add imports:

```ts
import type {
  PipelineTasksResponse,
} from '@muninn/types';
```

Merge that with the existing `@muninn/types` import rather than creating a duplicate import.

Change:

```ts
export type PrimaryView = 'search' | 'wiki' | 'session' | 'settings';
```

to:

```ts
export type PrimaryView = 'search' | 'wiki' | 'session' | 'pipelines' | 'settings';
```

Add to `BoardClient`:

```ts
getPipelineTasks(): Promise<PipelineTasksResponse>;
```

Import `getDemoPipelineTasks` from `../demo/provider.js`, then add this method in `createBoardClient()`:

```ts
async getPipelineTasks() {
  return usesDemoData
    ? await getDemoPipelineTasks()
    : await fetchJson<PipelineTasksResponse>('/api/v1/ui/pipelines/tasks');
},
```

- [ ] **Step 2: Add the server endpoint**

In `packages/board/src/server/app.ts`, add `PipelineTask` and `PipelineTasksResponse` to the `@muninn/types` import.

Add this helper near the other UI helpers:

```ts
function pipelineTaskResponse(tasks: PipelineTask[]): PipelineTasksResponse {
  return {
    summary: {
      running: tasks.filter((task) => task.status === 'running').length,
      queued: tasks.filter((task) => task.status === 'queued').length,
      failed: tasks.filter((task) => task.status === 'failed').length,
      updatedAt: tasks.reduce<string | null>((latest, task) => (
        latest === null || task.updatedAt > latest ? task.updatedAt : latest
      ), null),
    },
    tasks,
    requestId: generateRequestId(),
  };
}

async function loadPipelineTasks(): Promise<PipelineTask[]> {
  const now = new Date().toISOString();
  return [
    {
      id: 'pipeline:observation:runtime',
      kind: 'observation',
      title: 'Observation',
      target: 'Runtime observer queue',
      status: 'queued',
      statusText: 'waiting for queued observations',
      updatedAt: now,
      inputSummary: 'Observer queue snapshot',
      outputSummary: 'Not started',
      inputDetails: ['Observer queue snapshot'],
      outputDetails: ['Not started'],
      trace: ['Runtime pipeline detail endpoint is not yet connected to checkpoint internals.'],
      errors: ['No errors for this task.'],
    },
  ];
}
```

Add the route:

```ts
boardApp.get('/api/v1/ui/pipelines/tasks', async (context) => {
  try {
    return context.json(pipelineTaskResponse(await loadPipelineTasks()));
  } catch (error) {
    const mapped = mapCoreLookupError(error);
    return context.json(mapped.body, mapped.status as 500);
  }
});
```

This intentionally avoids adding new core behavior. A later task can improve `loadPipelineTasks()` to read checkpoint detail.

- [ ] **Step 3: Run board server TypeScript**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/board exec tsc -p tsconfig.server.json --noEmit
```

Expected: command exits `0`.

- [ ] **Step 4: Commit**

Run:

```bash
git add packages/board/src/lib/api.ts packages/board/src/server/app.ts
git commit -m "feat: add pipelines board API"
```

Expected: commit succeeds.

---

### Task 4: Add The Pipelines Page Component

**Files:**
- Create: `packages/board/src/components/PipelinesPage.tsx`

- [ ] **Step 1: Create the component**

Create `packages/board/src/components/PipelinesPage.tsx` with:

```tsx
import type { PipelineTask } from '@muninn/types';
import { Eye, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { BoardClient } from '../lib/api.js';
import {
  defaultSelectedPipelineTaskId,
  filterPipelineTasks,
  type PipelineStatusFilter,
  type PipelineTaskFilter,
  type PipelineTimeFilter,
} from '../lib/pipeline_model.js';
import { formatRelativeTime, formatTimestamp } from '../lib/utils.js';

type PipelinesPageProps = {
  client: BoardClient;
};

export function PipelinesPage({ client }: PipelinesPageProps) {
  const [tasks, setTasks] = useState<PipelineTask[]>([]);
  const [summary, setSummary] = useState({ running: 0, queued: 0, failed: 0, updatedAt: null as string | null });
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskFilter, setTaskFilter] = useState<PipelineTaskFilter>('all');
  const [statusFilter, setStatusFilter] = useState<PipelineStatusFilter>('active');
  const [timeFilter, setTimeFilter] = useState<PipelineTimeFilter>('last_24h');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await client.getPipelineTasks();
        if (cancelled) {
          return;
        }
        setTasks(response.tasks);
        setSummary(response.summary);
        setError(null);
        setSelectedTaskId((current) => (
          current && response.tasks.some((task) => task.id === current)
            ? current
            : defaultSelectedPipelineTaskId(response.tasks)
        ));
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : String(nextError));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();
    const interval = window.setInterval(() => void load(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [client]);

  const filteredTasks = useMemo(() => filterPipelineTasks(tasks, taskFilter, statusFilter, timeFilter), [tasks, taskFilter, statusFilter, timeFilter]);
  const selectedTask = filteredTasks.find((task) => task.id === selectedTaskId)
    ?? tasks.find((task) => task.id === selectedTaskId)
    ?? filteredTasks[0]
    ?? null;

  if (loading && tasks.length === 0) {
    return <div className="pipelines-empty">Loading pipelines...</div>;
  }

  if (error && tasks.length === 0) {
    return <div className="pipelines-empty">Pipelines unavailable.</div>;
  }

  return (
    <div className="pipelines-page">
      <div className="pipelines-main">
        <div className="pipelines-content">
          <header className="pipelines-header">
            <div>
              <h1>Pipelines</h1>
              <p>Observing, Dreaming, Wiki compiling..</p>
            </div>
            <PipelineSummary running={summary.running} queued={summary.queued} failed={summary.failed} updatedAt={summary.updatedAt} />
          </header>
          <PipelineToolbar
            taskFilter={taskFilter}
            statusFilter={statusFilter}
            timeFilter={timeFilter}
            onTaskFilterChange={setTaskFilter}
            onStatusFilterChange={setStatusFilter}
            onTimeFilterChange={setTimeFilter}
          />
          <div className="pipelines-list">
            {filteredTasks.map((task) => (
              <PipelineTaskCard
                key={task.id}
                task={task}
                selected={selectedTask?.id === task.id}
                onInspect={() => setSelectedTaskId(task.id)}
              />
            ))}
          </div>
        </div>
      </div>
      {selectedTask ? <PipelineInspector task={selectedTask} /> : null}
    </div>
  );
}

function PipelineSummary({ running, queued, failed, updatedAt }: { running: number; queued: number; failed: number; updatedAt: string | null }) {
  return (
    <div className="pipelines-summary">
      <span><span className="pipeline-dot pipeline-dot-running" />{running} running</span>
      <span><span className="pipeline-dot pipeline-dot-queued" />{queued} queued</span>
      <span><span className="pipeline-dot pipeline-dot-failed" />{failed} failed</span>
      <span>{updatedAt ? `updated ${formatRelativeTime(updatedAt)}` : 'not updated yet'}</span>
    </div>
  );
}

function PipelineToolbar({
  taskFilter,
  statusFilter,
  timeFilter,
  onTaskFilterChange,
  onStatusFilterChange,
  onTimeFilterChange,
}: {
  taskFilter: PipelineTaskFilter;
  statusFilter: PipelineStatusFilter;
  timeFilter: PipelineTimeFilter;
  onTaskFilterChange: (value: PipelineTaskFilter) => void;
  onStatusFilterChange: (value: PipelineStatusFilter) => void;
  onTimeFilterChange: (value: PipelineTimeFilter) => void;
}) {
  return (
    <div className="pipelines-toolbar">
      <label className="pipelines-search" aria-label="Search memories">
        <Search />
        <input value="" readOnly placeholder="Search memories" />
      </label>
      <select value={taskFilter} onChange={(event) => onTaskFilterChange(event.target.value as PipelineTaskFilter)}>
        <option value="all">Task: All</option>
        <option value="session-observing">Session observing</option>
        <option value="observation">Observation</option>
        <option value="wiki-compiling">Wiki compiling</option>
      </select>
      <select value={statusFilter} onChange={(event) => onStatusFilterChange(event.target.value as PipelineStatusFilter)}>
        <option value="active">Status: Active</option>
        <option value="running">Running</option>
        <option value="queued">Queued</option>
        <option value="failed">Failed</option>
        <option value="done">Done</option>
        <option value="all">All</option>
      </select>
      <select value={timeFilter} onChange={(event) => onTimeFilterChange(event.target.value as PipelineTimeFilter)}>
        <option value="last_24h">Last 24h</option>
        <option value="last_7d">Last 7d</option>
        <option value="all">All time</option>
      </select>
    </div>
  );
}

function PipelineTaskCard({ task, selected, onInspect }: { task: PipelineTask; selected: boolean; onInspect: () => void }) {
  return (
    <article className={`pipeline-card pipeline-card-${task.status}${selected ? ' pipeline-card-selected' : ''}`}>
      <div className="pipeline-card-heading">
        <div className="pipeline-card-title">
          <span className={`pipeline-dot pipeline-dot-${task.status}`} />
          <strong>{task.title}</strong>
          <span>{task.target}</span>
        </div>
        <button type="button" className="pipeline-inspect-button" title="Inspect task" aria-label={`Inspect ${task.title}`} onClick={onInspect}>
          <Eye />
        </button>
      </div>
      <p className="pipeline-status-line">
        <strong className={`pipeline-status-text pipeline-status-${task.status}`}>{statusLabel(task.status)}</strong>
        <span> · {task.statusText} · {formatRelativeTime(task.updatedAt)}</span>
      </p>
      <div className="pipeline-card-details">
        <div>
          <span>Input</span>
          <p>{task.inputSummary}</p>
        </div>
        <div>
          <span>Output</span>
          <p>{task.outputSummary}</p>
        </div>
      </div>
    </article>
  );
}

function PipelineInspector({ task }: { task: PipelineTask }) {
  return (
    <aside className="pipeline-inspector">
      <div className="pipeline-inspector-header">
        <div>
          <h2>{task.title}</h2>
          <p>{task.target}</p>
        </div>
        <strong className={`pipeline-status-text pipeline-status-${task.status}`}>{statusLabel(task.status)}</strong>
      </div>
      <div className="pipeline-inspector-tabs">
        <span className="pipeline-inspector-tab-active">Input</span>
        <span>Output</span>
        <span>Trace</span>
        <span>Errors</span>
      </div>
      <PipelineDetailSection title="Input" items={task.inputDetails} />
      <PipelineDetailSection title="Output" items={task.outputDetails} />
      <PipelineDetailSection title="Trace" items={task.trace} />
      <PipelineDetailSection title="Errors" items={task.errors} />
    </aside>
  );
}

function PipelineDetailSection({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="pipeline-detail-section">
      <h3>{title}</h3>
      {items.map((item) => <p key={item}>{item}</p>)}
    </section>
  );
}

function statusLabel(status: PipelineTask['status']): string {
  return status === 'done' ? 'done' : status;
}
```

- [ ] **Step 2: Run TypeScript and expect missing CSS only if class names are unstyled**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/board exec tsc -p tsconfig.json --noEmit
```

Expected: command exits `0`.

- [ ] **Step 3: Commit**

Run:

```bash
git add packages/board/src/components/PipelinesPage.tsx
git commit -m "feat: add pipelines page component"
```

Expected: commit succeeds.

---

### Task 5: Wire The Route And Sidebar Icon

**Files:**
- Modify: `packages/board/src/components/App.tsx`

- [ ] **Step 1: Import the page and add icon support**

In `packages/board/src/components/App.tsx`, add:

```tsx
import { PipelinesPage } from './PipelinesPage.js';
```

Add this component near `GitHubMark()`:

```tsx
function PipelineIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 6v12" />
      <path d="M13 6v12" />
      <path d="M18 9l3 3-3 3" />
    </svg>
  );
}
```

Change the `navItems` type to allow function icons:

```ts
const navItems: Array<{ view: PrimaryView; label: string; icon: typeof Search | typeof PipelineIcon }> = [
  { view: 'search', label: 'Search', icon: Search },
  { view: 'wiki', label: 'LLM Wiki', icon: BookOpen },
  { view: 'session', label: 'Session', icon: FileText },
  { view: 'pipelines', label: 'Pipelines', icon: PipelineIcon },
  { view: 'settings', label: 'Settings', icon: Settings },
];
```

- [ ] **Step 2: Render the route**

In the non-session branch, render:

```tsx
{route.view === 'settings' ? (
  <SettingsPage client={client} />
) : route.view === 'pipelines' ? (
  <PipelinesPage client={client} />
) : (
  <EmptyView view={route.view} />
)}
```

Update `parseRoute()` to accept `pipelines`:

```ts
if (view === 'search' || view === 'wiki' || view === 'pipelines' || view === 'settings') {
  return { view, memoryId: null };
}
```

- [ ] **Step 3: Run TypeScript**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/board exec tsc -p tsconfig.json --noEmit
```

Expected: command exits `0`.

- [ ] **Step 4: Commit**

Run:

```bash
git add packages/board/src/components/App.tsx
git commit -m "feat: add pipelines board route"
```

Expected: commit succeeds.

---

### Task 6: Add Pipelines CSS

**Files:**
- Modify: `packages/board/src/styles.css`

- [ ] **Step 1: Append scoped CSS**

Append near the other page-level styles:

```css
.pipelines-page {
  display: grid;
  grid-template-columns: minmax(620px, 1fr) 352px;
  min-height: 100%;
  background: #fff;
}

.pipelines-main {
  min-width: 0;
  overflow: auto;
}

.pipelines-content {
  max-width: 980px;
  margin: 0 auto;
  padding: 22px 24px 48px;
}

.pipelines-header {
  display: flex;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 16px;
}

.pipelines-header h1 {
  margin: 0 0 5px;
  font-size: 13px;
  font-weight: 600;
}

.pipelines-header p,
.pipelines-summary {
  color: var(--text-muted);
  font-size: 12px;
}

.pipelines-summary {
  display: flex;
  align-items: center;
  gap: 12px;
  white-space: nowrap;
}

.pipeline-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 999px;
  flex: 0 0 auto;
}

.pipeline-dot-running,
.pipeline-dot-done {
  background: #2aa84a;
}

.pipeline-dot-queued {
  background: #d9822b;
}

.pipeline-dot-failed {
  background: #c33838;
}

.pipelines-summary .pipeline-dot {
  width: 7px;
  height: 7px;
  margin-right: 5px;
}

.pipelines-toolbar {
  display: grid;
  grid-template-columns: minmax(210px, 1fr) 108px 128px 96px;
  gap: 8px;
  align-items: center;
  width: 100%;
  margin-bottom: 12px;
}

.pipelines-search,
.pipelines-toolbar select {
  height: 32px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: #fff;
  color: var(--text-muted);
  font-size: 12px;
}

.pipelines-search {
  display: flex;
  align-items: center;
  padding: 0 10px;
  min-width: 0;
}

.pipelines-search svg {
  width: 14px;
  height: 14px;
  margin-right: 8px;
  color: var(--text-subtle);
}

.pipelines-search input {
  width: 100%;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
}

.pipelines-toolbar select {
  padding: 0 10px;
}

.pipelines-list {
  display: grid;
  gap: 10px;
}

.pipeline-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #fff;
  padding: 13px 14px;
}

.pipeline-card-selected {
  border-color: #cfd4db;
  background: #fbfbfb;
}

.pipeline-card-failed {
  border-color: #f0d3d3;
  background: #fffafa;
}

.pipeline-card-heading {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 7px;
}

.pipeline-card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.pipeline-card-title strong {
  font-weight: 600;
}

.pipeline-card-title span:last-child {
  color: var(--text-muted);
}

.pipeline-inspect-button {
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  padding: 0;
}

.pipeline-inspect-button:hover {
  background: var(--muted-surface);
}

.pipeline-inspect-button svg {
  width: 16px;
  height: 16px;
}

.pipeline-status-line {
  margin: 0 0 10px 16px;
  color: var(--text-muted);
  font-size: 12px;
}

.pipeline-status-text {
  font-weight: 600;
}

.pipeline-status-running {
  color: #287a3e;
}

.pipeline-status-queued {
  color: #9a5b16;
}

.pipeline-status-failed {
  color: #9b2929;
}

.pipeline-status-done {
  color: var(--text-muted);
}

.pipeline-card-details {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-left: 16px;
}

.pipeline-card-details > div,
.pipeline-detail-section {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
}

.pipeline-card-details span {
  display: block;
  margin-bottom: 5px;
  color: var(--text-subtle);
  font-size: 12px;
}

.pipeline-card-details p {
  margin: 0;
}

.pipeline-inspector {
  border-left: 1px solid var(--border);
  padding: 18px;
  overflow: auto;
  background: #fff;
}

.pipeline-inspector-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.pipeline-inspector-header h2 {
  margin: 0 0 5px;
  font-size: 13px;
  font-weight: 600;
}

.pipeline-inspector-header p {
  margin: 0;
  color: var(--text-subtle);
  font-size: 12px;
}

.pipeline-inspector-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 12px;
}

.pipeline-inspector-tabs span {
  padding: 6px 9px;
  border-radius: 6px;
  color: var(--text-muted);
}

.pipeline-inspector-tabs .pipeline-inspector-tab-active {
  background: var(--muted-surface);
  color: var(--text);
  font-weight: 600;
}

.pipeline-detail-section {
  margin-bottom: 10px;
}

.pipeline-detail-section h3 {
  margin: 0 0 7px;
  font-size: 13px;
  font-weight: 600;
}

.pipeline-detail-section p {
  margin: 0 0 4px;
  color: var(--text-muted);
  line-height: 1.5;
}

.pipelines-empty {
  padding: 38px 32px;
  color: var(--text-muted);
}

@media (max-width: 920px) {
  .pipelines-page {
    grid-template-columns: 1fr;
  }

  .pipeline-inspector {
    border-left: 0;
    border-top: 1px solid var(--border);
  }
}
```

- [ ] **Step 2: Run board TypeScript**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/board exec tsc -p tsconfig.json --noEmit
```

Expected: command exits `0`.

- [ ] **Step 3: Commit**

Run:

```bash
git add packages/board/src/styles.css
git commit -m "feat: style pipelines board"
```

Expected: commit succeeds.

---

### Task 7: Add Focused Tests

**Files:**
- Create: `packages/board/test/pipeline-model.test.mjs`

- [ ] **Step 1: Add focused model tests**

Create `packages/board/test/pipeline-model.test.mjs`:

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/lib/pipeline_model.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const {
  defaultSelectedPipelineTaskId,
  filterPipelineTasks,
  summarizePipelineTasks,
} = await import(moduleUrl);

const tasks = [
  {
    id: 'done',
    kind: 'session-observing',
    title: 'Session observing',
    target: 'session',
    status: 'done',
    statusText: 'done',
    updatedAt: '2026-06-04T08:31:00.000Z',
    inputSummary: 'input',
    outputSummary: 'output',
    inputDetails: ['input'],
    outputDetails: ['output'],
    trace: ['trace'],
    errors: ['No errors for this task.'],
  },
  {
    id: 'queued',
    kind: 'wiki-compiling',
    title: 'Wiki compiling',
    target: 'wiki',
    status: 'queued',
    statusText: 'queued',
    updatedAt: '2026-06-04T08:32:00.000Z',
    inputSummary: 'input',
    outputSummary: 'output',
    inputDetails: ['input'],
    outputDetails: ['output'],
    trace: ['trace'],
    errors: ['No errors for this task.'],
  },
  {
    id: 'failed',
    kind: 'observation',
    title: 'Observation',
    target: 'entity',
    status: 'failed',
    statusText: 'failed',
    updatedAt: '2026-06-04T08:33:00.000Z',
    inputSummary: 'input',
    outputSummary: 'output',
    inputDetails: ['input'],
    outputDetails: ['output'],
    trace: ['trace'],
    errors: ['parser failed'],
  },
  {
    id: 'running',
    kind: 'observation',
    title: 'Observation',
    target: 'entity',
    status: 'running',
    statusText: 'running',
    updatedAt: '2026-06-04T08:34:00.000Z',
    inputSummary: 'input',
    outputSummary: 'output',
    inputDetails: ['input'],
    outputDetails: ['output'],
    trace: ['trace'],
    errors: ['No errors for this task.'],
  },
];

test('summarizePipelineTasks counts active task states', () => {
  assert.deepEqual(summarizePipelineTasks(tasks), {
    running: 1,
    queued: 1,
    failed: 1,
    updatedAt: '2026-06-04T08:34:00.000Z',
  });
});

test('defaultSelectedPipelineTaskId prefers newest running task', () => {
  assert.equal(defaultSelectedPipelineTaskId(tasks), 'running');
});

test('filterPipelineTasks applies active status and task filters', () => {
  const filtered = filterPipelineTasks(
    tasks,
    'observation',
    'active',
    'last_24h',
    new Date('2026-06-04T09:00:00.000Z').getTime(),
  );
  assert.deepEqual(filtered.map((task) => task.id), ['running', 'failed']);
});
```

- [ ] **Step 2: Run the focused test**

Run:

```bash
source ~/.zprofile && node --test packages/board/test/pipeline-model.test.mjs
```

Expected: test exits `0`.

- [ ] **Step 3: Commit**

Run:

```bash
git add packages/board/test/pipeline-model.test.mjs
git commit -m "test: cover pipeline demo tasks"
```

Expected: commit succeeds.

---

### Task 8: Final Verification

**Files:**
- No new files unless verification finds issues.

- [ ] **Step 1: Run board build**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/board build
```

Expected: command exits `0`.

- [ ] **Step 2: Start demo app**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/board exec vite --host 127.0.0.1
```

Expected: Vite prints a local URL, usually `http://127.0.0.1:5173/`.

- [ ] **Step 3: Browser-check the route**

Open:

```text
http://127.0.0.1:5173/?demo=1#/pipelines
```

Expected:

- Sidebar shows `Pipelines`.
- Custom icon shows two rails plus right-side flow mark.
- Header says `Pipelines`.
- Subtitle says `Observing, Dreaming, Wiki compiling..`.
- Summary stays on one line.
- Toolbar visible controls align with card left and right edges.
- Cards show status line plus `Input` and `Output`.
- Inspect icon updates the inspector.

- [ ] **Step 4: Commit any final fixes**

If browser or build verification required fixes, stage the exact files changed by the fix. For example, if only layout CSS changed:

```bash
git add packages/board/src/styles.css
git commit -m "fix: polish pipelines board"
```

Expected: only commit if files changed.
