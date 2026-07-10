# Session Snapshot Sequence Checkpoint Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop extractor checkpoint waterlines from regressing when `SessionThread` is restored from partial `session_snapshot` history, and provide a one-time repair path for already-corrupted snapshot sequences/checkpoints.

**Architecture:** Keep `session_snapshot` as the single source of truth for `snapshotSequence`; in-memory `SessionThread` may cache snapshot contents, but it must carry the real persisted sequence for every cached snapshot. Checkpoint restore must be able to derive covered turn ids and a high committed epoch from snapshot references, and checkpoint export must never derive persisted sequence values from array indexes.

**Tech Stack:** TypeScript server memory runtime, native Lance-backed table bindings, Node test runner, repository-local `pnpm --filter @muninn/server test`.

## Global Constraints

- Do not design or implement forward compatibility; update current schema/interface usage only.
- Keep business logic in `server/src/memory` / pipeline code, not MCP/web/CLI.
- `session_snapshot` is the source of truth for snapshot row identity and sequence.
- Existing public `snapshotId` values should be preserved during data repair whenever native insertion supports explicit ids.
- Before any destructive local data repair, stop the server and create a filesystem backup of `$MUNINN_HOME/main`.

---

## File Structure

- Modify `server/src/pipeline/session.ts`
  - Add real `snapshotSequences` to `SessionThread`.
  - Convert all snapshot serialization/flush helpers from array-index semantics to true sequence semantics.
  - Keep `snapshots[]` as a cache for now; do not perform a large refactor to remove it in this bugfix.
- Modify `server/src/pipeline/extractor.ts`
  - Export checkpoint threads with true latest snapshot sequence.
  - Restore checkpoint threads using `session_snapshot` row sequences.
  - During restore, mark baseline snapshot references as already indexed and use their turn epochs to repair a too-low committed epoch.
  - Add diagnostic logging for restore fallback reasons.
- Modify `server/src/pipeline/extraction.ts`
  - Use true snapshot sequences for `indexedSnapshotSequence`; use array indexes only for local cache lookup.
- Modify `server/src/checkpoint.ts` or `server/src/watchdog.ts`
  - Add a monotonic guard so a checkpoint export cannot lower extractor `committedEpoch` silently.
- Modify `server/test/memory/client-internals.test.mjs`
  - Add regression tests for partial snapshot history, restore recovery, checkpoint export, and indexing.
- Create `scripts/repair-session-snapshot-sequences.mjs`
  - Dry-run and apply one-time repair for existing `session_snapshot` groups with duplicate/non-contiguous sequences.

---

### Task 1: Add Regression Tests For True Snapshot Sequences

**Files:**
- Modify: `server/test/memory/client-internals.test.mjs`

**Interfaces:**
- Consumes: existing helpers `makeExtractableTurn`, `makeCheckpointContent`, `makeExtractorCheckpoint`, `snapshotContentFixture`, `emptySnapshotSignals`.
- Produces: failing tests that prove array indexes must not be used as persisted `snapshotSequence`.

- [ ] **Step 1: Add a test for flushing after partial history**

Add this test near the existing session pipeline tests:

```js
test('flushThreads appends using persisted snapshotSequence after partial history restore', async () => {
  const now = new Date().toISOString();
  const inserted = [];
  const thread = threadFromSnapshots([
    {
      snapshotId: 'snapshot-36',
      sessionId: 'session-a',
      project: 'project-a',
      cwd: '/workspace/project-a',
      agent: 'codex',
      snapshotSequence: 36,
      createdAt: now,
      updatedAt: now,
      extractor: 'default-extractor',
      title: 'Thread',
      summary: 'Summary 36',
      ...emptySnapshotSignals(),
      content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary 36' }),
      references: ['turn-36'],
    },
    {
      snapshotId: 'snapshot-73',
      sessionId: 'session-a',
      project: 'project-a',
      cwd: '/workspace/project-a',
      agent: 'codex',
      snapshotSequence: 73,
      createdAt: now,
      updatedAt: now,
      extractor: 'default-extractor',
      title: 'Thread',
      summary: 'Summary 73',
      ...emptySnapshotSignals(),
      content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary 73' }),
      references: ['turn-36', 'turn-73'],
    },
  ], 73);

  applyExtraction(thread, {
    title: 'Thread',
    summary: 'Summary 74',
    memorySignals: [],
    skillSignals: [],
    skillDetails: {},
    extractions: [],
    nextSteps: [],
    contextRefs: [{ turnId: 'turn-74' }],
  }, 74, () => ({ extractionChanges: [], extractions: [] }), now);

  await flushThreads({
    sessionSnapshotTable: {
      insert: async ({ snapshots }) => {
        inserted.push(...snapshots);
        return snapshots.map((snapshot) => ({ ...snapshot, snapshotId: 'snapshot-74' }));
      },
    },
  }, [thread], new Set([threadIdentityKey(thread)]));

  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].snapshotSequence, 74);
  assert.deepEqual(thread.snapshotSequences, [36, 73, 74]);
  assert.equal(thread.snapshotId, 'snapshot-74');
});
```

- [ ] **Step 2: Add a test for checkpoint export using true latest sequence**

Add this test near extractor checkpoint tests:

```js
test('extractor exports checkpoint thread with persisted latest snapshotSequence', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath);
  const now = new Date().toISOString();
  const extractor = new Extractor({
    turnTable: { loadTurnsAfterEpoch: async () => [] },
    sessionSnapshotTable: { listSnapshots: async () => [] },
    extractionTable: {},
  }, null);
  t.after(async () => extractor.shutdown());

  extractor.threads = [threadFromSnapshots([
    {
      snapshotId: 'snapshot-36',
      sessionId: 'session-a',
      project: 'project-a',
      cwd: '/workspace/project-a',
      agent: 'codex',
      snapshotSequence: 36,
      createdAt: now,
      updatedAt: now,
      extractor: 'default-extractor',
      title: 'Thread',
      summary: 'Summary 36',
      ...emptySnapshotSignals(),
      content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary 36' }),
      references: ['turn-36'],
    },
    {
      snapshotId: 'snapshot-73',
      sessionId: 'session-a',
      project: 'project-a',
      cwd: '/workspace/project-a',
      agent: 'codex',
      snapshotSequence: 73,
      createdAt: now,
      updatedAt: now,
      extractor: 'default-extractor',
      title: 'Thread',
      summary: 'Summary 73',
      ...emptySnapshotSignals(),
      content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary 73' }),
      references: ['turn-36', 'turn-73'],
    },
  ], 73)];

  const checkpoint = extractor.exportCheckpoint();
  assert.equal(checkpoint.threads[0].latestSnapshotId, 'snapshot-73');
  assert.equal(checkpoint.threads[0].latestSnapshotSequence, 73);
});
```

- [ ] **Step 3: Add a restore test for too-low committedEpoch**

Add this test near `extractor restore advances committedEpoch and excludes extracted turns from pending`:

```js
test('extractor restore repairs low committedEpoch from baseline snapshot refs', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath, { activeWindowDays: 7 });
  const now = new Date().toISOString();
  const checkpoint = makeExtractorCheckpoint({
    committedEpoch: 10,
    threads: [{
      sessionId: 'session-a',
      latestSnapshotId: 'snapshot-73',
      latestSnapshotSequence: 73,
      indexedSnapshotSequence: 73,
      updatedAt: now,
    }],
  });
  const turnLoads = [];
  const extractor = new Extractor({
    turnTable: {
      loadTurnsAfterEpoch: async ({ committedEpoch }) => {
        turnLoads.push(committedEpoch);
        return [
          makeExtractableTurn('turn-72', 72, 'epoch72'),
          makeExtractableTurn('turn-73', 73, 'epoch73'),
          makeExtractableTurn('turn-74', 74, 'epoch74'),
        ];
      },
      getTurn: async (turnId) => ({
        'turn-72': makeExtractableTurn('turn-72', 72, 'epoch72'),
        'turn-73': makeExtractableTurn('turn-73', 73, 'epoch73'),
        'turn-74': makeExtractableTurn('turn-74', 74, 'epoch74'),
      })[turnId] ?? null,
    },
    sessionSnapshotTable: {
      delta: async () => ({ sourceVersion: 21, rows: [] }),
      threadSnapshots: async () => [
        {
          snapshotId: 'snapshot-36',
          sessionId: 'session-a',
          project: 'project-a',
          cwd: '/workspace/project-a',
          agent: 'codex',
          snapshotSequence: 36,
          createdAt: now,
          updatedAt: now,
          extractor: 'default-extractor',
          title: 'Thread',
          summary: 'Summary 36',
          ...emptySnapshotSignals(),
          content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary 36' }),
          references: ['turn-72'],
        },
        {
          snapshotId: 'snapshot-73',
          sessionId: 'session-a',
          project: 'project-a',
          cwd: '/workspace/project-a',
          agent: 'codex',
          snapshotSequence: 73,
          createdAt: now,
          updatedAt: now,
          extractor: 'default-extractor',
          title: 'Thread',
          summary: 'Summary 73',
          ...emptySnapshotSignals(),
          content: snapshotContentFixture('', { title: 'Thread', summary: 'Summary 73' }),
          references: ['turn-72', 'turn-73'],
        },
      ],
    },
    extractionTable: {},
  }, checkpoint);
  t.after(async () => extractor.shutdown());

  const restored = await extractor.restore();

  assert.deepEqual(turnLoads, [10]);
  assert.equal(restored.committedEpoch, 73);
  assert.deepEqual(restored.pendingTurns.map((turn) => turn.turnId), ['turn-74']);
  assert.deepEqual(restored.threads[0].snapshotSequences, [36, 73]);
});
```

- [ ] **Step 4: Run tests and verify they fail before implementation**

Run:

```bash
pnpm --filter @muninn/server test -- server/test/memory/client-internals.test.mjs
```

Expected before implementation: failures mention `snapshotSequences` missing or `snapshotSequence` equal to an array index.

---

### Task 2: Preserve Persisted Snapshot Sequences In `SessionThread`

**Files:**
- Modify: `server/src/pipeline/session.ts`

**Interfaces:**
- Produces: `SessionThread.snapshotSequences: number[]`.
- Produces: `latestSnapshotSequence(thread: SessionThread): number | null`.
- Produces: `snapshotIndexForSequence(thread: SessionThread, sequence: number): number`.

- [ ] **Step 1: Extend `SessionThread`**

Change the type:

```ts
export type SessionThread = {
  threadId: string;
  kind: SessionThreadKind;
  sessionId?: string | null;
  project: string;
  cwd: string;
  agent: string;
  snapshotId?: string;
  snapshotIds: string[];
  snapshotSequences: number[];
  snapshotEpochs?: number[];
  extractionEpoch: number;
  title: string;
  summary: string;
  snapshots: SnapshotContent[];
  references: string[];
  indexedSnapshotSequence?: number | null;
  extractor: string;
  createdAt: string;
  updatedAt: string;
};
```

- [ ] **Step 2: Initialize and clone sequence arrays**

Update new-thread and clone paths:

```ts
snapshotIds: [],
snapshotSequences: [],
snapshotEpochs: [],
```

and:

```ts
snapshotIds: [...thread.snapshotIds],
snapshotSequences: [...thread.snapshotSequences],
snapshotEpochs: [...(thread.snapshotEpochs ?? [])],
```

- [ ] **Step 3: Preserve row sequences in `threadFromSnapshots`**

Replace the relevant return fields with:

```ts
snapshotId: latest.snapshotId,
snapshotIds: ordered.map((row) => row.snapshotId),
snapshotSequences: ordered.map((row) => row.snapshotSequence),
snapshotEpochs: ordered.map(() => extractionEpoch),
```

- [ ] **Step 4: Add local helpers**

Add below `latestSnapshot`:

```ts
export function latestSnapshotSequence(thread: SessionThread): number | null {
  return thread.snapshotSequences[thread.snapshotSequences.length - 1] ?? null;
}

export function snapshotIndexForSequence(thread: SessionThread, sequence: number): number {
  return thread.snapshotSequences.findIndex((candidate) => candidate === sequence);
}

export function snapshotSequenceAt(thread: SessionThread, snapshotIndex: number): number {
  const sequence = thread.snapshotSequences[snapshotIndex];
  if (sequence == null) {
    throw new Error(`missing snapshot sequence for session memory thread ${thread.threadId} at index ${snapshotIndex}`);
  }
  return sequence;
}
```

- [ ] **Step 5: Make `applyExtraction` append the next true sequence**

Before pushing the new snapshot:

```ts
const previousSequence = latestSnapshotSequence(thread);
const nextSequence = previousSequence == null ? 0 : previousSequence + 1;
```

After `thread.snapshots.push(...)`:

```ts
thread.snapshotSequences.push(nextSequence);
```

- [ ] **Step 6: Make serialization use index separately from persisted sequence**

Replace `toSessionSnapshot` / `toSessionSnapshotAt` with:

```ts
export function toSessionSnapshot(thread: SessionThread): SessionSnapshot {
  if (thread.snapshots.length === 0) {
    throw new Error(`missing snapshots for session memory thread ${thread.threadId}`);
  }
  return toSessionSnapshotAt(thread, thread.snapshots.length - 1);
}

function toSessionSnapshotAt(thread: SessionThread, snapshotIndex: number): SessionSnapshot {
  const snapshot = thread.snapshots[snapshotIndex];
  if (!snapshot) {
    throw new Error(`missing snapshot for session memory thread ${thread.threadId} at index ${snapshotIndex}`);
  }
  const snapshotSequence = snapshotSequenceAt(thread, snapshotIndex);
  return {
    snapshotId: thread.snapshotIds[snapshotIndex] ?? PENDING_SNAPSHOT_ID,
    sessionId: thread.sessionId ?? thread.threadId,
    project: thread.project,
    cwd: thread.cwd,
    agent: thread.agent,
    snapshotSequence,
    createdAt: thread.updatedAt,
    updatedAt: thread.updatedAt,
    extractor: thread.extractor,
    title: thread.title,
    summary: thread.summary,
    memorySignals: [...(snapshot.memorySignals ?? [])],
    skillSignals: [...(snapshot.skillSignals ?? [])],
    skillDetails: JSON.stringify(snapshot.skillDetails ?? {}),
    content: snapshot.snapshotContent,
    references: snapshot.contextRefs.map((reference) => reference.turnId),
  };
}
```

- [ ] **Step 7: Fix `flushThreads` pending row detection**

Replace the loop bound with sequence-array alignment:

```ts
for (let index = thread.snapshotIds.length; index < thread.snapshots.length; index += 1) {
  rows.push(toSessionSnapshotAt(thread, index));
}
```

Keep this shape only after ensuring `thread.snapshotIds.length`, `thread.snapshotSequences.length`, and `thread.snapshots.length` are aligned for persisted rows. If Task 2 Step 5 does not push a pending id, this loop remains correct because `snapshotIds.length` marks persisted count.

- [ ] **Step 8: Fix `updateThreadsFromRows`**

When persisted rows return:

```ts
const index = snapshotIndexForSequence(thread, row.snapshotSequence);
if (index < 0) {
  throw new Error(`persisted snapshot sequence ${row.snapshotSequence} was not staged for session memory thread ${thread.threadId}`);
}
thread.snapshotIds[index] = row.snapshotId;
thread.snapshotId = row.snapshotId;
thread.updatedAt = row.updatedAt;
```

- [ ] **Step 9: Run Task 1 flushing test**

Run:

```bash
pnpm --filter @muninn/server test -- server/test/memory/client-internals.test.mjs --test-name-pattern "flushThreads appends using persisted snapshotSequence"
```

Expected: PASS.

---

### Task 3: Use True Sequences In Checkpoint Restore And Indexing

**Files:**
- Modify: `server/src/pipeline/extractor.ts`
- Modify: `server/src/pipeline/extraction.ts`

**Interfaces:**
- Consumes: `latestSnapshotSequence`, `snapshotIndexForSequence`, `snapshotSequenceAt`.
- Produces: checkpoint thread refs whose `latestSnapshotId` and `latestSnapshotSequence` come from the same snapshot row.

- [ ] **Step 1: Export checkpoint thread refs from true sequence**

In `exportCheckpointThreads`, replace:

```ts
latestSnapshotSequence: thread.snapshots.length - 1,
```

with:

```ts
const sequence = latestSnapshotSequence(thread);
return {
  sessionId: thread.sessionId ?? thread.threadId,
  latestSnapshotId: thread.snapshotId ?? '',
  latestSnapshotSequence: sequence ?? -1,
  indexedSnapshotSequence: thread.indexedSnapshotSequence ?? null,
  updatedAt: thread.updatedAt,
};
```

Then filter out negative sequences:

```ts
.filter((thread) => thread.latestSnapshotId.length > 0 && thread.latestSnapshotSequence >= 0);
```

- [ ] **Step 2: Restore checkpoint threads without array-index assumptions**

In `replayCheckpoint`, after building `baselineRows`, keep the existing id/sequence validation, then build the thread:

```ts
const thread = threadFromSnapshots(
  baselineRows,
  section.committedEpoch ?? 0,
  threadRef.indexedSnapshotSequence ?? null,
);
```

Add collection of already-covered refs:

```ts
const coveredRefs = new Set<string>();
for (const row of baselineRows) {
  for (const reference of row.references) {
    coveredRefs.add(reference);
  }
}
const coveredEpoch = await this.indexCoveredRefs(coveredRefs, turnCache);
for (const reference of coveredRefs) {
  indexedTurnIds.add(reference);
}
if (coveredEpoch != null) {
  committedEpoch = committedEpoch == null || coveredEpoch > committedEpoch
    ? coveredEpoch
    : committedEpoch;
}
```

- [ ] **Step 3: Add `indexCoveredRefs` helper**

Add a private helper in `Extractor`:

```ts
private async indexCoveredRefs(
  refs: Set<string>,
  turnCache: Map<string, TurnRow>,
): Promise<number | undefined> {
  let maxEpoch: number | undefined;
  for (const reference of refs) {
    let turn = turnCache.get(reference);
    if (!turn) {
      turn = await this.client.turnTable.getTurn?.(reference) ?? undefined;
      if (turn) {
        turnCache.set(reference, turn);
      }
    }
    if (turn?.extractionEpoch == null) {
      continue;
    }
    maxEpoch = maxEpoch == null || turn.extractionEpoch > maxEpoch
      ? turn.extractionEpoch
      : maxEpoch;
  }
  return maxEpoch;
}
```

- [ ] **Step 4: Fix appended-row replay to compare true sequences**

Keep:

```ts
const appendedRows = (rowsById.get(threadRef.sessionId) ?? [])
  .filter((row) => row.snapshotSequence > threadRef.latestSnapshotSequence)
  .sort((left, right) => left.snapshotSequence - right.snapshotSequence);
```

In `replaySnapshots`, stop using `row.snapshotSequence === thread.snapshots.length` as the invariant; use `latestSnapshotSequence(thread)`.

- [ ] **Step 5: Fix extraction indexing**

In `server/src/pipeline/extraction.ts`, change:

```ts
latestIndexedSequence = snapshotIndex;
```

to:

```ts
latestIndexedSequence = snapshotSequenceAt(thread, snapshotIndex);
```

and make `getPendingIndex(thread)` find indexes from true sequence:

```ts
const startSequence = (thread.indexedSnapshotSequence ?? -1) + 1;
const start = thread.snapshotSequences.findIndex((sequence) => sequence >= startSequence);
const end = thread.snapshots.length - 1;
```

- [ ] **Step 6: Run restore/indexing tests**

Run:

```bash
pnpm --filter @muninn/server test -- server/test/memory/client-internals.test.mjs --test-name-pattern "extractor restore repairs low committedEpoch|exports checkpoint thread"
```

Expected: PASS.

---

### Task 4: Add Diagnostics And Monotonic Checkpoint Guard

**Files:**
- Modify: `server/src/pipeline/extractor.ts`
- Modify: `server/src/checkpoint.ts` or `server/src/watchdog.ts`
- Modify: `server/test/memory/client-internals.test.mjs`

**Interfaces:**
- Produces restore fallback logs with a reason string.
- Produces a guard preventing silent `committedEpoch` regression.

- [ ] **Step 1: Add restore failure reason logging**

Replace silent `return null` branches in `restore()`/`replayCheckpoint()` with a compact internal reason helper:

```ts
private restoreFailure(reason: string, details: Record<string, unknown> = {}): null {
  this.log?.warn?.('extractor_restore_failed', { reason, ...details });
  return null;
}
```

Use concrete reasons:

```ts
return this.restoreFailure('checkpoint_snapshot_mismatch', {
  sessionId: threadRef.sessionId,
  expectedSnapshotId: threadRef.latestSnapshotId,
  expectedSnapshotSequence: threadRef.latestSnapshotSequence,
  actualSnapshotId: latest.snapshotId,
  actualSnapshotSequence: latest.snapshotSequence,
});
```

- [ ] **Step 2: Add committedEpoch monotonic guard**

Before checkpoint write, compare previous and next extractor sections:

```ts
const previousEpoch = previous.sections?.extractor?.committedEpoch;
const nextEpoch = next.sections?.extractor?.committedEpoch;
if (previousEpoch != null && nextEpoch != null && nextEpoch < previousEpoch) {
  next.sections.extractor.committedEpoch = previousEpoch;
}
```

Also log:

```ts
log.warn('checkpoint_committed_epoch_regression_blocked', {
  previousEpoch,
  attemptedEpoch: nextEpoch,
});
```

- [ ] **Step 3: Add a unit test for the guard**

Add a test that writes a checkpoint with `committedEpoch: 482`, attempts to export/write `committedEpoch: 10`, and asserts the final file still has `482`.

- [ ] **Step 4: Run checkpoint tests**

Run:

```bash
pnpm --filter @muninn/server test -- server/test/memory/client-internals.test.mjs --test-name-pattern "committedEpoch"
```

Expected: PASS.

---

### Task 5: One-Time Data Repair Tool

**Files:**
- Create: `scripts/repair-session-snapshot-sequences.mjs`

**Interfaces:**
- Consumes: `createNativeTables`, `loadMuninnConfig`, `resolveStorageTarget`, `getEffectiveExtractorName`.
- Produces: dry-run report and optional `--apply` rewrite for session snapshot groups with duplicate or non-contiguous sequences.

- [ ] **Step 1: Create dry-run script**

Create `scripts/repair-session-snapshot-sequences.mjs`:

```js
#!/usr/bin/env node
import { createNativeTables } from '../server/dist/native.js';
import { loadMuninnConfig, resolveStorageTarget, getEffectiveExtractorName } from '../server/dist/config.js';

const apply = process.argv.includes('--apply');
const database = process.argv.find((arg) => arg.startsWith('--database='))?.slice('--database='.length) ?? 'main';
const config = loadMuninnConfig() ?? {};
const extractor = getEffectiveExtractorName(config);
const tables = await createNativeTables(resolveStorageTarget(config, database));

try {
  const rows = await tables.sessionSnapshotTable.listSnapshots({ extractor });
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.project}\u0000${row.agent}\u0000${row.sessionId}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const repairs = [];
  for (const [key, group] of groups) {
    const ordered = [...group].sort((left, right) => (
      left.updatedAt.localeCompare(right.updatedAt)
      || left.snapshotId.localeCompare(right.snapshotId)
    ));
    const sequences = ordered.map((row) => row.snapshotSequence);
    const duplicateCount = sequences.length - new Set(sequences).size;
    const contiguous = sequences.every((sequence, index) => sequence === index);
    if (duplicateCount === 0 && contiguous) {
      continue;
    }
    const rewritten = ordered.map((row, index) => ({
      ...row,
      snapshotSequence: index,
    }));
    repairs.push({
      key,
      count: group.length,
      firstSequence: Math.min(...sequences),
      lastSequence: Math.max(...sequences),
      duplicateCount,
      snapshotIds: ordered.map((row) => row.snapshotId),
      rewritten,
    });
  }

  console.log(JSON.stringify({
    database,
    extractor,
    apply,
    repairCount: repairs.length,
    repairs: repairs.map(({ rewritten, ...repair }) => repair),
  }, null, 2));

  if (!apply) {
    process.exit(0);
  }

  for (const repair of repairs) {
    await tables.sessionSnapshotTable.delete({ snapshotIds: repair.snapshotIds });
    await tables.sessionSnapshotTable.insert({ snapshots: repair.rewritten });
  }
} finally {
  await tables.close?.();
}
```

- [ ] **Step 2: Add a dry-run command to the plan**

Run after server build:

```bash
MUNINN_HOME=/home/majin.nathan/.muninn node scripts/repair-session-snapshot-sequences.mjs --database=main
```

Expected for current data: one repair group for session `019ef796-fccf-7780-8a9c-529b6e8c7a24`, with duplicate sequence count around `34`.

- [ ] **Step 3: Apply only after backup**

Commands:

```bash
pnpm --filter @muninn/server build
MUNINN_HOME=/home/majin.nathan/.muninn node scripts/repair-session-snapshot-sequences.mjs --database=main --apply
```

Expected: affected group is rewritten with contiguous `snapshotSequence` values and preserved `snapshotId` values.

---

### Task 6: Verification And Runtime Recovery

**Files:**
- Modify only if tests reveal missed call sites.

**Interfaces:**
- Produces a server that starts without treating already snapshot-covered turns as pending.

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm --filter @muninn/server test -- server/test/memory/client-internals.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run server build**

Run:

```bash
pnpm --filter @muninn/server build
```

Expected: PASS.

- [ ] **Step 3: Inspect current data after repair**

Run the existing data inspection query and assert:

```json
{
  "problemCount": 0
}
```

- [ ] **Step 4: Restart local shared server**

Run:

```bash
NODE_USE_ENV_PROXY=1 MUNINN_HOME=/home/majin.nathan/.muninn pnpm muninn restart --host 0.0.0.0 --port 8080 --force
```

Expected: server starts; extractor restore logs do not include `checkpoint_snapshot_mismatch`; pending count is not inflated by already snapshot-covered turns.

- [ ] **Step 5: Verify checkpoint after one watchdog flush**

Read:

```bash
node -e 'const fs=require("fs"); const p="/home/majin.nathan/.muninn/main/checkpoints/42b9e7d6778ce5ad.json"; const c=JSON.parse(fs.readFileSync(p,"utf8")); console.log(c.sections.extractor.committedEpoch, c.sections.extractor.nextEpoch);'
```

Expected: `committedEpoch` is greater than `10`, or at minimum not lower than the recovered snapshot-covered epoch.

---

## Self-Review

- Spec coverage: This plan addresses why `snapshotSequence` was derived incorrectly, why restore fell back, why pending turns inflated, and how to repair current corrupted data.
- Placeholder scan: No task uses TBD/TODO language; each task names files, commands, and expected outcomes.
- Type consistency: `snapshotSequences`, `latestSnapshotSequence`, `snapshotIndexForSequence`, and `snapshotSequenceAt` are defined in Task 2 before Task 3 consumes them.
- Risk note: The repair script is intentionally separate from runtime code and must be run only after a filesystem backup.
