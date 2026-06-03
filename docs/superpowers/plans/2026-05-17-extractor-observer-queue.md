# Extractor Observer Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace observer extraction-delta scanning with explicit extractor-to-observer queued handoff, then make LoCoMo benchmark use explicit memory finalize and fail fast on Muninn internal errors.

**Architecture:** Extractor records extraction changes in checkpoint-backed `pendingExtractionChanges`, commits them to the extraction table, then hands them off to `observer.observeQueue` grouped by Entity anchor. Observer drains queued anchor batches into observation documents; watermark becomes status-only and finalize becomes the explicit barrier used by benchmarks.

**Tech Stack:** TypeScript core/sidecar/benchmark bridge, Rust Lance tables through existing native bindings, Node tests, Python benchmark runner tests.

---

## File Structure

- Modify `packages/core/src/checkpoint.ts`
  - Add queued extraction change checkpoint types and parsers.
  - Remove `observer.baseline.extraction`.
- Create `packages/core/src/observer/queue.ts`
  - Own ordered-set queue operations for pending extraction changes and anchor buckets.
- Modify `packages/core/src/extractor/memory-delta.ts`
  - Return committed extraction changes with full stored rows.
- Modify `packages/core/src/extractor/update.ts`
  - Propagate committed extraction changes from indexing to extractor runtime.
- Modify `packages/core/src/extractor/extractor.ts`
  - Store `pendingExtractionChanges`, perform handoff, expose finalize semantics.
- Modify `packages/core/src/observer/runner.ts`
  - Stop loading extraction delta; process queued anchor batches.
  - Apply observation link updates only when `observationIds` changes.
- Modify `packages/core/src/observer/observer.ts`
  - Own `observeQueue`, enqueue from extractor handoff, expose status/finalize.
- Modify `packages/core/src/backend.ts`
  - Split `memoryWatermark()` status from new `memoryFinalize()` barrier.
  - Export/import new checkpoint state.
- Modify `packages/core/src/watchdog.ts`
  - Expose a public checkpoint flush method used by finalize.
- Modify `packages/types/src/api.ts`
  - Extend watermark response with observer queued/ready status.
- Modify `packages/sidecar/src/memory_loader.ts`
  - Add `POST /api/v1/memory/finalize`.
- Modify `benchmark/locomo/src/bridge.ts`
  - Use finalize before QA; keep watermark for status/progress.
- Modify `benchmark/locomo/scripts/run_muninn_eval.py`
  - Add Muninn internal fatal classification and diagnostic JSON writing.
- Modify tests:
  - `packages/core/test/client-internals.test.mjs`
  - `packages/core/test/observer-runner.test.mjs`
  - `packages/core/test/client.test.mjs`
  - `packages/sidecar/test/session_flow.test.mjs`
  - `benchmark/locomo/test/bridge.test.mjs`
  - `benchmark/locomo/tests/test_run_muninn_eval.py`

## Task 1: Checkpoint Types And Queue Parser

**Files:**
- Modify: `packages/core/src/checkpoint.ts`
- Test: `packages/core/test/client-internals.test.mjs`

- [ ] **Step 1: Add failing checkpoint parser tests**

Add tests that parse and serialize the new checkpoint shape:

```js
test('checkpoint parses extractor pending extraction changes and observer queue', async () => {
  const { parseCheckpointFile } = await import('../dist/checkpoint.js');
  const parsed = parseCheckpointFile(JSON.stringify({
    schemaVersion: 6,
    writtenAt: '2026-05-17T00:00:00.000Z',
    writerPid: 1,
    extractor: {
      baseline: { turn: 1, session: 2, extraction: 3, observation: 4 },
      nextEpoch: 5,
      recentSessions: [],
      threads: [],
      runs: [],
      pendingExtractionChanges: [
        {
          type: 'upsert',
          extraction: {
            id: 'ex-1',
            text: 'Caroline attended a support group.',
            context: 'Caroline discussed what she did yesterday.',
            anchors: ['Entity: Caroline'],
            vector: [0.1, 0.2],
            importance: 0.5,
            category: 'Fact',
            turnRefs: ['turn:1'],
            observationIds: [],
            observedRootAnchors: [],
            createdAt: '2026-05-17T00:00:00.000Z',
            updatedAt: '2026-05-17T00:00:00.000Z'
          }
        }
      ]
    },
    observer: {
      baseline: { observationContext: 6, observation: 7 },
      runs: [],
      observeQueue: {
        anchors: [
          {
            key: 'caroline',
            anchor: 'Caroline',
            extractionChanges: [
              {
                type: 'delete',
                extraction: {
                  id: 'ex-2',
                  text: 'Old detail.',
                  context: null,
                  anchors: ['Entity: Caroline'],
                  vector: [0.1, 0.2],
                  importance: 0.5,
                  category: 'Fact',
                  turnRefs: ['turn:2'],
                  observationIds: ['obs-1'],
                  observedRootAnchors: [],
                  createdAt: '2026-05-17T00:00:00.000Z',
                  updatedAt: '2026-05-17T00:00:00.000Z'
                }
              }
            ]
          }
        ]
      }
    }
  }));
  assert.equal(parsed.extractor.pendingExtractionChanges.length, 1);
  assert.equal(parsed.observer.observeQueue.anchors[0].extractionChanges[0].type, 'delete');
  assert.equal(parsed.observer.baseline.extraction, undefined);
});
```

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/core build && node --test packages/core/test/client-internals.test.mjs
```

Expected: FAIL because checkpoint parser does not know the new fields.

- [ ] **Step 2: Implement checkpoint types**

In `packages/core/src/checkpoint.ts`, add:

```ts
export type QueuedExtractionChange =
  | { type: 'upsert'; extraction: import('./native.js').Extraction }
  | { type: 'delete'; extraction: import('./native.js').Extraction };
```

Update `ExtractorCheckpoint`:

```ts
export type ExtractorCheckpoint = {
  baseline: {
    turn: number;
    session: number;
    extraction: number;
    observation: number;
  };
  committedEpoch?: number;
  nextEpoch: number;
  recentSessions: RecentSessionCheckpoint[];
  threads: ThreadRef[];
  runs: ObservingRun[];
  pendingExtractionChanges: QueuedExtractionChange[];
};
```

Update `ObserverCheckpoint`:

```ts
export type ObserverCheckpoint = {
  baseline: {
    observationContext: number;
    observation: number;
  };
  observeQueue: {
    anchors: Array<{
      key: string;
      anchor: string;
      extractionChanges: QueuedExtractionChange[];
    }>;
  };
  runs: ObserverRun[];
};
```

Add parsing helpers:

```ts
function parseQueuedExtractionChanges(value: unknown): QueuedExtractionChange[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const changes: QueuedExtractionChange[] = [];
  for (const entry of value) {
    if (!isObjectRecord(entry) || (entry.type !== 'upsert' && entry.type !== 'delete')) {
      return null;
    }
    const extraction = parseStoredExtraction(entry.extraction);
    if (!extraction) {
      return null;
    }
    changes.push({ type: entry.type, extraction });
  }
  return changes;
}
```

Implement `parseStoredExtraction()` using the current `Native Extraction` fields exactly:

```ts
function parseStoredExtraction(value: unknown): import('./native.js').Extraction | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  if (
    typeof value.id !== 'string'
    || typeof value.text !== 'string'
    || (value.context != null && typeof value.context !== 'string')
    || !Array.isArray(value.anchors)
    || !Array.isArray(value.vector)
    || typeof value.importance !== 'number'
    || typeof value.category !== 'string'
    || !Array.isArray(value.turnRefs)
    || !Array.isArray(value.observationIds)
    || !Array.isArray(value.observedRootAnchors)
    || typeof value.createdAt !== 'string'
    || typeof value.updatedAt !== 'string'
  ) {
    return null;
  }
  return {
    id: value.id,
    text: value.text,
    context: value.context ?? null,
    anchors: value.anchors.map(String),
    vector: value.vector.map(Number),
    importance: value.importance,
    category: value.category,
    turnRefs: value.turnRefs.map(String),
    observationIds: value.observationIds.map(String),
    observedRootAnchors: value.observedRootAnchors.map(String),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}
```

Update `parseCheckpointFile()` and `CheckpointContent` to require `schemaVersion: 6`.

Update `parseExtractorSection()` to require `pendingExtractionChanges`.

Update `parseObserverBaseline()` to no longer read or require `extraction`.

Update `parseObserverSection()` to require `observeQueue`.

- [ ] **Step 3: Run checkpoint tests**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/core build && node --test packages/core/test/client-internals.test.mjs
```

Expected: PASS for the new checkpoint parser test.

## Task 2: Queue Helper

**Files:**
- Create: `packages/core/src/observer/queue.ts`
- Test: `packages/core/test/observer-runner.test.mjs`

- [ ] **Step 1: Add failing queue tests**

Add tests:

```js
test('observe queue groups by entity anchor and replaces duplicate extraction rows', async () => {
  const { enqueueChanges } = await import('../dist/observer/queue.js');
  const base = { anchors: [] };
  const first = extractionRow('ex-1', ['Entity: Caroline'], 'old text');
  const latest = extractionRow('ex-1', ['Entity: Caroline'], 'latest text');
  const queue = enqueueChanges(base, [{ type: 'upsert', extraction: first }]);
  const next = enqueueChanges(queue, [{ type: 'upsert', extraction: latest }]);
  assert.equal(next.anchors.length, 1);
  assert.equal(next.anchors[0].key, 'caroline');
  assert.equal(next.anchors[0].extractionChanges.length, 1);
  assert.equal(next.anchors[0].extractionChanges[0].extraction.text, 'latest text');
});

test('observe queue preserves old bucket when extraction anchor changes', async () => {
  const { enqueueChanges } = await import('../dist/observer/queue.js');
  const oldRow = extractionRow('ex-1', ['Entity: Caroline'], 'old');
  const newRow = extractionRow('ex-1', ['Entity: Melanie'], 'new');
  const queue = enqueueChanges({ anchors: [] }, [{ type: 'upsert', extraction: oldRow }]);
  const next = enqueueChanges(queue, [{ type: 'upsert', extraction: newRow }]);
  assert.deepEqual(next.anchors.map((bucket) => bucket.key), ['caroline', 'melanie']);
  assert.equal(next.anchors[0].extractionChanges[0].extraction.text, 'new');
  assert.equal(next.anchors[1].extractionChanges[0].extraction.text, 'new');
});

test('observe queue batches and acks one anchor bucket', async () => {
  const { enqueueChanges, readyBucket, ackBucket } = await import('../dist/observer/queue.js');
  let queue = { anchors: [] };
  for (let i = 0; i < 9; i += 1) {
    queue = enqueueChanges(queue, [{ type: 'upsert', extraction: extractionRow(`ex-${i}`, ['Entity: Caroline'], `text ${i}`) }]);
  }
  const bucket = readyBucket(queue, { threshold: 8, batchSize: 4, finalize: false });
  assert.equal(bucket.anchor, 'Caroline');
  assert.equal(bucket.extractionChanges.length, 4);
  const acked = ackBucket(queue, bucket.key, bucket.extractionChanges.map((change) => change.extraction.id));
  assert.equal(acked.anchors[0].extractionChanges.length, 5);
});
```

Define a local helper in the test file:

```js
function extractionRow(id, anchors, text) {
  return {
    id,
    text,
    context: null,
    anchors,
    vector: [0.1, 0.2],
    importance: 0.5,
    category: 'Fact',
    turnRefs: ['turn:1'],
    observationIds: [],
    observedRootAnchors: [],
    createdAt: '2026-05-17T00:00:00.000Z',
    updatedAt: '2026-05-17T00:00:00.000Z',
  };
}
```

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/core build && node --test packages/core/test/observer-runner.test.mjs
```

Expected: FAIL because `observer/queue.js` does not exist.

- [ ] **Step 2: Implement queue helper**

Create `packages/core/src/observer/queue.ts`:

```ts
import type { QueuedExtractionChange } from '../checkpoint.js';

export type ObserveQueue = {
  anchors: ObserveAnchorBucket[];
};

export type ObserveAnchorBucket = {
  key: string;
  anchor: string;
  extractionChanges: QueuedExtractionChange[];
};

export type ObserveBatch = {
  key: string;
  anchor: string;
  extractionChanges: QueuedExtractionChange[];
};

export function enqueueChanges(queue: ObserveQueue, changes: QueuedExtractionChange[]): ObserveQueue {
  let next = cloneQueue(queue);
  for (const change of changes) {
    const anchors = entityAnchors(change.extraction);
    for (const anchor of anchors) {
      next = enqueueForAnchor(next, anchor, change);
    }
    for (const bucket of next.anchors) {
      if (bucket.extractionChanges.some((queued) => queued.extraction.id === change.extraction.id)) {
        next = replaceInBucket(next, bucket.key, change);
      }
    }
  }
  return next;
}

export function readyBucket(
  queue: ObserveQueue,
  options: { threshold: number; batchSize: number; finalize: boolean },
): ObserveBatch | null {
  for (const bucket of queue.anchors) {
    const ready = options.finalize
      ? bucket.extractionChanges.length > 0
      : bucket.extractionChanges.length >= options.threshold;
    if (!ready) {
      continue;
    }
    return {
      key: bucket.key,
      anchor: bucket.anchor,
      extractionChanges: bucket.extractionChanges.slice(0, options.batchSize),
    };
  }
  return null;
}

export function ackBucket(queue: ObserveQueue, key: string, extractionIds: string[]): ObserveQueue {
  const ack = new Set(extractionIds);
  const anchors = queue.anchors
    .map((bucket) => bucket.key === key
      ? { ...bucket, extractionChanges: bucket.extractionChanges.filter((change) => !ack.has(change.extraction.id)) }
      : bucket)
    .filter((bucket) => bucket.extractionChanges.length > 0);
  return { anchors };
}

export function queueStats(queue: ObserveQueue, threshold: number): {
  queuedCount: number;
  readyBucketCount: number;
  readyCount: number;
} {
  let queuedCount = 0;
  let readyBucketCount = 0;
  let readyCount = 0;
  for (const bucket of queue.anchors) {
    queuedCount += bucket.extractionChanges.length;
    if (bucket.extractionChanges.length >= threshold) {
      readyBucketCount += 1;
      readyCount += bucket.extractionChanges.length;
    }
  }
  return { queuedCount, readyBucketCount, readyCount };
}

function enqueueForAnchor(queue: ObserveQueue, anchor: string, change: QueuedExtractionChange): ObserveQueue {
  const key = normalizeAnchor(anchor);
  const anchors = [...queue.anchors];
  const index = anchors.findIndex((bucket) => bucket.key === key);
  if (index < 0) {
    anchors.push({ key, anchor, extractionChanges: [change] });
    return { anchors };
  }
  anchors[index] = upsertChange(anchors[index], change);
  return { anchors };
}

function replaceInBucket(queue: ObserveQueue, key: string, change: QueuedExtractionChange): ObserveQueue {
  return {
    anchors: queue.anchors.map((bucket) => bucket.key === key ? upsertChange(bucket, change) : bucket),
  };
}

function upsertChange(bucket: ObserveAnchorBucket, change: QueuedExtractionChange): ObserveAnchorBucket {
  const existing = bucket.extractionChanges.findIndex((queued) => queued.extraction.id === change.extraction.id);
  if (existing < 0) {
    return { ...bucket, extractionChanges: [...bucket.extractionChanges, change] };
  }
  const extractionChanges = [...bucket.extractionChanges];
  extractionChanges[existing] = change;
  return { ...bucket, extractionChanges };
}

function cloneQueue(queue: ObserveQueue): ObserveQueue {
  return {
    anchors: queue.anchors.map((bucket) => ({
      ...bucket,
      extractionChanges: [...bucket.extractionChanges],
    })),
  };
}

function entityAnchors(extraction: { anchors: string[] }): string[] {
  return extraction.anchors
    .map((anchor) => anchor.match(/^Entity:\s*(.+?)\s*$/i)?.[1]?.trim() ?? '')
    .filter(Boolean);
}

export function normalizeAnchor(anchor: string): string {
  return anchor.trim().toLowerCase().replace(/\s+/g, ' ');
}
```

- [ ] **Step 3: Run queue tests**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/core build && node --test packages/core/test/observer-runner.test.mjs
```

Expected: PASS for queue helper tests.

## Task 3: Extraction Commit Returns Queued Changes

**Files:**
- Modify: `packages/core/src/extractor/memory-delta.ts`
- Modify: `packages/core/src/extractor/update.ts`
- Test: `packages/core/test/client-internals.test.mjs`

- [ ] **Step 1: Add failing test for committed extraction changes**

Add a test around `buildTouchedIndex` or `applyExtractionTableChanges` that verifies add/update/delete changes return full queued changes. Use an in-memory fake table:

```js
test('applyExtractionTableChanges returns queued upsert and delete extraction changes', async () => {
  const { applyExtractionTableChanges } = await import('../dist/extractor/memory-delta.js');
  const upserts = [];
  const deletes = [];
  const existing = new Map([
    ['old-1', extractionRow('old-1', ['Entity: Caroline'], 'old text')],
  ]);
  const client = {
    extractionTable: {
      loadByIds: async ({ ids }) => ids.map((id) => existing.get(id)).filter(Boolean),
      delete: async ({ ids }) => { deletes.push(...ids); return ids.length; },
      upsert: async ({ rows }) => { upserts.push(...rows); for (const row of rows) existing.set(row.id, row); },
    }
  };
  const result = await applyExtractionTableChanges(client, {
    title: 'Session',
    summary: '',
    snapshotContent: '',
    extractions: [
      { id: 'old-1', text: 'new text', context: null, anchors: ['Entity: Caroline'], category: 'Fact', references: ['turn:1'] }
    ],
    extractionChanges: [
      { type: 'update', extractionId: 'old-1', text: 'new text', context: null, anchors: ['Entity: Caroline'], category: 'Fact', references: ['turn:1'], reason: 'updated' },
    ],
    contextRefs: [],
  }, 'session:1');
  assert.equal(result.length, 1);
  assert.equal(result[0].type, 'upsert');
  assert.equal(result[0].extraction.id, 'old-1');
});
```

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/core build && node --test packages/core/test/client-internals.test.mjs
```

Expected: FAIL because `applyExtractionTableChanges()` returns `void`.

- [ ] **Step 2: Return queued changes from table apply**

Change signature:

```ts
export async function applyExtractionTableChanges(...): Promise<QueuedExtractionChange[]>
```

Implementation:

- Build `rows` as today.
- Push `{ type: 'upsert', extraction: row }` for every row upserted.
- For every deleted existing row, push `{ type: 'delete', extraction: existingRow }`.
- Return `[]` when no changes.

Use exact return logic:

```ts
const queued: QueuedExtractionChange[] = [];
for (const deletedId of deletedIds) {
  const existing = existingById.get(deletedId);
  if (existing) {
    queued.push({ type: 'delete', extraction: existing });
  }
}
...
if (rows.length > 0) {
  await client.extractionTable.upsert({ rows });
  queued.push(...rows.map((row) => ({ type: 'upsert' as const, extraction: row })));
}
return queued;
```

- [ ] **Step 3: Propagate from indexing**

Update `catchUpIndex()`, `buildExtraction()`, and `buildTouchedIndex()` in `packages/core/src/extractor/update.ts` to return `QueuedExtractionChange[]`.

Expected shape:

```ts
async function catchUpIndex(...): Promise<QueuedExtractionChange[]> {
  const queued: QueuedExtractionChange[] = [];
  ...
  queued.push(...await applyExtractionTableChanges(...));
  ...
  return queued;
}
```

Update exported functions:

```ts
export async function buildExtraction(...): Promise<QueuedExtractionChange[]>
export async function buildTouchedIndex(...): Promise<QueuedExtractionChange[]>
```

- [ ] **Step 4: Run extraction tests**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/core build && node --test packages/core/test/client-internals.test.mjs
```

Expected: PASS.

## Task 4: Extractor Pending Changes And Handoff Hook

**Files:**
- Modify: `packages/core/src/extractor/extractor.ts`
- Modify: `packages/core/src/backend.ts`
- Modify: `packages/core/src/watchdog.ts`
- Test: `packages/core/test/client-internals.test.mjs`

- [ ] **Step 1: Add failing test for pending handoff**

Add a test that uses a fake observer enqueue callback:

```js
test('extractor records pending extraction changes and hands them off after commit', async () => {
  const { __testing } = await import('../dist/extractor/extractor.js');
  const handedOff = [];
  const extractor = createExtractorForTest({
    onExtractionCommitted: (changes) => handedOff.push(...changes),
  });
  __testing.mergePendingExtractionChangesForTests(extractor, [
    { type: 'upsert', extraction: extractionRow('ex-1', ['Entity: Caroline'], 'text') }
  ]);
  __testing.handoffPendingExtractionChangesForTests(extractor);
  assert.equal(handedOff.length, 1);
  assert.deepEqual(extractor.exportCheckpoint().pendingExtractionChanges, []);
});
```

Add a test-only helper export from `packages/core/src/extractor/extractor.ts`:

```ts
export const __testing = {
  mergePendingExtractionChangesForTests(extractor: Extractor, changes: QueuedExtractionChange[]) {
    extractor.mergePendingExtractionChanges(changes);
  },
  async handoffPendingExtractionChangesForTests(extractor: Extractor) {
    extractor.handoffPendingExtractionChanges();
  },
};
```

Keep both production methods private except for this `__testing` wrapper.

- [ ] **Step 2: Add extractor state**

In `Extractor`:

```ts
private pendingExtractionChanges: QueuedExtractionChange[] = [];
```

Initialize from checkpoint:

```ts
this.pendingExtractionChanges = checkpoint?.pendingExtractionChanges ?? [];
```

Change callback type:

```ts
private readonly onExtractionCommitted: ((changes: QueuedExtractionChange[]) => void) | null;
```

Export checkpoint:

```ts
pendingExtractionChanges: this.pendingExtractionChanges.map(cloneQueuedExtractionChange)
```

Add merge helper:

```ts
private mergePendingExtractionChanges(changes: QueuedExtractionChange[]): void {
  for (const change of changes) {
    const index = this.pendingExtractionChanges.findIndex((pending) => pending.extraction.id === change.extraction.id);
    if (index < 0) {
      this.pendingExtractionChanges.push(change);
    } else {
      this.pendingExtractionChanges[index] = change;
    }
  }
}
```

- [ ] **Step 3: Handoff after successful indexing**

In `observeCurrentEpoch()`:

```ts
const extractionChanges = await this.buildCurrentEpochIndex(result.touchedIds);
this.mergePendingExtractionChanges(extractionChanges);
if (this.pendingExtractionChanges.length > 0) {
  this.handoffPendingExtractionChanges();
}
```

In `retryExtraction()`:

```ts
const extractionChanges = await buildExtraction(...);
this.mergePendingExtractionChanges(extractionChanges);
if (this.pendingExtractionChanges.length > 0) {
  this.handoffPendingExtractionChanges();
}
```

Add:

```ts
private handoffPendingExtractionChanges(): void {
  if (this.pendingExtractionChanges.length === 0) {
    return;
  }
  const changes = this.pendingExtractionChanges.map(cloneQueuedExtractionChange);
  this.onExtractionCommitted?.(changes);
  this.pendingExtractionChanges = [];
}
```

Do not call the callback if build/index fails.

- [ ] **Step 4: Run extractor tests**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/core build && node --test packages/core/test/client-internals.test.mjs
```

Expected: PASS.

## Task 5: Observer Queue Runtime

**Files:**
- Modify: `packages/core/src/observer/observer.ts`
- Modify: `packages/core/src/observer/runner.ts`
- Test: `packages/core/test/observer-runner.test.mjs`

- [ ] **Step 1: Add failing observer queue tests**

Add tests:

```js
test('observer watermark reports below-threshold queue as resolved', async () => {
  const observer = createObserverForTest({
    queue: {
      anchors: [
        {
          key: 'caroline',
          anchor: 'Caroline',
          extractionChanges: [
            { type: 'upsert', extraction: extractionRow('ex-1', ['Entity: Caroline'], 'text') }
          ]
        }
      ]
    },
    anchorThreshold: 8,
  });
  const watermark = await observer.watermark();
  assert.equal(watermark.resolved, true);
  assert.equal(watermark.observerQueuedCount, 1);
  assert.equal(watermark.observerReadyCount, 0);
});

test('observer finalize drains below-threshold queue', async () => {
  const observed = [];
  const observer = createObserverForTest({
    queue: {
      anchors: [
        {
          key: 'caroline',
          anchor: 'Caroline',
          extractionChanges: [
            { type: 'upsert', extraction: extractionRow('ex-1', ['Entity: Caroline'], 'text') }
          ]
        }
      ]
    },
    observeAnchorImpl: async (input) => {
      observed.push(input.entityAnchor);
      return parsedDocument('Caroline');
    }
  });
  const watermark = await observer.finalize();
  assert.equal(watermark.resolved, true);
  assert.deepEqual(observed, ['Caroline']);
  assert.deepEqual(observer.exportCheckpoint().observeQueue.anchors, []);
});
```

Add `createObserverForTest`, `parsedDocument`, and `extractionRow` helpers inside `packages/core/test/observer-runner.test.mjs`; keep them local to the test file.

- [ ] **Step 2: Refactor `runObserver` to accept a batch**

Change runner API from delta scan:

```ts
runObserver({ client, observerName, baselineVersion, ... })
```

to queued batch:

```ts
runObserver({
  client,
  observerName,
  anchor,
  extractionChanges,
  signal,
  observeAnchorImpl,
})
```

Inside runner:

- Build `upsertExtractions = extractionChanges.filter(type === 'upsert').map(extraction)`.
- Build `deletedExtractions = extractionChanges.filter(type === 'delete').map(extraction)`.
- Load all contexts once for `observerName`.
- Use `contextsForAnchor(allContexts, anchor)`.
- `currentObservationRefs` should remove changed extraction refs using all changed extraction ids.
- Render prompt input with upsert extractions as normal.
- Render removed extractions as a natural-language Markdown section, not JSON:

```md
## New or updated extractions
### <extraction id>
[Context] <context text>
[Extraction] <extraction text>

## Removed extractions
Removed extractions are previously captured content that should no longer support this observation document.

### <extraction id>
[Context] <context text>
[Extraction] <extraction text>
```

Extend `observeAnchor` input to include:

```ts
removedExtractions?: ObserverExtractionInput[];
```

The prompt rendering should remain Markdown/natural language, not raw JSON.

- [ ] **Step 3: Add observer queue state**

In `Observer`:

```ts
private observeQueue: ObserveQueue;
```

Initialize:

```ts
this.observeQueue = checkpoint?.observeQueue ?? { anchors: [] };
```

Add:

```ts
enqueue(changes: QueuedExtractionChange[]): void {
  this.observeQueue = enqueueChanges(this.observeQueue, changes);
  this.wake();
}
```

Update `exportCheckpoint()`:

```ts
return {
  baseline: { ...this.baseline },
  observeQueue: cloneObserveQueue(this.observeQueue),
  runs: [],
};
```

Remove `baseline.extraction` usage.

- [ ] **Step 4: Implement observer drain**

Replace `getObserverWorkStatus()` based polling with queue stats:

```ts
async watermark(): Promise<MemoryWatermark> {
  const stats = queueStats(this.observeQueue, this.anchorThreshold);
  return {
    resolved: !this.running && stats.readyCount === 0,
    pendingTurnIds: [],
    observerPending: this.running || stats.readyCount > 0,
    observerQueuedCount: stats.queuedCount,
    observerReadyCount: stats.readyCount,
    observerReadyBucketCount: stats.readyBucketCount,
  };
}
```

Update `run()`:

- If no ready bucket, wait for change.
- If ready bucket, call `runOnce(false)`.

Update `finalize()`:

- Loop until queue empty and not running.
- Call `runOnce(true)` for below-threshold buckets.
- Throw internal errors instead of swallowing indefinitely.

Implement `runOnce(finalize)`:

```ts
const batch = readyBucket(this.observeQueue, {
  threshold: this.anchorThreshold,
  batchSize: this.anchorBatchSize,
  finalize,
});
if (!batch) return;
await runObserver({ client: this.client, observerName: this.name, anchor: batch.anchor, extractionChanges: batch.extractionChanges, signal: ... });
this.observeQueue = ackBucket(this.observeQueue, batch.key, batch.extractionChanges.map((change) => change.extraction.id));
```

- [ ] **Step 5: Run observer tests**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/core build && node --test packages/core/test/observer-runner.test.mjs packages/core/test/client-internals.test.mjs
```

Expected: PASS.

## Task 6: Observation Link Diff

**Files:**
- Modify: `packages/core/src/observer/runner.ts`
- Test: `packages/core/test/observer-runner.test.mjs`

- [ ] **Step 1: Add failing tests for no-op link updates**

Add:

```js
test('observer does not upsert extraction when observationIds are unchanged', async () => {
  const upserts = [];
  const extraction = extractionRow('ex-1', ['Entity: Caroline'], 'text');
  extraction.observationIds = ['obs-1'];
  await updateExtractionLinksForTests({
    client: { extractionTable: { upsert: async ({ rows }) => upserts.push(...rows) } },
    extractions: [extraction],
    nodes: [leafNode('obs-1', ['ex-1'])],
    now: '2026-05-17T00:00:00.000Z',
  });
  assert.equal(upserts.length, 0);
});
```

If `updateExtractionLinks` is not exported for tests, export it through `__testing`.

- [ ] **Step 2: Compare sets before upsert**

Update `updateExtractionLinks()`:

```ts
const nextObservationIds = unique([
  ...extraction.observationIds.filter((id) => !nodes.some((node) => node.id === id)),
  ...(leafByRef.get(extraction.id) ?? []),
]);
if (sameStringSet(extraction.observationIds, nextObservationIds)) {
  return null;
}
return {
  ...extraction,
  observationIds: nextObservationIds,
  updatedAt: now,
};
```

Only upsert non-null rows.

- [ ] **Step 3: Run link tests**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/core build && node --test packages/core/test/observer-runner.test.mjs
```

Expected: PASS.

## Task 7: Backend Finalize API

**Files:**
- Modify: `packages/core/src/backend.ts`
- Modify: `packages/types/src/api.ts`
- Modify: `packages/sidecar/src/memory_loader.ts`
- Test: `packages/core/test/client.test.mjs`
- Test: `packages/sidecar/test/session_flow.test.mjs`

- [ ] **Step 1: Add failing backend tests**

Add core test:

```js
test('memoryWatermark does not finalize observer queue', async () => {
  const backend = await createBackendWithQueuedObserverForTest();
  const watermark = await backend.memoryWatermark();
  assert.equal(watermark.resolved, true);
  assert.equal(watermark.observerQueuedCount, 1);
  assert.equal(backend.__observerFinalizeCallsForTests(), 0);
});

test('memoryFinalize drains extractor and observer queue', async () => {
  const backend = await createBackendWithQueuedObserverForTest();
  const watermark = await backend.memoryFinalize();
  assert.equal(watermark.resolved, true);
  assert.equal(watermark.observerQueuedCount, 0);
});
```

Add sidecar test:

```js
test('POST /api/v1/memory/finalize returns memory watermark response', async () => {
  const response = await app.request('/api/v1/memory/finalize', { method: 'POST' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(typeof body.resolved, 'boolean');
  assert.equal(typeof body.requestId, 'string');
});
```

- [ ] **Step 2: Implement backend finalize split**

In `MuninnBackend.memoryWatermark()`:

- Remove implicit `observer.finalize()`.
- Call `observer.watermark()` only.

Add:

```ts
async memoryFinalize(): Promise<MemoryWatermark> {
  return this.checkpointLock.shared(async () => {
    const observer = await this.ensureObserver();
    const extractor = await this.ensureExtractor();
    await extractor.flushPending();
    const observerWatermark = await observer.finalize();
    await this.watchdog?.flushCheckpoint();
    return {
      resolved: observerWatermark.resolved,
      pendingTurnIds: [],
      observerPending: !observerWatermark.resolved,
      observerQueuedCount: observerWatermark.observerQueuedCount,
      observerReadyCount: observerWatermark.observerReadyCount,
      observerReadyBucketCount: observerWatermark.observerReadyBucketCount,
    };
  });
}
```

In `packages/core/src/watchdog.ts`, change `private async flushCheckpoint()` to `async flushCheckpoint()` so backend finalize can force checkpoint persistence through the existing watchdog checkpoint writer.

Export:

```ts
export const observer = {
  async watermark() { ... },
  async finalize() { return (await getBackend()).memoryFinalize(); },
};
```

- [ ] **Step 3: Extend response type**

In `packages/types/src/api.ts` add optional fields:

```ts
observerQueuedCount?: number;
observerReadyCount?: number;
observerReadyBucketCount?: number;
```

In sidecar response helper, pass them through.

- [ ] **Step 4: Add sidecar endpoint**

In `packages/sidecar/src/memory_loader.ts`:

```ts
memoryLoader.post('/api/v1/memory/finalize', async (c) => {
  let watermark;
  try {
    watermark = await observer.finalize();
  } catch (error) {
    const mapped = mapCoreLookupError(error);
    return c.json(mapped.body, mapped.status as 400 | 500);
  }
  return c.json(memoryWatermarkResponse(...));
});
```

- [ ] **Step 5: Run API tests**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/core build && node --test packages/core/test/client.test.mjs packages/sidecar/test/session_flow.test.mjs
```

Expected: PASS.

## Task 8: LoCoMo Bridge Uses Finalize

**Files:**
- Modify: `benchmark/locomo/src/bridge.ts`
- Test: `benchmark/locomo/test/bridge.test.mjs`

- [ ] **Step 1: Add failing bridge test**

Add:

```js
test('waitForImportWatermark calls memory finalize endpoint', async (t) => {
  const calls = [];
  mockSidecarRequest(async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    if (url.endsWith('/api/v1/memory/finalize')) {
      return jsonResponse({ resolved: true, pendingTurnIds: [] });
    }
    return jsonResponse({ resolved: true, pendingTurnIds: [] });
  });
  await bridgeModule.waitForImportWatermark({ turns: [{ turn_id: 'D1:1' }] }, { pollMs: 1, timeoutMs: 50 });
  assert.ok(calls.some((call) => call.url.endsWith('/api/v1/memory/finalize') && call.method === 'POST'));
});
```

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/benchmark-locomo build && node --test benchmark/locomo/test/bridge.test.mjs
```

Expected: FAIL because bridge only calls watermark.

- [ ] **Step 2: Implement finalize call**

Change `waitForImportWatermark()` to poll status for progress but use finalize as the barrier:

```ts
const finalized = await fetchMemoryFinalize();
if (finalized.resolved) return;
```

Implement:

```ts
async function fetchMemoryFinalize() {
  const { app: sidecarApp } = await import(pathToFileURL(SIDECAR_APP_PATH).href);
  const response = await sidecarApp.request('http://sidecar.local/api/v1/memory/finalize', { method: 'POST' });
  return parseWatermarkResponse(response);
}
```

Keep `fetchMemoryWatermark()` for warning/progress only.

- [ ] **Step 3: Run bridge tests**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/benchmark-locomo build && node --test benchmark/locomo/test/bridge.test.mjs
```

Expected: PASS.

## Task 9: Runner Fatal Diagnostics

**Files:**
- Modify: `benchmark/locomo/scripts/run_muninn_eval.py`
- Test: `benchmark/locomo/tests/test_run_muninn_eval.py`

- [ ] **Step 1: Add failing diagnostic tests**

Add Python tests:

```python
def test_classify_internal_muninn_fatal():
    self.assertEqual(classify_failure("", "[muninn:observer] observer run failed: Error: bad"), "muninn_internal")
    self.assertEqual(classify_failure("", "Ambiguous merge inserts are prohibited"), "muninn_internal")
    self.assertEqual(classify_failure("", "RowAddrTreeMap::from_sorted_iter called with non-sorted input"), "muninn_internal")

def test_classify_transient_external_not_fatal():
    self.assertEqual(classify_failure("", "fetch failed"), "transient_external")
    self.assertEqual(classify_failure("", "ECONNRESET"), "transient_external")

def test_write_diagnostic_file(tmp_path):
    path = write_diagnostic(
        out_dir=tmp_path,
        run_name="demo",
        category="lance-index",
        fatal_pattern="RowAddrTreeMap::from_sorted_iter",
        stdout_tail=["out"],
        stderr_tail=["err"],
        progress_tail=[],
        run_home="run-home",
    )
    data = json.loads(path.read_text())
    self.assertEqual(data["category"], "lance-index")
    self.assertEqual(data["fatalPattern"], "RowAddrTreeMap::from_sorted_iter")
```

Run:

```bash
source ~/.zprofile && python3 -m unittest benchmark.locomo.tests.test_run_muninn_eval
```

Expected: FAIL because helper does not exist or classification differs.

- [ ] **Step 2: Implement fatal classification**

In `run_muninn_eval.py`:

```python
INTERNAL_FATAL_PATTERNS = [
    ("observer", "observer run failed"),
    ("extractor", "extractor run failed"),
    ("lance-merge-upsert", "Ambiguous merge inserts"),
    ("lance-index", "RowAddrTreeMap::from_sorted_iter"),
    ("lance-index", "index build failed"),
    ("unknown", "schema"),
    ("unknown", "validator"),
    ("unknown", "parser"),
]

TRANSIENT_EXTERNAL_PATTERNS = [
    "fetch failed",
    "ECONNRESET",
    "ETIMEDOUT",
    "rate limit",
    "429",
]
```

`classify_failure()` returns:

- `muninn_internal` for internal patterns.
- `transient_external` for transient patterns.
- existing categories for no-progress/watermark.

- [ ] **Step 3: Implement diagnostic JSON**

Add:

```python
def write_diagnostic(...):
    payload = {
        "writtenAt": datetime.now(timezone.utc).isoformat(),
        "category": category,
        "fatalPattern": fatal_pattern,
        "stdoutTail": stdout_tail[-80:],
        "stderrTail": stderr_tail[-80:],
        "progressTail": progress_tail[-80:],
        "watchdogTail": read_jsonl_tail(Path(run_home) / "watchdog.jsonl", 80),
        "observerTraceTail": read_jsonl_tail(Path(run_home) / "locomo-observer-trace.jsonl", 20),
        "extractorTraceTail": read_jsonl_tail(Path(run_home) / "locomo-thread-observing-trace.jsonl", 20),
        "checkpoint": read_checkpoint_snapshot(Path(run_home) / "checkpoints"),
        "runHome": str(run_home),
    }
    path = Path(out_dir) / f"{run_name}.diagnostic.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\\n")
    return path
```

During child stream monitoring, if an internal fatal line appears, terminate the child and raise a benchmark failure after writing diagnostics.

Do not terminate immediately on transient external patterns.

- [ ] **Step 4: Run runner tests**

Run:

```bash
source ~/.zprofile && python3 -m unittest benchmark.locomo.tests.test_run_muninn_eval
```

Expected: PASS.

## Task 10: End-To-End Verification

**Files:**
- No new implementation files.
- Run targeted tests and small benchmark.

- [ ] **Step 1: Run core build**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/core build
```

Expected: PASS.

- [ ] **Step 2: Run targeted node tests**

Run:

```bash
source ~/.zprofile && node --test packages/core/test/client-internals.test.mjs packages/core/test/observer-runner.test.mjs packages/core/test/client.test.mjs packages/sidecar/test/session_flow.test.mjs benchmark/locomo/test/bridge.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Run Python benchmark runner tests**

Run:

```bash
source ~/.zprofile && python3 -m unittest benchmark.locomo.tests.test_run_muninn_eval
```

Expected: PASS.

- [ ] **Step 4: Run three-small sanity**

Run:

```bash
source ~/.zprofile && python3 benchmark/locomo/scripts/run_muninn_eval.py \
  --target three-small \
  --top-k 8 \
  --budget 0 \
  --query-limit 8 \
  --recall-mode hybrid \
  --watermark-timeout-ms 7200000 \
  --run-name three-small-queue-sanity
```

Expected:

- Import completes.
- `POST /api/v1/memory/finalize` is used before QA.
- QA starts.
- No observer self-trigger loop.
- No repeated link-only extraction churn.
- Summary JSON is written.
- If Muninn internal fatal occurs, diagnostic JSON is written and the run stops.

- [ ] **Step 5: Inspect diagnostic absence or summary**

If success:

```bash
ls benchmark/locomo/out/three-small-queue-sanity.summary.json
```

Expected: file exists.

If failure:

```bash
ls benchmark/locomo/out/three-small-queue-sanity.diagnostic.json
```

Expected: diagnostic file exists with actionable category.

## Self-Review Checklist

- Spec coverage:
  - Explicit queue handoff covered by Tasks 1-5.
  - No extraction delta scanning covered by Task 5.
  - Watermark/finalize split covered by Tasks 7-8.
  - Observation link no-op avoidance covered by Task 6.
  - Runner fatal diagnostics covered by Task 9.
  - BTree kept unchanged, covered as diagnostic only.
- No placeholders:
  - Every task has exact files, commands, expected results, and code shapes.
- Type consistency:
  - `QueuedExtractionChange`, `pendingExtractionChanges`, and `observeQueue.anchors[].extractionChanges` are used consistently.
