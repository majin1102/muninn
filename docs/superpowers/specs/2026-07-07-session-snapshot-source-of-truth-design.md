# Session Snapshot Source of Truth Design

## Summary

`turn` is the append-only input log. `session_snapshot`, `session`, `extraction`, and `dreaming` are product tables.

`session_snapshot.content` is the source of truth for session memory within a committed product state. Runtime state, checkpoints, and derived indexes must not reconstruct session history from in-memory snapshot arrays or from checkpoint-derived sequence values.

This design fixes the current checkpoint regression class where `snapshotSequence` was derived from array indexes, causing checkpoint snapshot cursors to diverge from `session_snapshot` and eventually lowering `committedEpoch`.

The durable recovery model is:

1. Do not restore or roll back `turn`.
2. Restore all product tables to the versions recorded in the checkpoint.
3. Resume extraction from checkpoint `committedEpoch`.
4. Re-extract turns after checkpoint `committedEpoch`.

Any product rows written after the last checkpoint are provisional and are discarded by product-table restore.

Feasibility verdict: this model is implementable with the current Lance storage foundation, but the current TypeScript/native API surface is not sufficient yet. Lance can restore an old dataset version as a new latest version, while Muninn still needs unified product table stats/restore bindings and cleanup floors based on checkpoint product versions.

## Source of Truth

- `session_snapshot.content` is the authoritative session memory document.
- Each extraction block in `content` must include `context_id` and complete historical `refs`.
- `session_snapshot.references` remains in the schema for now, but is deprecated.
- While the field exists, writes may leave `session_snapshot.references` empty or set it to `union(content.extractions[].references)`, depending on the smallest code change needed for the current row contract.
- Core logic must not treat `session_snapshot.references` as extraction provenance. It is only a derived cache for transition/debug use.
- Runtime `SnapshotContent.contextRefs`, if it still exists during the refactor, must also be derived from `content.extractions[].references` or removed. It must not be an independent provenance source.
- `session_snapshot.title`, `session_snapshot.summary`, signals, and skill columns are denormalized fields derived from parsed `content`.
- If parsed `content` conflicts with those denormalized columns, `content` wins.

## Runtime Model

`SessionThread` should keep only current working state, not session history:

```ts
type SessionThread = {
  threadId: string;
  sessionId: string;
  project: string;
  cwd: string;
  agent: string;
  extractor: string;
  latestSnapshot: ThreadSnapshot | null;
  pendingSnapshot: ThreadSnapshot | null;
  createdAt: string;
  updatedAt: string;
};

type ThreadSnapshot = {
  snapshotId: string | null;
  snapshotSequence: number;
  title: string;
  summary: string;
  content: SnapshotContent;
  createdAt: string;
  updatedAt: string;
  epoch: number | null;
};
```

`SessionThread.sessionId` is the normalized session id. If ingest input has no session id, normalize it once at the boundary to `DEFAULT_SESSION_ID`; do not carry `null` into runtime, checkpoint, index cursor, or persisted snapshot identity.

Remove the current historical runtime fields:

- `snapshots[]`
- `snapshotIds[]`
- `snapshotEpochs[]`
- top-level `title`
- top-level `summary`
- top-level `references`
- top-level `indexedSnapshotSequence`

Implementation may land this in stages. During the intermediate bugfix stage, existing `snapshots[]` / `snapshotIds[]` caches may remain to avoid a broad runtime rewrite, but they must carry an explicit real `snapshotSequences[]` cache loaded from `session_snapshot.snapshotSequence`.

In that intermediate state:

- `snapshotSequences[]` is a cache of persisted row sequence values, not a source of truth.
- Every persist/checkpoint/index path must read sequence from `snapshotSequences[]` or a `session_snapshot` row.
- Array indexes may only address the in-memory cache.
- No persisted `snapshotSequence`, checkpoint `latestSnapshotSequence`, or `indexedSnapshotSequence` may be derived from `snapshots.length`, `snapshots.length - 1`, or an array index.

`latestSnapshot` represents the latest persisted row. Its `snapshotId` must be non-null and must come from `session_snapshot`.

`pendingSnapshot` represents the next generated snapshot before flush. Its `snapshotId` is null until `session_snapshot` insert returns a persisted row.

`title` and `summary` belong to `ThreadSnapshot`, not to `SessionThread`. Code that needs the current visible title or summary should read:

```ts
const currentSnapshot = thread.pendingSnapshot ?? thread.latestSnapshot;
```

This keeps `latestSnapshot` and `pendingSnapshot` from sharing an ambiguous outer `SessionThread.title` / `SessionThread.summary` state. When `pendingSnapshot` is flushed, the persisted row's denormalized `title` and `summary` columns are derived from that same snapshot content.

`ThreadSnapshot.title` and `ThreadSnapshot.summary` are derived caches for the same snapshot content. They must be parsed from `ThreadSnapshot.content` on restore and generated together with `ThreadSnapshot.content` on write. They must not be mutated independently.

## Snapshot Sequence

`snapshotSequence` always comes from `session_snapshot` or from the latest persisted row.

The latest persisted row is looked up by full session identity in the current extractor scope:

```text
project + agent + sessionId + extractor
```

Do not allocate or query sequence state by bare `sessionId`.

When creating a new snapshot:

```text
nextSequence = latestSnapshot.snapshotSequence + 1
```

For the first snapshot in a session:

```text
nextSequence = 0
```

Do not derive persisted sequence values from:

- array indexes
- `snapshots.length`
- `snapshots.length - 1`
- partial in-memory history

## Writer Model

The runtime assumes one writer process per `$MUNINN_HOME`.

Within a server process, extraction and snapshot flush are serialized by the extractor epoch flow and table mutation locks. The normal code path should not implement cross-process sequence allocation, CAS retry, or "pick the next free sequence" recovery.

If a live write detects duplicate `snapshotSequence` values for the same `project + agent + sessionId + extractor`, that is an invariant violation. The runtime should log a high-signal diagnostic and fail the write instead of silently repairing or retrying.

Cross-process writer support, if needed later, requires a separate storage lease or transaction design and is out of scope for this change.

## Checkpoint Product Boundary

Checkpoint is the only durable product boundary.

It records the input table version for diagnostics and the product table versions used for restore. These product table versions should live in one checkpoint section instead of being spread across extractor baseline, session index baseline, or session table checkpoint.

Project dreaming watermarks may remain in their existing checkpoint section. They are checkpoint cursors, not product table versions, and they must not reintroduce `dreaming_project` as a restored product table.

```ts
type CheckpointTableVersions = {
  input: {
    turn: number;
  };
  products: {
    sessionSnapshot: number;
    session: number;
    extraction: number;
    dreaming: number;
  };
};

type CheckpointContent = {
  schemaVersion: 15;
  tableVersions: CheckpointTableVersions;
  extractor: ExtractorCheckpoint;
  dreaming: DreamingCheckpoint;
};

type PublishedCheckpointBoundary = {
  tableVersions: CheckpointTableVersions;
  extractor: ExtractorCheckpoint;
  dreaming: DreamingCheckpoint;
  publishedAt: string;
};

type ExtractorCheckpoint = {
  committedEpoch: number;
  nextEpoch: number;
  threads: ThreadRef[];
  runs: ExtractorRun[];
};
```

`turn` is never restored. Its checkpoint version is used to detect impossible states, such as the current `turn` table version being lower than the checkpoint version.

In schema 15, `committedEpoch` is required. Use `-1` to represent "no epoch has been committed yet"; do not omit the field or use `undefined` for a persisted checkpoint.

Every product table version in the checkpoint must be restorable. For Lance-backed tables, restoring version `v > 0` means:

```text
dataset.checkout_version(v).restore()
```

This creates a new latest table version whose content matches checkpoint version `v`. It does not make the table version number move backward.

Version `0` means the table did not exist at checkpoint time. Restoring version `0` must materialize an empty current-schema table and must not leave post-checkpoint rows behind. After restore, `productTableStats` should return the new current table version, and a fresh checkpoint should record that new version instead of continuing to record `0`.

The checkpoint must not persist `SessionIndexCheckpoint` as a session/search recovery source. Session list/search state is represented by the `session` product table. Project dreaming watermarks remain checkpoint state; they are not represented by a separate `dreaming_project` product table. Runtime caches may exist, but after restore they must be derived from restored product tables and checkpoint cursors, not from independent runtime state.

Checkpoint export records a durable product boundary plus derived-index cursors. In practice:

- generated `session_snapshot` rows are persisted
- checkpoint thread refs are exhaustive for the extractor scope: one `ThreadRef` for every `project + agent + sessionId` with at least one persisted snapshot
- each checkpoint thread records `latestSnapshotId`
- each checkpoint thread records `indexedSnapshotSequence`, the highest snapshot whose `session` and `extraction` derived rows are durable
- `session` search rows are derived through each thread's `indexedSnapshotSequence`
- `extraction` rows are derived through each thread's `indexedSnapshotSequence`
- `dreaming` state is consistent with the restored/processed snapshot version
- table stats are read after those writes complete
- the checkpoint file is written atomically after table versions are read

Checkpoint export must not block normal product writes with a global write mutex. Product writers publish a checkpointable boundary only after their logical write and matching runtime cursor update are complete. The published boundary is an immutable `PublishedCheckpointBoundary` containing matching `tableVersions`, `ExtractorCheckpoint`, and `DreamingCheckpoint`. Checkpoint export copies exactly one fully published boundary and writes that boundary to the checkpoint. Product writes that finish after export copied the boundary are provisional until the next checkpoint.

If a product write succeeds but checkpoint write has not happened yet, that product write is provisional. On restart, restore discards it by restoring product tables to checkpoint versions and re-extracting turns after checkpoint `committedEpoch`.

If `session_snapshot` is ahead of `session` / `extraction`, the checkpoint may still be written as long as `indexedSnapshotSequence` records that lag. On restore, the runtime resumes derived indexing from `indexedSnapshotSequence + 1` through the restored latest snapshot.

Cleanup must keep the product versions referenced by the latest checkpoint. If a referenced version has already been cleaned up, restore must fail closed for writes.

Maintenance operations such as compaction, optimization, and index creation may create newer physical table versions without changing logical product content. Those newer versions are still provisional until a checkpoint records them. If the process crashes first, startup may restore the table to the older checkpoint version and maintenance can run again later.

## Storage API Requirements

The storage layer must expose product table restore operations before this design is implemented in runtime.

Required native APIs:

```ts
type ProductTableName =
  | 'sessionSnapshot'
  | 'session'
  | 'extraction'
  | 'dreaming';

type ProductTableVersion = {
  table: ProductTableName;
  version: number;
};

restoreProductTable(params: ProductTableVersion): Promise<TableStats | null>;
productTableStats(params: { table: ProductTableName }): Promise<TableStats | null>;
```

For Lance-backed product tables, `restoreProductTable({ version: v })` should:

- preflight that version `v` exists when `v > 0`
- checkout version `v`
- call `restore()`
- reopen the table
- return current stats for the new latest version

For `version = 0`, restore must materialize an empty current-schema table and return stats for the new current version.

Current feasibility notes:

- Lance supports `checkout_version(v).restore()`, which restores old content as a new latest version.
- Current bindings expose read-at-version for `session_snapshot`, but not restore for any product table.
- Current checkpoint export records recovery versions indirectly through `extractor.baseline`, `session.tableVersion`, and `sessionIndex.baseline`. That shape cannot represent the new product boundary without drift.
- Current watchdog cleanup covers only `turn`, `session_snapshot`, `session`, and `extraction`. It must include `dreaming`, and product cleanup floors must come directly from `checkpoint.tableVersions.products`.
- Product restore across multiple tables is not atomic at the storage layer, so runtime restore must be idempotent and repeat all product table restores on startup until every product table matches checkpoint content.

## Cleanup Side Task

Remove the leftover `dreaming_project` table surface as part of this change.

This cleanup should remove the obsolete schema/table/native binding/migration-script surface for `dreaming_project`. Runtime project dreaming watermarks are checkpoint state and must not depend on `DreamingProjectTable`.

This is cleanup of a residual old path, not a new checkpoint/restore product table.

## Checkpoint And Restore

Extractor checkpoint stores cursors only:

```ts
type ThreadRef = {
  project: string;
  agent: string;
  sessionId: string;
  latestSnapshotId: string;
  indexedSnapshotSequence: number | null;
  updatedAt: string;
};
```

`latestSnapshotId` is the only persisted snapshot cursor in the extractor thread checkpoint. The checkpoint must not store `latestSnapshotSequence`; restore reads the row by `latestSnapshotId` and gets the authoritative sequence from `session_snapshot`.

`indexedSnapshotSequence` is the durable derived-index cursor. It is allowed in checkpoint because it describes how far `session` and `extraction` product tables have been indexed, not the identity or content of the latest snapshot. It must be written only after both derived table writes succeed for that sequence.

Checkpoint thread refs are exhaustive for the extractor scope. Do not omit inactive, old, or fully indexed sessions. If a `project + agent + sessionId` identity has at least one restored `session_snapshot` row for this extractor, it must have exactly one `ThreadRef`.

`project`, `agent`, and `sessionId` identify the session for diagnostics and index cursor ownership. They are not a runtime replacement for `latestSnapshotId`. `ThreadRef` does not repeat `extractor` because the extractor checkpoint section is already scoped to one extractor.

Restore flow:

1. Read checkpoint.
2. Verify current `turn` table version is not lower than checkpoint `tableVersions.input.turn`.
3. Read current product table stats.
4. If every current product version equals `checkpoint.tableVersions.products`, skip product restore.
5. Otherwise restore every product table to `checkpoint.tableVersions.products`.
6. Verify each current/restored product table's content is readable.
7. Verify checkpoint thread refs are exhaustive: every `project + agent + sessionId + extractor` identity with at least one restored `session_snapshot` row has exactly one `ThreadRef`, and every `ThreadRef` points to a restored identity.
8. Use each `latestSnapshotId` to read the current `session_snapshot` row.
9. Verify the row matches the checkpoint identity: `project`, `agent`, and `sessionId`.
10. Parse `row.content` into runtime `ThreadSnapshot.content`.
11. Use `row.snapshotSequence` as the authoritative latest sequence.
12. Validate `indexedSnapshotSequence`: null means no snapshot has been indexed; otherwise it must be `<= latestSnapshot.snapshotSequence`.
13. If `indexedSnapshotSequence` is non-null, verify the same scoped identity has exactly one `session_snapshot` row at that sequence.
14. Initialize the runtime index cursor from checkpoint `indexedSnapshotSequence`.
15. Use parsed `content.extractions[].references` only to restore the thread's readable memory state and derived turn reference cache.
16. Rebuild runtime state for all restored thread refs.
17. If product restore happened, write a fresh checkpoint with the same logical cursors, same `committedEpoch`, and the new current product table versions before accepting writes.
18. Set durable `committedEpoch` from checkpoint.
19. Load pending turns from the append-only `turn` table where `extractionEpoch` is missing or greater than checkpoint `committedEpoch`.

Checkpoint data is never the source of truth for snapshot content or sequence. If `latestSnapshotId` cannot be found, or if the row identity does not match the checkpoint identity, runtime restore must log a diagnostic and refuse to silently substitute another row. Historical data recovery for that state is out of scope for this spec.

Checkpoint cursors are interpreted only after product table restore. Runtime restore must not fast-forward to product rows newer than checkpoint product versions. Those rows are provisional and are discarded by product-table restore.

Product table restore is an idempotent startup operation. If startup is interrupted after restoring only some product tables, the next startup repeats restore for every product table before accepting writes. The checkpoint file must not be rewritten until all product tables have been restored and verified.

After a successful product restore, runtime should write a fresh checkpoint with the same `committedEpoch` and the new product table versions produced by Lance restore. This prevents repeated restore commits on later startups. This checkpoint rewrite is allowed only after all product tables are restored and verified.

This is a checkpoint shape change: extractor thread refs remove `latestSnapshotSequence`, keep `indexedSnapshotSequence` as the durable derived-index cursor, include `project` and `agent` alongside `sessionId`, and recovery versions move to `tableVersions`.

Restore must not downgrade `committedEpoch`. If product restore or checkpoint cursor validation fails, keep the previous checkpoint `committedEpoch`, do not set it to `undefined`, and do not republish turns at or below that epoch.

Restore is not a historical data repair path. It may restore product tables to checkpoint versions and protect epoch monotonicity, but it must not normalize legacy checkpoint shapes, rewrite arbitrary historical rows, or rebuild corrupted derived indexes outside the checkpoint-version restore model during normal startup.

`committedEpoch` may become durable only when checkpoint export records product table versions for that state. `pendingSnapshot` and uncheckpointed product writes are not durable commit evidence.

During restore, `committedEpoch` is never raised above the checkpoint value. Turns after checkpoint `committedEpoch` are re-extracted from the append-only `turn` table.

`committedEpoch` must not be inferred from extraction refs. Extraction refs show which turns are cited by current memory blocks; they do not prove that every turn up to an epoch has been fully processed. Recovery for a low or missing `committedEpoch` in an existing checkpoint is out of scope for this spec.

Changing the thread checkpoint shape should bump the checkpoint schema. Runtime parsing should accept only the current shape. Existing checkpoint migration is out of scope for this spec; an unsupported old checkpoint with non-empty persisted tables must not be treated as an empty fresh checkpoint.

When extractor restore cannot validate the checkpoint against persisted `session_snapshot` state, the extractor must fail closed for writes. The server may still expose read-only surfaces, but it must not continue capture/extraction as if there were no checkpoint.

Fail-closed means:

- do not open a new extraction epoch
- do not accept turn capture or other write work for extraction
- do not flush new session snapshots or derived indexes
- do not rewrite the extractor checkpoint with lower or empty state
- return a degraded/write-unavailable error for write surfaces while read surfaces may continue from persisted tables

## Epoch Monotonicity

Extractor `committedEpoch` is a monotonic high-water mark.

Checkpoint export/write must enforce:

```text
nextCommittedEpoch >= previousCommittedEpoch
```

If a runtime state attempts to write a lower value, checkpoint write must preserve the previous value and log a diagnostic such as `checkpoint_committed_epoch_regression_blocked`.

This guard is a safety net. Normal restore should keep the epoch from the checkpoint after product table restore, but no code path may persist a lower `committedEpoch` over a higher existing checkpoint.

Runtime `nextEpoch` must also be monotonic after restore:

```text
nextEpoch = max(
  checkpoint.nextEpoch,
  checkpoint.committedEpoch + 1,
  max(turn.extractionEpoch where turn.extractionEpoch > checkpoint.committedEpoch) + 1
)
```

If there is no pending turn with `extractionEpoch > committedEpoch`, treat that max term as `committedEpoch + 1`.

Turns whose `extractionEpoch` is greater than checkpoint `committedEpoch` are pending work, not committed evidence. They retain their existing `extractionEpoch` and epoch group when retried, and they must not cause checkpoint `committedEpoch` to advance until the corresponding product tables are written and checkpointed again. Turns with no `extractionEpoch` are assigned epochs greater than or equal to restored `nextEpoch`; restored `nextEpoch` is only used for those turns.

## Read And Timeline

Latest session read may use runtime state:

```text
pendingSnapshot ?? latestSnapshot
```

Timeline/history read must query `session_snapshot` rows by `project + agent + sessionId + extractor` and sort by `snapshotSequence`.

Runtime `pendingSnapshot` may be shown as an unflushed tail, but runtime state must not be used as historical truth.

`muninn-read session_*` is persisted-only. It returns the stored public `session_snapshot.content` directly and does not include runtime `pendingSnapshot`. It must not scan the `extraction` table, replay historical snapshots, or append a synthesized `## Extraction Context References` section at read time.

`muninn-read ext:*` continues to read the extraction row by id. `turn_*` read behavior is unchanged.

## Async Index

Use a single derived-index cursor per session identity:

```text
indexedSnapshotSequence = the highest snapshotSequence for which both session and extraction derived tables are indexed
```

This cursor belongs to the indexer state. It does not belong on `SessionThread`.

Checkpoint persists the last durable value of this cursor in `ThreadRef.indexedSnapshotSequence`. Runtime may keep a mutable in-memory copy while indexing and retrying, but checkpoint is the source for restore.

After restore, initialize the runtime index cursor for each restored session identity from checkpoint `indexedSnapshotSequence`. If the checkpoint value is null, indexing starts from sequence `0`. If it is lower than restored `latestSnapshot.snapshotSequence`, the runtime has a durable unindexed tail and should resume derived indexing from `indexedSnapshotSequence + 1`.

Checkpoint export may advance even when derived indexing is behind the latest snapshot, as long as the checkpoint records the lagging `indexedSnapshotSequence` and product table versions from that same durable state. This preserves snapshots and committed epochs without forcing successful derived indexing first.

Index flow:

1. Query `session_snapshot` rows for the same `project + agent + sessionId + extractor` where `snapshotSequence > indexedSnapshotSequence`.
2. Parse each row's `content`.
3. If `indexedSnapshotSequence` is not null, also read the snapshot at that sequence as the previous content boundary with the same identity scope.
4. Upsert the session derived row.
5. Upsert/delete extraction derived rows.
6. Advance `indexedSnapshotSequence` only after both derived writes succeed.

If any write fails, the cursor does not advance and the same snapshot is retried.

Each `(project, agent, sessionId, extractor, snapshotSequence)` lookup must return exactly one row. Zero rows or multiple rows is an invariant violation; index should fail that session and leave the cursor unchanged.

If the process restarts after a snapshot was checkpointed but before its derived index writes were checkpointed, product table restore keeps that snapshot and restores `session` / `extraction` to the lagging checkpoint versions. Runtime then resumes indexing from checkpoint `indexedSnapshotSequence + 1`; the corresponding turns do not need to be re-extracted if checkpoint `committedEpoch` already advanced.

If the process restarts before the snapshot write itself was checkpointed, product table restore discards the uncheckpointed `session_snapshot`, `session`, and `extraction` writes together. The corresponding turns are loaded again from `turn` because checkpoint `committedEpoch` did not advance to include that snapshot.

## Extraction References

Each extraction in `session_snapshot.content` must carry complete historical refs.

Rules:

```text
add:    refs = new refs
update: refs = old refs union new refs
merge:  refs = union(source refs) union new refs
```

This invariant makes every snapshot content independently sufficient to rebuild extraction rows.

Extraction indexing must build factual row fields from parsed `snapshot.extractions`.

Extraction ids are random stable UUIDs stored internally as bare ids and exposed publicly as `ext:<uuid>`.

Identity rules:

```text
add:    generate a new random UUID
update: preserve the existing UUID
merge:  generate a new random UUID for the merged extraction
```

Do not derive extraction ids from content hash, title, summary, session identity, snapshot sequence, or turn refs. Stable update identity comes from `applyExtractionChanges(...)`, not from recomputing an id from the new text.

Because ids are random stable UUIDs, adding extraction ownership columns is not required for this change's correctness model. Deletion still must be scoped by snapshot content: index a single session by comparing that session's previous and current `session_snapshot.content`, never by scanning unrelated extraction rows.

For example, after merging A/B into C:

```text
C.turnRefs = C.references
```

Do not reconstruct C provenance by reading old extraction rows A/B from the extraction table. Old extraction rows may have already been deleted by a previous failed attempt.

Deletion should be derived from snapshot content as well:

```text
deleteIds = previousSnapshot.extractions.ids - currentSnapshot.extractions.ids
upsertIds = currentSnapshot.extractions.ids
```

For the first indexed snapshot, `previousSnapshot.extractions` is empty. For later snapshots, the previous content comes from the prior `session_snapshot` row, not from the extraction table.

The existing extraction table may be used only for non-factual metadata such as preserving `createdAt` for the same UUID on rows being upserted. It must not provide `turnRefs`, title, summary, content, merge source refs, or delete decisions.

## Context ID Trust Boundary

Public snapshot markdown may contain:

```md
<!-- context_id: ext:<uuid>; refs: [turn:...] -->
```

Persisted `session_snapshot.content` may be parsed to restore existing extraction ids for that persisted snapshot.

For newly written snapshots, every extraction block must contain a valid `context_id: ext:<uuid>` matching the patched extraction id. Missing or invalid `context_id` is a write/index validation error.

Old snapshots may still lack `context_id`. They can be read as stored, but `muninn-read session_*` must not fill missing ids on the read hot path. If old data needs ids, handle it with a separate offline backfill.

LLM-produced markdown must not be trusted to decide extraction identity. During extraction/update, identity comes from `patched.extractions[].id` after `applyExtractionChanges(...)`. If LLM output includes or changes `context_id`, it is ignored for diff/update decisions and the final persisted markdown is re-rendered from the patched extraction ids.

## Current Data Repair

Existing data repair is out of scope for this spec.

Runtime restore/write paths must not repair old checkpoint shapes or arbitrary derived index corruption. Current data repair outside checkpoint-version product restore should be covered by a separate offline repair script/spec and run with the server stopped.

## Test Plan

- New snapshot writes use `latestSnapshot.snapshotSequence + 1`.
- Snapshot sequence allocation and duplicate detection are scoped by `project + agent + sessionId + extractor`.
- Null or missing ingest session ids normalize to `DEFAULT_SESSION_ID` before runtime/checkpoint/index identity.
- `ThreadSnapshot.title` and `ThreadSnapshot.summary` are regenerated from content and cannot drift independently.
- Checkpoint thread refs store `latestSnapshotId`, not `latestSnapshotSequence`.
- Checkpoint thread refs store `indexedSnapshotSequence` as the durable derived-index cursor.
- Checkpoint thread refs are exhaustive: every restored session identity with snapshots has exactly one `ThreadRef`.
- Checkpoint thread refs include `project`, `agent`, and `sessionId` for diagnostics and index cursor ownership.
- Checkpoint schema rejects the previous thread ref shape.
- Checkpoint schema requires `committedEpoch`; `-1` represents no committed epoch.
- Checkpoint no longer persists `SessionIndexCheckpoint` as a session/search recovery source.
- Project dreaming watermarks remain checkpoint cursor state and do not use `dreaming_project`.
- Checkpoint records `turn` input version and product table versions for `session_snapshot`, `session`, `extraction`, and `dreaming`.
- Native storage exposes product table stats and restore for every product table.
- Checkpoint export copies exactly one immutable `PublishedCheckpointBoundary` without blocking product writers globally.
- `PublishedCheckpointBoundary` contains matching table versions, extractor checkpoint, and dreaming checkpoint state.
- Product restore to a Lance version creates a new latest version whose content matches the checkpoint version.
- Checkpoint cleanup floors retain the product table versions referenced by the latest checkpoint.
- Restore never rolls back the `turn` table.
- Restore fails closed when current `turn` table version is lower than checkpoint `turn` version.
- Restore skips product restore when all current product table versions already equal checkpoint product versions.
- Restore restores all product tables when any current product table version is newer than the checkpoint product version.
- Restore fails closed when a checkpoint product version is no longer restorable.
- Restore restores all product tables to checkpoint versions before accepting writes.
- Restore version `0` materializes an empty current-schema table instead of preserving post-checkpoint rows.
- After restoring version `0`, fresh checkpoint records the new current table version rather than keeping `0`.
- Restore is idempotent if interrupted after only some product tables have been restored.
- After successful product restore, checkpoint rewrite happens only after thread refs/cursors are validated and runtime state is rebuilt.
- After successful product restore, checkpoint rewrite records the new product table versions without changing logical cursors or `committedEpoch`.
- Invalid checkpoint restore fails closed for writes instead of starting extraction as fresh.
- Restore uses `latestSnapshotId` to read `session_snapshot`; it does not require in-memory history.
- Restore does not fast-forward to product rows newer than checkpoint product versions.
- Turns after checkpoint `committedEpoch` are loaded from the append-only `turn` table and re-extracted.
- Restore refuses to silently substitute a different latest row when `latestSnapshotId` is missing or mismatched.
- Restore does not infer `committedEpoch` from extraction refs.
- Restore does not lower `committedEpoch` when product restore or checkpoint cursor validation fails.
- Restore computes `nextEpoch` from checkpoint `nextEpoch`, checkpoint `committedEpoch + 1`, and pending turn epochs, never from a lower default.
- Pending turns with `extractionEpoch > committedEpoch` retain their existing epoch/group on retry.
- Pending turns with `extractionEpoch > committedEpoch` do not advance checkpoint `committedEpoch` until their derived product writes are checkpointed.
- Durable checkpoint `committedEpoch` advances only after product table versions for that state are recorded.
- Checkpoint write blocks any attempted `committedEpoch` regression.
- Latest read can use pending/latest runtime state.
- Timeline read always queries `session_snapshot` by full session identity plus extractor scope.
- `muninn-read session_*` is persisted-only and does not include runtime `pendingSnapshot`.
- `muninn-read session_*` returns stored `session_snapshot.content` directly and does not append `## Extraction Context References`.
- `muninn-read session_*` does not scan the `extraction` table.
- `muninn-read ext:*` continues to read extraction rows by id.
- `SessionThread` does not store `indexedSnapshotSequence`; runtime index state owns the mutable cursor.
- Restore initializes each runtime index cursor from checkpoint `indexedSnapshotSequence`.
- The restored latest snapshot's authoritative sequence may be greater than checkpoint `indexedSnapshotSequence`; restore resumes derived indexing from the cursor.
- Index previous-boundary lookup fails when the scoped snapshot sequence is missing or duplicated.
- Index cursor advances only after session and extraction derived writes both succeed.
- Checkpoint export records lagging `indexedSnapshotSequence` when session/extraction index work is pending or failed.
- Retrying the same snapshot converges to the same session/extraction derived rows.
- Merge retry works even if old source extraction rows were already deleted.
- Extraction add generates a new random UUID.
- Extraction update preserves the existing UUID.
- Extraction merge generates a new random UUID for the merged extraction.
- Extraction ids are not derived from content hash, session identity, snapshot sequence, title/summary, or refs.
- Newly written extraction blocks require a valid `context_id: ext:<uuid>` matching the patched extraction id.
- Old snapshots missing `context_id` are read as-is and are not repaired on the `muninn-read session_*` hot path.
- Extraction index upserts build row `turnRefs` from current snapshot extraction refs, not from old extraction rows.
- Extraction index deletes are computed from previous/current snapshot content, not from old extraction table state.
- Extraction update/merge preserves complete historical refs in rendered content.
- LLM-provided `context_id` metadata is ignored for extraction diff/update identity; persisted markdown is re-rendered from patched extraction ids.
- `session_snapshot.references` may be empty or a derived union cache, and is not used as provenance truth.
- Residual `dreaming_project` schema/table/native binding/migration-script code is removed, and runtime project dreaming watermarks continue to use checkpoint state rather than a product table.
