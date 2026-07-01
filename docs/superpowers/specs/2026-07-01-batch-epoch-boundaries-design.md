# Batch Epoch Boundaries

## Problem

Muninn currently lets one `acceptBatch()` call append an entire batch into one open extractor epoch. During bulk import, a large session can therefore become one very large epoch. Extraction may still split that epoch into several LLM requests with `maxEpochTurns` and `newBatchInputChars`, but epoch commit, pending-count progress, and visible session extraction results remain blocked until the whole epoch finishes.

This makes bulk import feel stalled:

- `pendingTurns` decreases slowly or not at all for a long time.
- Session snapshots and extraction rows are only visible after the large epoch commits.
- `maxEpochTurns` protects individual extraction requests, but not the epoch/progress boundary.

The fix should make batch ingest respect epoch boundaries without adding new public capture schema fields.

## Goals

- Prevent a single batch from creating an oversized epoch.
- Keep `minEpochTurns`, `maxEpochTurns`, `newBatchInputChars`, and `epochWindowMs` meaningful.
- Avoid adding `mode`, `flush`, or other new capture request fields.
- Stop ordinary hook capture from forcing tiny epochs after every stop hook.
- Keep `$remember-session` able to make the current session visible quickly by using the existing finalize endpoint.
- Preserve existing extraction-stage chunking as a safety net.

## Non-Goals

- Do not stream import adapters in this change. Import may still build one session-level `turnContents` array before calling capture.
- Do not introduce concurrent extraction across sessions.
- Do not change LLM prompt content or extraction output semantics.
- Do not add a migration layer for old config shapes.

## Current Path

Hook capture and import capture converge on the same server-side batch path:

```text
Codex/Claude hook
  -> common agent hook captureTurns()
  -> POST /api/v1/turn/capture/batch
  -> backend.captureTurns()
  -> MuninnBackend.acceptBatch()
  -> Extractor.acceptBatch()
  -> OpenEpoch.acceptBatch()
```

```text
Web/session import
  -> server/src/web/import.ts collects session turnContents
  -> backend.captureTurns()
  -> MuninnBackend.acceptBatch()
  -> Extractor.acceptBatch()
  -> OpenEpoch.acceptBatch()
```

The only current special case is that `backend.captureTurns()` calls `memoryFinalize()` when any turn has `metadata.ingest` ending in `-hook`. That makes hook capture visible quickly, but it also bypasses the intended `minEpochTurns`/`epochWindowMs` live batching behavior.

## Design

### Unified Batch Packing

`acceptBatch()` should not require a public mode field. It should always treat the input as a batch append and pack it into one or more epochs before writing to `OpenEpoch`.

For each candidate group of incoming turns:

- Do not let the group exceed `maxEpochTurns`.
- Do not add the next turn if doing so would exceed `newBatchInputChars`.
- Seal the current open epoch when the next group must start.
- Keep the final partial group in the open epoch; do not force-seal the tail just because the batch ended.

This means:

- A large import progressively publishes full epochs, commonly around `maxEpochTurns` turns or less when text is large.
- A small hook batch does not automatically become a tiny sealed epoch.
- Tail work follows the normal open-epoch rules: `minEpochTurns`, `epochWindowMs`, or explicit finalize.

### Live Capture

Single-turn/live behavior remains governed by existing open epoch scheduling:

- `minEpochTurns` seals an open epoch once enough extractable turns accumulate.
- `epochWindowMs` seals sparse tails.
- Explicit finalize can seal the tail.

Ordinary `codex-hook` and `claude-hook` capture should no longer auto-finalize just because the ingest name ends in `-hook`.

### Remember Session

`$remember-session` already uses a transcript marker. When the hook handles the enable marker and successfully captures the selected turns, it should call the existing `/api/v1/memory/finalize` endpoint.

This keeps remember-session fast and visible without adding fields to `/api/v1/turn/capture/batch`.

### Budget Measurement

The epoch packing budget should use the same current-batch content concept as extraction: rendered `## Current Batch Turns` text, bounded by `newBatchInputChars`.

Because actual `turnId` values are assigned during persistence, pre-write packing can use incoming turn content and stable synthetic labels for budgeting. This packing is allowed to be conservative:

- Deduped turns or non-extractable turns may make the final epoch smaller than the pre-write group.
- The extraction stage must still re-apply exact row-based `maxEpochTurns` and `newBatchInputChars` chunking as a safety net.
- A single oversized turn must be allowed to proceed alone so ingestion cannot stall.

### Extraction Chunking Remains

`extractEpochDraft()` should continue chunking epoch turns by `maxEpochTurns` and `newBatchInputChars`.

This remains necessary for:

- Recovery from older checkpoints or unexpected oversized epochs.
- Single-turn oversize cases.
- Any future writer that bypasses the usual batch packing path.

## Expected Behavior

Large import example:

```text
input: 542 turns
maxEpochTurns: 32
newBatchInputChars: 16384

result:
  epoch 1: up to 32 turns, possibly fewer for long content
  epoch 2: up to 32 turns, possibly fewer for long content
  ...
  tail epoch: remains open until min/window/finalize
```

As each sealed epoch finishes, `pendingTurns` can decrease and UI-visible snapshots/extractions can appear. The final tail may wait for the normal window unless an explicit finalize is called.

Small hook example:

```text
input: 1-2 hook turns

result:
  accepted into open epoch
  not auto-finalized
  sealed later by minEpochTurns, epochWindowMs, or explicit finalize
```

Remember-session example:

```text
input: marker enable captures current transcript turns

result:
  batch packing splits large history into bounded epochs
  hook calls existing memory finalize after capture succeeds
  tail is sealed promptly
```

## Implementation Notes

- Remove `isHookCapture() -> memoryFinalize()` from `backend.captureTurns()`.
- Add a client method in the hook path for existing memory finalize, or call the existing endpoint directly after remember enable capture succeeds.
- Refactor `Extractor.acceptBatch()` so it does not pass the entire `turnContents` array to one `OpenEpoch.acceptBatch()` call.
- Add a small packing helper near extractor/epoch code that splits incoming `TurnContent[]` into groups by `maxEpochTurns` and `newBatchInputChars`.
- Keep `OpenEpoch.acceptBatch()` focused on accepting a bounded group into one epoch.
- Do not change `/api/v1/turn/capture/batch` request schema.

## Error Handling

- If packing cannot render a candidate because of malformed input, reject the batch before partial writes.
- If one turn exceeds `newBatchInputChars`, accept it alone and rely on extraction trace/oversize handling.
- If capture succeeds but remember finalize fails, keep the captured turns and report/log the finalize failure; the normal epoch window can still seal the tail later.

## Tests

- Batch epoch boundary: a short 70-turn batch with `maxEpochTurns=32` publishes bounded epochs instead of one 70-turn epoch.
- Text budget boundary: a batch with long turns seals before `newBatchInputChars` is exceeded.
- Hook regression: ordinary `codex-hook` batch capture no longer calls memory finalize automatically.
- Remember regression: enable marker capture calls memory finalize after successful capture.
- Tail behavior: a final partial batch remains open unless `minEpochTurns`, `epochWindowMs`, or explicit finalize seals it.
- Extraction safety net: extraction still chunks an oversized epoch by `maxEpochTurns` and `newBatchInputChars`.

## Deferred Work

- Import adapter streaming is intentionally deferred. A later PR should avoid building an entire huge session `turnContents` array in memory.
- The exact synthetic label format for pre-write budget rendering is implementation-local, as long as it is deterministic and conservative.
