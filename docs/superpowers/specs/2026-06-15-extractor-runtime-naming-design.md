# Extractor Runtime Naming Design

## Summary

This design cleans up extractor runtime naming and file boundaries after the
extraction runtime cleanup branch. The goal is readability: make the main
extraction flow obvious from filenames, method names, and local terminology.

This is not a behavior change. It does not change storage schema, prompt
semantics, LLM behavior, checkpoint format, or observer/global observation
behavior.

## Baseline

The implementation starts from `codex/extraction-runtime-cleanup`.

That branch already removes the old direct extraction path and moves the
experimental session gateway out of `llm/extracting.ts`. This design assumes
that cleanup is present before the naming work begins.

## Goals

- Make `server/src/memory/extractor/` readable by filename.
- Replace legacy extractor-owned `observe` naming with `extract` naming.
- Keep file count small and concept-driven.
- Remove or relocate historical extractor files that are no longer part of the
  main runtime.
- Preserve current runtime flow and test behavior.

## Non-Goals

- No schema migration.
- No prompt contract changes.
- No LLM extraction behavior changes.
- No checkpoint format changes.
- No rewrite of the `Extractor` state machine.
- No changes to the separate `observer/` global observation module.
- No broad module splitting beyond the agreed extractor directory shape.

## Target Directory Shape

The extractor directory should converge to:

```text
server/src/memory/extractor/
  runtime.ts
  epoch.ts
  session.ts
  snapshot.ts
  extraction-index.ts
  types.ts
```

### `runtime.ts`

Formerly `extractor.ts`.

Owns the `Extractor` runtime orchestration:

- bootstrap
- accept turn
- seal and publish epochs
- run loop
- flush, finalize, and watermark
- checkpoint export
- restart recovery
- snapshot indexing retry orchestration
- handoff of extraction changes to the observer queue

It may call `session.ts` and `extraction-index.ts`, but should not own snapshot
Markdown parsing or extraction table diff details.

### `epoch.ts`

Unchanged boundary.

Owns `OpenEpoch`, `SealedEpoch`, `EpochQueue`, and epoch queue mechanics. It
should not know about session threads, extraction tables, checkpoints, or LLMs.

### `session.ts`

Combines the useful responsibilities currently split between `thread.ts` and
the session-extraction part of `update.ts`.

Owns session memory thread lifecycle:

- create/load/replay/clone session threads
- expose current session content
- apply an extraction result to a session thread
- group sealed epoch turns by session identity
- run session extraction for those groups
- flush touched session threads to the session table

### `snapshot.ts`

Formerly `thread-memory.ts`.

Owns session snapshot Markdown document parsing and rendering:

- parse full snapshot content
- parse snapshot patch output
- parse snapshot units
- render snapshot content
- render extraction blocks
- validate refs and sequence metadata

It should not know about runtime state, NativeTables, epochs, LLM calls, or
checkpoint recovery.

### `extraction-index.ts`

Combines `memory-delta.ts` and the extraction-indexing part of `update.ts`.

Owns session snapshot to extraction table projection:

- diff snapshot extractions
- preserve or assign stable extraction ids
- write extraction table add/update/delete changes
- index pending snapshots for one thread
- index all unindexed snapshots
- index session threads touched by the current epoch

### `types.ts`

Keeps shared extractor domain contracts.

Types used only inside one file should stay local to that file. Do not use
`types.ts` as a dumping ground for helper-only types.

## Files To Remove Or Relocate

Check references before changing these files:

```text
extraction-review.ts
thread-preparation.ts
gateway-trace.ts
```

Rules:

- If unused, delete.
- If only benchmark or lab code uses a file, move it out of the main
  `extractor/` runtime directory or rename it with an explicit experimental or
  legacy name.
- If the main runtime still uses a file, rename it by actual responsibility
  before keeping it in the main extractor directory.

## File Rename Map

```text
extractor.ts       -> runtime.ts
thread.ts          -> session.ts
thread-memory.ts   -> snapshot.ts
memory-delta.ts    -> extraction-index.ts
update.ts          -> removed; responsibilities move to session.ts and extraction-index.ts
```

## Runtime Method Names

Inside `runtime.ts`:

```text
bootstrapInternal              -> bootstrapRuntime
observeCurrentEpoch            -> extractCurrentEpoch
buildCurrentEpochIndex         -> indexCurrentEpochSnapshots
restoreCheckpointState         -> restore
restoreThreadsFromCheckpoint   -> replayCheckpoint
hasPendingExtraction           -> hasAnyUnindexedSnapshots
hasPendingExtractionUpTo       -> hasUnindexedSnapshotsAtOrBefore
retryExtraction                -> retrySnapshotIndexing
```

Keep existing public methods:

```text
ensureBootstrapped
accept
watermark
shutdown
flushPending
finalize
exportCheckpoint
```

`restore()` means restart recovery for the extractor runtime. It may use
checkpoint base data plus table deltas. It returns `null` when checkpoint-based
recovery is not usable and bootstrap should fall back to table recovery.

`replayCheckpoint()` is the helper that expands checkpoint thread refs plus
session delta rows back into in-memory session threads and extracted turn ids.

## Session Method Names

Inside `session.ts`:

```text
createSessionMemoryThread      -> createSessionThread
cloneSessionMemoryThread       -> cloneSessionThread
cloneSessionMemoryThreads      -> cloneSessionThreads
loadThreads                    -> loadSessionThreads
threadFromSnapshots            -> sessionThreadFromSnapshots
replaySnapshots                -> replaySessionSnapshots
currentSessionMemoryContent    -> currentSessionContent
applyExtractionResult          -> applyExtraction
extractEpoch                   -> extractSessionEpoch
flushThreads                   -> flushSessionThreads
threadIdentityKey              -> sessionThreadIdentityKey
getPendingIndex                -> pendingSnapshotRange
getPendingIndexUpTo            -> pendingSnapshotRangeUpTo
```

`applyExtraction()` applies one LLM session extraction result to an in-memory
session thread. It creates a new snapshot and updates thread metadata. It does
not call the LLM, write the session table, write the extraction table, or hand
off observer work.

## Extraction Index Method Names

Inside `extraction-index.ts`:

```text
applyExtractionChanges       -> applyExtractionChanges
applyExtractionTableChanges  -> applyExtractionTableChanges
catchUpIndex                 -> indexThreadSnapshots
buildExtraction              -> indexAllUnindexedSnapshots
buildTouchedIndex            -> indexTouchedSessionThreads
```

Use "unindexed snapshots" for this concept: session snapshots that have been
written or exist in memory but have not yet been projected into the extraction
table.

## Snapshot Method Names

Inside `snapshot.ts`, keep the current high-level names because they match the
existing `SnapshotContent` and patch contracts:

```text
parseSnapshotContent
parseSnapshotPatch
parseSnapshotContentUnits
renderSnapshotContent
renderExtractionBlock
stripMarkdownFence
```

Internal helpers may be renamed for clarity, but this work should not broaden
the snapshot Markdown contract.

## Observe To Extract Naming Rule

In extractor-owned code, `observe` and `observing` are legacy names. Rename them
to `extract` and `extraction` unless they refer to one of these exceptions:

- persisted fields such as `observingEpoch`
- the separate `observer/` module
- global observation concepts
- tests or docs that are explicitly describing the observer subsystem

Do not migrate persisted field names in this work. Use clearer local variable
names around those fields when needed.

Examples:

```text
observeCurrentEpoch       -> extractCurrentEpoch
barrierRequiresObserve    -> barrierRequiresExtraction
observedTurnIds           -> extractedTurnIds
```

## Testing Strategy

Because this is intended to be behavior-preserving, verification should focus on
existing coverage plus import and residue checks:

- `pnpm --filter @muninn/server build`
- `pnpm --filter @muninn/server test`
- `pnpm --filter @muninn/benchmark-locomo build`
- `pnpm --filter @muninn/benchmark-locomo test`
- `rg "from './update|from './thread|from './thread-memory|from './memory-delta"`
- `rg "observeCurrentEpoch|barrierRequiresObserve|hasPendingExtraction|retryExtraction|buildTouchedIndex|buildExtraction|catchUpIndex"`

Add focused tests only if a rename exposes an existing boundary gap. Do not add
tests merely to restate unchanged import wiring.

## Implementation Notes

Do the rename in small mechanical steps:

1. Move files with `git mv`.
2. Update imports.
3. Rename exported functions and update call sites.
4. Rename private runtime helpers.
5. Run build/tests.
6. Check for old filename and method residue.

Avoid mixing behavior edits into the rename commit. If a bug is discovered while
renaming, fix it in a separate follow-up after this naming cleanup is complete.
