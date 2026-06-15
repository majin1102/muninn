# Pipelines Board Design

## Goal

Add a `Pipelines` view to Muninn Board for monitoring memory-processing work. The page should show active and recent processing tasks in a compact card-table list, with enough task input/output context for scanning and a right-side inspector for detailed review.

This view replaces implementation-centric labels in the UI. The user-facing task names are:

- `Session observing`
- `Observation`
- `Wiki compiling`

The current backend may still use extractor and observer terminology. The UI maps those internal concepts into the task names above.

## Scope

In scope:

- Add `Pipelines` as a first-level Board navigation item.
- Use a custom `Pipelines` icon: two vertical rails plus a right-side flow mark, matching lucide-style `24` viewBox, `2px` stroke, round caps and joins.
- Render a Pipelines page with a constrained main content width.
- Show task cards for session observing, observation, and wiki compiling work.
- Show card-level `Input` and `Output` summaries.
- Show a right-side inspector with `Input`, `Output`, `Trace`, and `Errors` tabs.
- Add search/filter controls as visual affordances even if search behavior is initially inert.
- Derive initial demo and API shapes from current watermark/checkpoint/run state where possible.

Out of scope:

- No new pipeline execution behavior.
- No schema migration for historical extractor/observer terms.
- No full search implementation for the `Search memories` control in the first pass.
- No new wiki compiler backend if it does not already exist. The UI can include demo/sample rows and a typed shape ready for future data.

## Information Architecture

The left sidebar gets a new item:

```text
Search
LLM Wiki
Session
Pipelines
Settings
```

`Pipelines` sits between `Session` and `Settings`. It uses the custom pipeline icon rather than a generic graph, activity, workflow, or route icon.

The page header uses:

```text
Pipelines
Observing, Dreaming, Wiki compiling..
```

The top-right summary is a single-line status row:

```text
green dot  1 running
orange dot 2 queued
red dot    1 failed
updated 4s ago
```

The summary must not wrap into multiple lines on normal desktop widths. If space is constrained, hide lower-priority segments before wrapping.

## Layout

The page has a main list area and an inspector area.

The main list area uses a centered content container with a maximum width around `980px`. The toolbar and cards share that same container. The toolbar controls and the cards must align on both the left and right edges.

The toolbar is a single-row grid:

```text
| Search memories                         | Task: All | Status: Active | Last 24h |
```

Rules:

- The visible toolbar controls span the same width as the cards below.
- The search control consumes the remaining width.
- Filter controls use fixed widths.
- The toolbar does not wrap on normal desktop widths.
- On narrow widths, prefer horizontal overflow or compact labels before wrapping.

The right inspector is closed by default and opens when a task is inspected. The desired interaction is:

- Default state shows no inspector and lets the list use the available width.
- Clicking the inspect icon opens the right inspector from the right and pushes the list area left.
- The inspector uses a fixed width around `340-360px`.
- Closing the inspector returns the list to full width.
- On narrow screens, the inspector becomes a bottom drawer.

## Task Cards

Cards are the primary list representation. They are not traditional table rows, but they behave like a dense card-table.

Each card contains:

- status dot
- task name
- target label
- inspect icon on the right
- status line
- `Input` summary
- `Output` summary

Example:

```text
green dot  Observation   Entity: Lance row id                    inspect icon
running · generating draft from 16 extractions · updated 4s ago

Input                                      Output
16 extractions from 3 turns       Observation draft in progress
```

Status text appears inline in the second line. Do not render `running`, `done`, `queued`, or `failed` as bordered pills inside cards. Use plain colored text:

- `running`: green text
- `queued`: orange text
- `failed`: red text
- `done`: muted gray text

Card background and border behavior:

- Running selected card: near-white background with a slightly stronger neutral border.
- Done and queued cards: white or subtle near-white background with neutral border.
- Failed cards: very light red background and red-tinted border.
- Avoid large color fills.

The inspect affordance uses an icon-only button, not an `Inspect` text link. It should have an accessible label and tooltip.

## Inspector

The inspector shows details for the selected task. It has:

- task title
- target label
- status text
- tab row: `Input`, `Output`, `Trace`, `Errors`

`Input` tab:

- source turns or extractions
- extraction or observation ids where available
- queue or batch metadata
- thresholds if relevant
- source excerpts when available

`Output` tab:

- generated draft text or summary
- committed observation ids
- wiki document ids or draft status
- link updates where available

`Trace` tab:

- stage timeline
- checkpoint ids
- trace refs
- timestamps
- retry or finalize context

`Errors` tab:

- phase
- message
- retry state
- relevant trace refs
- empty state text when there are no errors

## Filters

The first implementation exposes a compact toolbar:

- `Search memories`
- `Task: All`
- `Status: Active`
- `Last 24h`

`Search memories` is allowed to be non-functional in the first implementation. It should render as a disabled or inert search input if search is not implemented.

Filter semantics:

- `Task`: All, Session observing, Observation, Wiki compiling
- `Status`: Active, Running, Queued, Failed, Done, All
- `Time`: Last 24h, Last 7d, All

The active default is `Status: Active`, meaning running, queued, and failed tasks are shown before completed work.

## Data Model

Add a UI-facing pipeline task shape rather than exposing raw checkpoint internals directly:

```ts
export type PipelineTaskStatus = 'running' | 'queued' | 'failed' | 'done';

export type PipelineTaskKind =
  | 'session-observing'
  | 'observation'
  | 'wiki-compiling';

export type PipelineTask = {
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
};
```

Initial mapping:

- Current extractor work maps to `Session observing`.
- Current observer work maps to `Observation`.
- Future wiki compiler work maps to `Wiki compiling`.

Use existing watermark, checkpoint, run, and queue state to populate what is currently available. Missing future fields should render stable placeholders such as `Not started`, `Draft in progress`, or `No errors for this task`, not `undefined`.

## API Direction

The preferred board API is a UI endpoint such as:

```text
GET /api/v1/ui/pipelines/tasks
```

Response:

```ts
type PipelineTasksResponse = {
  summary: {
    running: number;
    queued: number;
    failed: number;
    updatedAt: string | null;
  };
  tasks: PipelineTask[];
};
```

If a dedicated endpoint is too large for the first implementation, the board server may derive this response from existing core APIs and checkpoint reads. The React UI should consume the normalized board API shape either way.

## Error Handling

- If the endpoint fails and no prior data exists, show `Pipelines unavailable`.
- If refresh fails after data has loaded, keep the previous tasks visible and mark the summary as stale.
- Failed pipeline tasks remain visible under `Status: Active`.
- Missing input/output details render empty-but-explicit text, not blank cards.

## Refresh Behavior

- Poll while the `Pipelines` route is active.
- A `2s` polling interval is acceptable for the first implementation.
- Stop polling when leaving the route.
- Preserve the selected task by id across refreshes when possible.
- If the selected task disappears, select the newest active task.

Default selection priority:

1. newest running task
2. newest failed task
3. newest queued task
4. newest done task

## Components

Keep the implementation focused:

- `PipelineIcon`
- `PipelinesPage`
- `PipelineToolbar`
- `PipelineSummary`
- `PipelineTaskCard`
- `PipelineInspector`
- `pipeline-model.ts` for mapping API responses or demo data into the UI shape

Do not introduce a broad board design system. Reuse existing CSS patterns and add only the styles needed for this page.

## Visual Style

Follow `docs/board-interaction-style.md`:

- compact `13px` UI baseline
- `12px` for compact metadata and filters
- neutral selected controls
- restrained status color
- cards no more than `8px` radius
- no hero section
- no decorative dashboard widgets

The page should feel like a Codex-style operational surface: dense, quiet, and inspectable.

## Testing

Minimum verification:

- `pnpm --filter @muninn/board build`
- targeted TypeScript checks for board client/server if the full build is blocked
- browser check for the Pipelines route in demo mode

Manual browser checks:

- Sidebar shows `Pipelines` with the custom icon.
- Header, summary, toolbar, and cards render at desktop width.
- Toolbar visible controls align with card left and right edges.
- Toolbar does not wrap on normal desktop width.
- Cards show task name, target, status line, input, and output.
- Failed card uses subtle red styling.
- Inspect icon opens the right inspector.
- Inspector tabs show Input, Output, Trace, and Errors.
- Closing inspector returns the list to full width if the implementation supports the collapsed state.
