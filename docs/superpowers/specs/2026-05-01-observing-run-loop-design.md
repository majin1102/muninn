# Observing Run Loop Design

Date: 2026-05-01

## Summary

Muninn's observing write path should move to an observation-first staged loop.

The MVP serves only the observing write path. It does not design or implement an LLM-driven recall-time agent loop. Recall-time progressive expansion remains a consumer of the memory APIs.

The main shift is that `Observation` becomes a first-class memory object. Atomic observations are committed before thread construction, so high-value point memories remain recallable even when thread preparation or thread observing fails.

## Goals

- Extract durable, grounded, self-contained observations from sealed session turns.
- Store each observation as a public memory object with id `observation:{id}`.
- Keep observing threads as a higher-level synthesis layer over related observations.
- Use checkpoint only to recover runtime state that has not been persisted yet.
- Avoid new ledger tables.
- Remove old `semanticIndex` naming and compatibility paths.

## Non-Goals

- No recall-time agent loop in this MVP.
- No backwards compatibility for old `semanticIndex` config or table names.
- No free-form `memory_search` tool inside thread preparation.
- No new stage ledger table.
- No hard dependency on a third-party agent-loop SDK.

## Pipeline

The observing write path is split into these stages:

```text
Seal Epoch
-> Observation Extraction
-> Observation Commit
-> Observation Review
-> Thread Preparation
-> Thread Observing
-> Snapshot Commit
-> Snapshot Index
-> Finalize ObservingRun
```

### Seal Epoch

`Seal Epoch` freezes the current input turn set.

Output:

- `epoch`
- `inputTurnIds`
- sealed `SessionTurn[]`

All later stages run against this frozen input boundary.

### Observation Extraction

`Observation Extraction` turns sealed session turns into `ObservationInput[]`.

This stage is a structured LLM call, not a tool loop. It should keep inference low and focus on grounded, self-contained observations. It does not search history, build threads, update old observations, or synthesize thread state.

Extraction output uses observation input terminology, not draft/candidate terminology:

```ts
type ObservationInput = {
  text: string;
  category: ObservationCategory;
  references: string[];
};
```

`references` should normally point to source session turn memory ids such as `session:{id}`.

For MVP, extraction failure is epoch-level failure. Per-turn partial extraction can be added later if needed.

### Observation Commit

`Observation Commit` writes extracted observations into the `observation` table.

The `observation` table is the fact source and also stores vectors for nearest-neighbor recall. There is no separate semantic-index fact table.

Committed observation ids are stored in `ObservingRun.committed.observationIds` as bare ids.

This field tracks only atomic observations committed by `Observation Commit` for this run. Thread-level observations produced later by `Snapshot Index` are recovered through observing snapshot state and existing snapshot indexing checkpoints, not through this field.

### Observation Review

`Observation Review` is separate from thread preparation.

Input:

- newly committed observations from this run
- pre-recalled related old observations

Output:

- `removeObservationIds`
- `reviewedObservationIds`

This stage may remove duplicate, noisy, stale, or superseded observations. It does not generate new observations and does not rewrite observation text.

Review can remove both new and old observations, as long as the old observations were included in the review candidate set.

`reviewedObservationIds` is the subset of this run's committed atomic observations that remains eligible for thread preparation after removals.

### Thread Preparation

`Thread Preparation` replaces the old gateway responsibility, but its input is observations rather than raw turns.

Input:

- reviewed observations
- active observing thread lightweight views
- pre-recalled candidate memory summaries

Output:

```ts
type ThreadWorkItem = {
  observationIds: string[];
  targetThreadId?: string;
  newThreadTitle?: string;
  rationale: string;
};

type ThreadPreparationResult = {
  workItems: ThreadWorkItem[];
  unthreadedObservationIds: string[];
};
```

Rules:

- Each reviewed observation must be covered exactly once by a work item or by `unthreadedObservationIds`.
- A new thread requires at least two related observations.
- A single observation may append to an existing thread, but cannot create a new thread.
- `newThreadTitle` is only a working title for initialization. `Thread Observing` owns the final title.
- `rationale` is trace-only. It is not stored in observations or observing snapshots.

Thread preparation uses bounded progressive detail loading:

- The initial prompt receives lightweight candidates only.
- The only tool is `memory_get({ memoryId })`.
- `memory_get` may only expand memory ids already present in the initial candidate set.
- There is no `memory_search` tool in MVP.
- Tool messages are written to trace, not checkpoint.

This keeps recall candidate generation deterministic while allowing the model to expand details only when summaries are insufficient.

### Thread Observing

`Thread Observing` replaces the old observer update stage.

Input:

- `ThreadWorkItem[]`
- linked `Observation[]`
- current observing thread state for existing threads

Output:

- title
- summary
- thread-level observations
- contextRefs
- openQuestions
- nextSteps
- observationDelta

Thread observing is responsible for topic-level synthesis. It does not create or delete point observations. Point observation removal happens only in `Observation Review`.

### Snapshot Commit

`Snapshot Commit` writes observing snapshot rows for touched threads.

The current observing snapshot row model remains in place. Snapshot content should keep its existing shape as much as possible. The main naming change is that the old snapshot-local `Observation` type becomes `ThreadObservation` to avoid collision with public `Observation`.

### Snapshot Index

`Snapshot Index` writes thread-level observation deltas into the `observation` table.

The `observation` table can contain both:

- atomic observations from `Observation Extraction`
- thread-level observations from `Thread Observing`

Both are public observation memories. MVP does not add a schema field to distinguish their source.

### Finalize ObservingRun

Finalization updates the global checkpoint run status and clears persisted pending state.

It preserves:

- committed observation ids
- committed snapshot ids
- trace references
- recoverable errors

## Storage

### Observation Table

The old `semantic_index` table is renamed to `observation`.

The old `SemanticIndexRow` type is renamed to `Observation`.

```ts
type Observation = {
  id: string;
  text: string;
  vector: number[];
  importance: number;
  category: string;
  references: string[];
  createdAt: string;
};
```

`Observation.id` is the bare storage id. The public memory id is `observation:{id}`.

The old `memory_id` field is removed. It previously pointed a semantic index row back to an owning public memory object such as an observing snapshot. In the new model, the observation row is itself the public memory object, so this owner field is no longer needed.

`references` replaces the old owner relationship for progressive expansion. It can point to related memory ids such as:

- `session:{id}`
- `observing:{snapshotId}`
- future memory id types

Recall returns observation memory ids directly. Detail for an observation renders the observation text and its references. A caller can then use `memory_get(referenceId)` to progressively expand source context.

### Public Memory Kinds

The public memory kind set becomes:

```ts
type MemoryKind = "session" | "observing" | "observation";
```

`detail` and rendered memory APIs must support `observation:{id}`.

### Config Rename

All semantic-index naming is removed:

- `semanticIndex` -> `observation`
- `watchdog.semanticIndex` -> `watchdog.observation`
- `semanticIndexTable` -> `observationTable`
- `buildSemanticIndex` naming should be replaced by observation-oriented names.

No old-field compatibility is preserved.

## Checkpoint

`ObservingRun` is stored in the global checkpoint, not in individual observing snapshot rows.

The run identity is `(observer, epoch)`. There is no separate `observingRunId`.

```ts
type ObservingRun = {
  observer: string;
  epoch: number;
  status: "running" | "completed" | "failed";
  stage:
    | "extracting"
    | "committingObservations"
    | "reviewingObservations"
    | "preparingThreads"
    | "observingThreads"
    | "committingSnapshots"
    | "indexingSnapshots"
    | "completed";

  inputTurnIds: string[];

  pending?: {
    observationInputs?: ObservationInput[];
    reviewResult?: ObservationReviewResult;
    threadPreparationResult?: ThreadPreparationResult;
    snapshotResults?: ObservingSnapshotWriteInput[];
  };

  committed: {
    observationIds: string[];
    snapshotIds: string[];
  };

  traceRefs: string[];
  errors: ObservingRunError[];
};
```

Checkpoint is not a ledger and not a fact source. It only preserves runtime state that has not been persisted yet.

`committed.observationIds` stores this run's atomic observation ids only. Thread-level observation rows created by snapshot indexing are governed by observing snapshot indexing state.

Once data is persisted:

- pending observation inputs are cleared and replaced by committed observation ids
- pending snapshot results are cleared and replaced by committed snapshot ids
- full tool-loop messages are not stored in checkpoint

## Recovery

On startup, the observer reads global checkpoint runs with `status = "running"` or recoverable failed status.

For each run:

1. Load sealed turns by `inputTurnIds`.
2. Load committed observations by `observationTable.loadByIds(run.committed.observationIds)`.
3. Load committed snapshots by `run.committed.snapshotIds` if needed.
4. Load current active observing threads.
5. Resume from the first incomplete stage.

Recovery decisions:

- If `pending.observationInputs` exists and `committed.observationIds` is empty, continue observation commit.
- If committed observations exist and review is not complete, continue observation review.
- If review is complete and thread preparation is not complete, continue thread preparation.
- If thread preparation is complete and thread observing is not complete, continue thread observing.
- If pending snapshot results exist and committed snapshots are empty, continue snapshot commit.
- If snapshot ids exist and snapshot indexing is not complete, continue snapshot index.
- If all persisted work is complete, mark the run completed and clear pending state.

MVP accepts the narrow crash window where observation commit succeeds but checkpoint does not yet record committed ids. The design does not add schema solely to close that window.

## Validation

The implementation should verify:

- `observation` replaces `semantic_index` across config, native bindings, maintenance, and recall.
- `Observation` memory detail works for `observation:{id}`.
- Recall returns `observation:{id}` directly.
- `references` are preserved and renderable.
- `Observation Review` can remove duplicate/noisy observations.
- `Thread Preparation` covers each reviewed observation exactly once.
- New thread creation requires at least two related observations.
- `Thread Observing` updates only touched threads.
- Checkpoint recovery can resume from pending observation inputs, committed observation ids, pending thread preparation, pending snapshot results, and committed snapshot ids.
