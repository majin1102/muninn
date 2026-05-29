# Observing Snapshot Observations And Routing Context Design

## Context

Muninn's observing snapshots currently use `memories` and `memoryDelta` for the structured conclusions produced by the observer. That naming is misleading at the snapshot-content layer: these records are observer conclusions, while `memory` remains the public recall/list/detail abstraction that can point to either `session:*` or `observing:*` records.

The gateway also already supports routing one turn into multiple observing threads, but the follow-up observer update currently receives the original turn summary instead of the gateway's thread-scoped `update.summary`. This lets cross-topic turns leak broad content into every routed thread.

## Goals

- Rename only the observing snapshot content layer from memory terminology to observation terminology.
- Preserve the public memory API and public `memoryId` vocabulary.
- Store recent thread-local routed turn slices on each snapshot for readability and routing continuity.
- Use the latest routed slice as a constrained gateway continuity hint.
- Keep gateway routing rationale available for benchmark/debug traces without persisting it in Lance snapshot content.

## Non-Goals

- Do not rename public APIs such as `memories.recall`, `RenderedMemory`, `RecallHit`, or `memoryId`.
- Do not index routed turn slices in the semantic index.
- Do not pass historical routed slices to the observer LLM as additional evidence.
- Do not add compatibility handling for old `memories` / `memoryDelta` snapshot content.

## Design

### Snapshot Content Shape

`SnapshotContent` should use observation terminology:

```ts
type SnapshotContent = {
  observations: Observation[];
  turns: ObservedTurnSlice[];
  openQuestions?: string[];
  nextSteps?: string[];
  observationDelta: LlmFieldUpdate<Observation>;
};

type ObservedTurnSlice = {
  turnId: string;
  summary: string;
};
```

`observations` are durable structured conclusions for the observing thread. They are the source for semantic indexing through `observationDelta.after`.

`turns` are not memories or observations. They are a bounded thread-local evidence window containing the recent routed slices that this observing thread consumed. They are stored for inspection and for future routing continuity, but they do not enter the semantic index.

`openQuestions` and `nextSteps` remain because project-style observing threads need unresolved questions and pending actions.

### Routed Slice Window

Each observing thread stores a cumulative `turns` window in the latest snapshot.

- Default maximum size is `8`.
- The limit is configurable as `observer.contextTurns`.
- When a new snapshot is created, merge the previous snapshot's `turns` with this update's routed slices and trim the oldest entries beyond the limit.
- Each slice stores only `{ turnId, summary }`.
- `summary` must be the gateway's thread-scoped `update.summary`, not the original session turn summary.

### Gateway Continuity Hint

Each gateway thread input receives one optional `continuityHint` string.

- Source is the latest `summary` from that thread's `turns` window.
- The gateway prompt must state that `continuityHint` is only the previous relevant routed slice for judging semantic continuity.
- The gateway must not copy, restate, route, or observe the continuity hint as new information.
- `turnId` is not included in the LLM-facing hint because it has no semantic value for routing.

The current pending turn also receives observation-only previous-turn context derived from session recent turns. This context is passed only to the gateway and is not written into the session table.

### Observer Input

The observer LLM receives only current routed updates:

```ts
type ObservingTurnInput = {
  turnId: string;
  summary: string;
};
```

The observer does not receive `whyRelated` or the historical `turns` window. This avoids repeated observation of historical context and keeps the observer focused on the current thread-scoped routed content.

### Gateway Rationale

`GatewayUpdate.why` remains in the gateway result schema for debugging and benchmark visibility.

It must not be:

- persisted into `SnapshotContent.turns`
- passed to the observer LLM
- indexed into the semantic index

The LoCoMo benchmark trace should capture gateway `why` so routing quality can be inspected manually without making rationale part of the core persisted snapshot schema.

### Naming Boundary

Rename the internal observing snapshot chain:

- `MemoryCategory` -> `ObservationCategory`
- `ObservedMemory` -> `Observation`
- `SnapshotContent.memories` -> `SnapshotContent.observations`
- `SnapshotContent.memoryDelta` -> `SnapshotContent.observationDelta`
- `applyMemoriesDelta` -> `applyObservationDelta`

Keep public memory-layer naming unchanged:

- `memories.recall/list/get/timeline`
- `RenderedMemory`
- `RecallHit`
- `memoryId`
- `/api/v1/recall` response shape

## Testing

- Unit test that `applyGatewayUpdates` passes `GatewayUpdate.summary` to `observeThread` instead of the raw turn summary.
- Unit test that `SnapshotContent.turns` carries a cumulative bounded window with default size `8`.
- Unit test that gateway thread input includes only the latest `continuityHint`.
- Unit test that the observer input and prompt no longer include `whyRelated`.
- Unit test that semantic indexing consumes only `observationDelta.after`.
- Benchmark trace test that gateway `why` is visible in LoCoMo trace output but absent from stored snapshot content.
- Run the small LoCoMo slice and manually inspect observing snapshots plus QA output.

## Acceptance Criteria

- Observing snapshot content uses observation terminology internally.
- Public memory APIs and memory ids remain unchanged.
- Cross-topic turns are persisted per observing thread as thread-scoped routed slices.
- Gateway continuity uses exactly one previous routed slice as a constrained hint.
- Observer updates are based only on current routed slices.
- Gateway rationale remains available for benchmark debugging but is not persisted to Lance snapshot content.
