# Batch Epoch Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Subagent-driven execution is intentionally not used for this side conversation.

**Goal:** Make batch capture respect extractor epoch boundaries so large imports progress in bounded epochs, while ordinary hook capture stops forcing tiny epochs.

**Architecture:** Keep the public capture schema unchanged. Refactor `Extractor.acceptBatch()` to pack incoming `TurnContent[]` into bounded groups before writing each group to `OpenEpoch`, using `maxEpochTurns` and `newBatchInputChars`. Remove automatic `*-hook` finalize from backend capture, and make remember-session marker handling explicitly call the existing finalize endpoint after successful capture.

**Tech Stack:** TypeScript packages built by `pnpm`, Node test runner tests in `.mjs`, existing Muninn server/common packages.

---

## File Structure

- `server/src/pipeline/extractor.ts`
  - Owns batch packing at the extractor boundary.
  - Imports existing current-batch rendering helpers so packing and extraction budgets match.
- `server/src/backend.ts`
  - Removes hook-name-based automatic finalize from generic capture writes.
- `common/src/agent-hook.ts`
  - Adds an optional `finalizeMemory()` client method.
  - Calls finalize after successful remember-session enable marker capture.
- `server/test/memory/client-internals.test.mjs`
  - Adds extractor batch packing tests beside existing `Extractor.accept` epoch tests.
  - Extends `writeExtractorConfig()` test helper with `newBatchInputChars` and `previewChars`.
- `common/test/agent-hook.test.mjs`
  - Adds remember marker finalize success/failure tests.

Do not modify `/api/v1/turn/capture/batch` request or response types.

---

### Task 1: Add Failing Extractor Batch Packing Tests

**Files:**
- Modify: `server/test/memory/client-internals.test.mjs`

- [ ] **Step 1: Extend the extractor config test helper**

In `server/test/memory/client-internals.test.mjs`, update `writeExtractorConfig()` so tests can set the text-budget knobs. Replace the helper signature and extractor object construction with this shape:

```js
async function writeExtractorConfig(configPath, {
  activeWindowDays = 3650,
  maxAttempts = 3,
  minEpochTurns,
  maxEpochTurns,
  newBatchInputChars,
  snapshotInputChars,
  previewChars,
  epochWindowMs,
  failedEpochRetryIntervalMs,
  name = 'default-extractor',
} = {}) {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({
    extractor: {
      name,
      llmProvider: 'extractor_llm',
      embeddingProvider: 'default',
      maxAttempts,
      activeWindowDays,
      ...(minEpochTurns === undefined ? {} : { minEpochTurns }),
      ...(maxEpochTurns === undefined ? {} : { maxEpochTurns }),
      ...(newBatchInputChars === undefined ? {} : { newBatchInputChars }),
      ...(snapshotInputChars === undefined ? {} : { snapshotInputChars }),
      ...(previewChars === undefined ? {} : { previewChars }),
      ...(epochWindowMs === undefined ? {} : { epochWindowMs }),
      ...(failedEpochRetryIntervalMs === undefined ? {} : { failedEpochRetryIntervalMs }),
    },
    providers: {
      llm: {
        extractor_llm: {
          type: 'mock',
        },
      },
      embedding: {
        default: {
          type: 'mock',
          dimensions: 8,
        },
      },
    },
  }, null, 2)}\n`, 'utf8');
}
```

- [ ] **Step 2: Add a registry helper for batch packing tests**

Near `makeTurnContent()` or near the new tests, add this helper:

```js
function makeBatchRegistry() {
  let acceptCount = 0;
  return {
    load: async () => ({
      acceptBatch: async (contents, epoch) => contents.map((content) => {
        acceptCount += 1;
        return {
          turn: makeExtractableTurn(`turn-${acceptCount}`, epoch, content.response),
          deduped: false,
        };
      }),
    }),
  };
}
```

- [ ] **Step 3: Add maxEpochTurns packing test**

Add this test after `extractor.accept keeps a partial epoch open until minEpochTurns is reached`:

```js
test('extractor.acceptBatch packs large batches by maxEpochTurns and leaves tail open', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath, {
    minEpochTurns: 3,
    maxEpochTurns: 4,
    epochWindowMs: 10_000,
  });

  const extractor = new Extractor(makeExtractorClient());
  extractor.bootstrapped = true;
  extractor.openEpoch = new OpenEpoch(1);
  t.after(async () => extractor.shutdown());

  const turns = Array.from({ length: 10 }, (_, index) => (
    makeTurnContent(`prompt ${index + 1}`, `response ${index + 1}`)
  ));

  const accepted = await extractor.acceptBatch(turns, makeBatchRegistry());
  await extractor.publishChain;

  assert.equal(accepted, 10);
  assert.equal(extractor.openEpoch.epoch, 3);
  assert.deepEqual(extractor.epochQueue.pendingTurns().map((turn) => turn.turnId), [
    'turn-1',
    'turn-2',
    'turn-3',
    'turn-4',
    'turn-5',
    'turn-6',
    'turn-7',
    'turn-8',
  ]);
  assert.deepEqual(extractor.openEpoch.stagedTurns().map((turn) => turn.turnId), [
    'turn-9',
    'turn-10',
  ]);
});
```

- [ ] **Step 4: Add newBatchInputChars packing test**

Add this test below the maxEpochTurns test:

```js
test('extractor.acceptBatch packs large batches by rendered newBatchInputChars', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeExtractorConfig(configPath, {
    minEpochTurns: 3,
    maxEpochTurns: 32,
    newBatchInputChars: 900,
    previewChars: 800,
    epochWindowMs: 10_000,
  });

  const extractor = new Extractor(makeExtractorClient());
  extractor.bootstrapped = true;
  extractor.openEpoch = new OpenEpoch(1);
  t.after(async () => extractor.shutdown());

  const turns = Array.from({ length: 4 }, (_, index) => (
    makeTurnContent(`prompt ${index + 1}`, 'x'.repeat(180))
  ));

  const accepted = await extractor.acceptBatch(turns, makeBatchRegistry());
  await extractor.publishChain;

  assert.equal(accepted, 4);
  assert.equal(extractor.openEpoch.epoch, 2);
  assert.deepEqual(extractor.epochQueue.pendingTurns().map((turn) => turn.turnId), [
    'turn-1',
    'turn-2',
  ]);
  assert.deepEqual(extractor.openEpoch.stagedTurns().map((turn) => turn.turnId), [
    'turn-3',
    'turn-4',
  ]);
});
```

- [ ] **Step 5: Run failing tests**

Run:

```bash
pnpm --filter @muninn/server build
pnpm --filter @muninn/server test -- --test-name-pattern "extractor.acceptBatch packs"
```

Expected before implementation: the new tests fail because `acceptBatch()` puts all turns into one open epoch.

---

### Task 2: Implement Batch Epoch Packing

**Files:**
- Modify: `server/src/pipeline/extractor.ts`

- [ ] **Step 1: Import the existing budget renderer**

At the top of `server/src/pipeline/extractor.ts`, add:

```ts
import { renderCurrentBatchTurns } from '../llm/extraction-input.js';
```

- [ ] **Step 2: Add batch packing helper types and functions**

Add these helpers near the bottom of `server/src/pipeline/extractor.ts`, above `keepNewestTurn()` or another local helper section:

```ts
type PendingBudgetTurn = {
  turn: TurnContent;
  turnId: string;
  prompt: string;
  response: string;
};

type BatchPackingBudget = {
  maxEpochTurns: number;
  newBatchInputChars: number;
  previewChars: number;
};

function packNextBatchGroup(
  existingTurns: TurnRow[],
  pendingTurns: TurnContent[],
  budget: BatchPackingBudget,
  startIndex: number,
): { turns: TurnContent[]; shouldSealBefore: boolean } {
  if (pendingTurns.length === 0) {
    return { turns: [], shouldSealBefore: false };
  }

  const existingBudgetTurns = existingTurns.map((turn) => ({
    turnId: turn.turnId,
    prompt: turn.prompt ?? '',
    response: turn.response ?? '',
  }));

  if (existingBudgetTurns.length >= budget.maxEpochTurns) {
    return { turns: [], shouldSealBefore: existingBudgetTurns.length > 0 };
  }

  const selected: PendingBudgetTurn[] = [];
  for (let index = 0; index < pendingTurns.length; index += 1) {
    const turn = pendingTurns[index]!;
    const candidate: PendingBudgetTurn = {
      turn,
      turnId: `pending:${startIndex + index + 1}`,
      prompt: turn.prompt,
      response: turn.response,
    };
    const nextSelected = [...selected, candidate];
    const rendered = renderCurrentBatchTurns([
      ...existingBudgetTurns,
      ...nextSelected.map(({ turnId, prompt, response }) => ({ turnId, prompt, response })),
    ], { previewChars: budget.previewChars });
    const exceedsTurnLimit = existingBudgetTurns.length + nextSelected.length > budget.maxEpochTurns;
    const exceedsTextBudget = rendered.renderedChars > budget.newBatchInputChars;
    if ((exceedsTurnLimit || exceedsTextBudget) && selected.length > 0) {
      break;
    }
    if ((exceedsTurnLimit || exceedsTextBudget) && existingBudgetTurns.length > 0) {
      return { turns: [], shouldSealBefore: true };
    }
    selected.push(candidate);
    if (exceedsTurnLimit || exceedsTextBudget) {
      break;
    }
  }

  return {
    turns: selected.map((candidate) => candidate.turn),
    shouldSealBefore: false,
  };
}
```

This helper is intentionally conservative. It uses pre-write pending labels for budget calculation and keeps extraction-stage chunking as the exact row-based safety net.

- [ ] **Step 3: Refactor `Extractor.acceptBatch()`**

Replace the current single-call body after bootstrap checks:

```ts
while (true) {
  const openEpoch = this.openEpoch;
  try {
    const acceptedTurns = await openEpoch.acceptBatch(turnContents, sessionRegistry);
    this.scheduleOpenEpochSeal(openEpoch);
    return acceptedTurns.length;
  } catch (error) {
    if (error instanceof EpochSealedError && openEpoch !== this.openEpoch) {
      continue;
    }
    throw error;
  }
}
```

with:

```ts
let acceptedCount = 0;
let offset = 0;
while (offset < turnContents.length) {
  const openEpoch = this.openEpoch;
  const packed = packNextBatchGroup(
    openEpoch.stagedTurns(),
    turnContents.slice(offset),
    {
      maxEpochTurns: this.maxEpochTurns,
      newBatchInputChars: this.newBatchInputChars,
      previewChars: this.previewChars,
    },
    offset,
  );

  if (packed.shouldSealBefore) {
    this.sealOpenEpoch(openEpoch);
    continue;
  }

  if (packed.turns.length === 0) {
    break;
  }

  try {
    const acceptedTurns = await openEpoch.acceptBatch(packed.turns, sessionRegistry);
    acceptedCount += acceptedTurns.length;
    offset += packed.turns.length;
    if (offset < turnContents.length && openEpoch.hasStagedTurns()) {
      this.sealOpenEpoch(openEpoch);
    }
  } catch (error) {
    if (error instanceof EpochSealedError && openEpoch !== this.openEpoch) {
      continue;
    }
    throw error;
  }
}

this.scheduleOpenEpochSeal(this.openEpoch);
return acceptedCount;
```

- [ ] **Step 4: Run targeted tests**

Run:

```bash
pnpm --filter @muninn/server build
pnpm --filter @muninn/server test -- --test-name-pattern "extractor.acceptBatch packs"
```

Expected: both new tests pass.

- [ ] **Step 5: Commit server packing change**

```bash
git add server/src/pipeline/extractor.ts server/test/memory/client-internals.test.mjs
git commit -m "fix: bound batch capture epochs"
```

---

### Task 3: Remove Generic Hook Auto-Finalize

**Files:**
- Modify: `server/src/backend.ts`

- [ ] **Step 1: Remove automatic finalize from generic capture writes**

In `server/src/backend.ts`, change `captureTurn()` from:

```ts
const backend = await getBackend(databaseName);
await backend.accept(turnContent);
if (isHookCapture(turnContent)) {
  await backend.memoryFinalize();
}
```

to:

```ts
const backend = await getBackend(databaseName);
await backend.accept(turnContent);
```

Change `captureTurns()` from:

```ts
const backend = await getBackend(databaseName);
const capturedTurns = await backend.acceptBatch(turnContents);
if (turnContents.some(isHookCapture)) {
  await backend.memoryFinalize();
}
return capturedTurns;
```

to:

```ts
const backend = await getBackend(databaseName);
return backend.acceptBatch(turnContents);
```

Delete the now-unused `isHookCapture()` helper:

```ts
function isHookCapture(turnContent: TurnContent): boolean {
  return typeof turnContent.metadata?.ingest === 'string'
    && turnContent.metadata.ingest.endsWith('-hook');
}
```

- [ ] **Step 2: Run server build**

Run:

```bash
pnpm --filter @muninn/server build
```

Expected: PASS, with no unused helper/type errors.

- [ ] **Step 3: Commit backend finalize removal**

```bash
git add server/src/backend.ts
git commit -m "fix: stop auto-finalizing hook capture"
```

---

### Task 4: Finalize Explicitly After Remember Marker Capture

**Files:**
- Modify: `common/src/agent-hook.ts`
- Modify: `common/test/agent-hook.test.mjs`

- [ ] **Step 1: Add `finalizeMemory()` to the client type and HTTP client**

In `common/src/agent-hook.ts`, change `MuninnClient` to:

```ts
export type MuninnClient = {
  captureTurn(request: CaptureTurnRequest): Promise<boolean>;
  captureTurns?(turns: TurnContent[]): Promise<boolean>;
  deleteSession?(identity: MuninnSessionIdentity): Promise<boolean>;
  finalizeMemory?(): Promise<boolean>;
};
```

In `createMuninnClient()`, add this method next to `captureTurns()` and `deleteSession()`:

```ts
async finalizeMemory() {
  try {
    const response = await fetchImpl(`${params.config.baseUrl}/api/v1/memory/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(params.config.timeoutMs),
    });
    if (!response.ok) {
      const body = await safeReadBody(response);
      logWarn(label, `muninn memory finalize failed with status ${response.status}${body ? ` body=${body}` : ''}`);
      return false;
    }
    return true;
  } catch (error) {
    logWarn(label, 'muninn memory finalize request failed', error);
    return false;
  }
},
```

- [ ] **Step 2: Call finalize after successful enable marker capture**

In `applyCaptureMarker()`, after progress is written for an enable marker, call `finalizeMemory()` when available. Replace:

```ts
if (captured) {
  await writeCaptureProgressEntry(params.result.sessionKey, params.result.progressEntry).catch(() => undefined);
}
await writeHookDebugEvent(params.label, {
  stage: 'capture-marker-enable-finished',
  sessionKey: params.result.sessionKey,
  sessionId: params.result.progressEntry.sessionId,
  project: params.result.progressEntry.project,
  turnCount: params.result.turns.length,
  failedTurns,
  captured,
  progressWritten: captured,
});
return captured;
```

with:

```ts
let finalized = false;
if (captured) {
  await writeCaptureProgressEntry(params.result.sessionKey, params.result.progressEntry).catch(() => undefined);
  finalized = await client.finalizeMemory?.() ?? false;
}
await writeHookDebugEvent(params.label, {
  stage: 'capture-marker-enable-finished',
  sessionKey: params.result.sessionKey,
  sessionId: params.result.progressEntry.sessionId,
  project: params.result.progressEntry.project,
  turnCount: params.result.turns.length,
  failedTurns,
  captured,
  progressWritten: captured,
  finalized,
});
return captured;
```

Finalize failure should not make capture fail. The captured turns remain durable and the normal epoch window can still seal the tail.

- [ ] **Step 3: Add remember finalize success test**

In `common/test/agent-hook.test.mjs`, update `captureFromTranscript enables current session capture from marker and captures prior turns` by adding a `finalized` counter:

```js
let finalized = 0;
```

and adding this method to the test client:

```js
async finalizeMemory() {
  finalized += 1;
  return true;
},
```

Then add this assertion after the existing captured assertion:

```js
assert.equal(finalized, 1);
```

- [ ] **Step 4: Add failure regression assertion**

In `captureFromTranscript does not advance progress when marker capture fails`, add:

```js
let finalized = 0;
```

and this method to the client:

```js
async finalizeMemory() {
  finalized += 1;
  return true;
},
```

Then assert:

```js
assert.equal(finalized, 0);
```

- [ ] **Step 5: Run common tests**

Run:

```bash
pnpm --filter @muninn/common build
pnpm --filter @muninn/common test
```

Expected: PASS.

- [ ] **Step 6: Commit remember finalize change**

```bash
git add common/src/agent-hook.ts common/test/agent-hook.test.mjs
git commit -m "fix: finalize remember-session explicitly"
```

---

### Task 5: Verify Integration Surface

**Files:**
- No source changes expected.

- [ ] **Step 1: Run targeted server tests**

Run:

```bash
pnpm --filter @muninn/server build
pnpm --filter @muninn/server test -- --test-name-pattern "extractor.acceptBatch packs|extractor.accept keeps a partial epoch open|extractEpoch chunks same-session turns"
```

Expected: PASS.

- [ ] **Step 2: Run common hook tests**

Run:

```bash
pnpm --filter @muninn/common test
```

Expected: PASS.

- [ ] **Step 3: Run codex hook tests**

Run:

```bash
pnpm --filter @muninn/codex test
```

Expected: PASS.

- [ ] **Step 4: Inspect the capture API schema did not change**

Run:

```bash
grep -RIn "mode\\|flush" common/src/api.ts server/src/http.ts
```

Expected: no new `CaptureTurnsRequest.mode` or `CaptureTurnsRequest.flush` fields.

- [ ] **Step 5: Commit any verification-only follow-up**

If verification required small fixes, commit them:

```bash
git add <changed-files>
git commit -m "test: cover batch epoch boundaries"
```

If there are no changes, do not create an empty commit.

---

## Self-Review

- Spec coverage:
  - Bounded batch epochs: Task 1 and Task 2.
  - No capture schema fields: Task 2 and Task 5.
  - Ordinary hook no auto finalize: Task 3.
  - Remember explicit finalize: Task 4.
  - Extraction chunking remains: Task 5 targeted test includes existing chunking tests.
  - Import streaming deferred: no task changes import adapter buffering.
- Placeholder scan:
  - No unfinished placeholder markers.
  - Deferred import streaming is explicitly out of scope.
- Type consistency:
  - `MuninnClient.finalizeMemory()` is optional and returns `Promise<boolean>`, matching `captureTurns()` and `deleteSession()` style.
  - `packNextBatchGroup()` consumes `TurnContent[]` and existing `TurnRow[]`, matching `Extractor.acceptBatch()` and `OpenEpoch.stagedTurns()`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-01-batch-epoch-boundaries.md`.

Because this is a side conversation, use **Inline Execution** with `superpowers:executing-plans` if you want me to implement it here. Subagents are off-limits in this side conversation.
