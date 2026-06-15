# Extractor Runtime Naming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename and reorganize the extractor runtime files so the main extraction flow is readable without changing behavior.

**Architecture:** Keep the existing runtime flow and state machine intact while renaming files and methods around their real responsibilities. The final extractor directory has six concept files: `runtime.ts`, `epoch.ts`, `session.ts`, `snapshot.ts`, `extraction-index.ts`, and `types.ts`.

**Tech Stack:** TypeScript ESM, Node test runner, pnpm workspaces, existing Muninn server native bindings.

---

## File Structure

Target extractor directory:

```text
server/src/memory/extractor/
  runtime.ts
  epoch.ts
  session.ts
  snapshot.ts
  extraction-index.ts
  types.ts
```

Historical files to remove if no production references remain:

```text
server/src/memory/extractor/extraction-review.ts
server/src/memory/extractor/thread-preparation.ts
server/src/memory/extractor/gateway-trace.ts
server/prompts/extraction-review.yaml
server/prompts/thread-preparation.yaml
server/test/memory/thread-preparation-tool-loop.test.mjs
```

Main rename map:

```text
server/src/memory/extractor/extractor.ts       -> server/src/memory/extractor/runtime.ts
server/src/memory/extractor/thread.ts          -> server/src/memory/extractor/session.ts
server/src/memory/extractor/thread-memory.ts   -> server/src/memory/extractor/snapshot.ts
server/src/memory/extractor/memory-delta.ts    -> server/src/memory/extractor/extraction-index.ts
server/src/memory/extractor/update.ts          -> removed after moving responsibilities
```

---

### Task 1: Remove Historical Non-Runtime Extraction Stages

**Files:**
- Delete: `server/src/memory/extractor/extraction-review.ts`
- Delete: `server/src/memory/extractor/thread-preparation.ts`
- Delete: `server/src/memory/extractor/gateway-trace.ts`
- Delete: `server/prompts/extraction-review.yaml`
- Delete: `server/prompts/thread-preparation.yaml`
- Delete: `server/test/memory/thread-preparation-tool-loop.test.mjs`
- Modify: `server/src/memory/llm/prompt-loader.ts`
- Modify: `server/test/memory/client-internals.test.mjs`
- Modify: `server/test/memory/prompt-loader.test.mjs`

- [ ] **Step 1: Verify there are no production imports**

Run:

```bash
rg -n "from './(extraction-review|thread-preparation|gateway-trace)|extractor/(extraction-review|thread-preparation|gateway-trace)|loadPromptTemplate\\('(extraction_review|thread_preparation)'\\)" server/src benchmark/locomo/src
```

Expected: only `prompt-loader.ts`, `extraction-review.ts`, and `thread-preparation.ts` are reported under `server/src`; no production caller imports `reviewExtractions`, `prepareThreads`, or `writeGatewayTrace`.

- [ ] **Step 2: Delete historical files**

Run:

```bash
git rm \
  server/src/memory/extractor/extraction-review.ts \
  server/src/memory/extractor/thread-preparation.ts \
  server/src/memory/extractor/gateway-trace.ts \
  server/prompts/extraction-review.yaml \
  server/prompts/thread-preparation.yaml \
  server/test/memory/thread-preparation-tool-loop.test.mjs
```

Expected: the six files are staged for deletion.

- [ ] **Step 3: Remove prompt-loader mappings**

Edit `server/src/memory/llm/prompt-loader.ts` so `PROMPT_FILE_NAMES` no longer contains these keys:

```ts
  extraction_review: 'extraction-review',
  thread_preparation: 'thread-preparation',
```

The surrounding object should keep only active prompt names:

```ts
const PROMPT_FILE_NAMES = {
  turn: 'turn',
  chat: 'chat',
  thread_observing: 'observer',
  thread_extracting: 'extractor',
  extracting_gateway: 'extracting-gateway',
  memory_recaller: 'memory-recaller',
} as const;
```

- [ ] **Step 4: Remove historical tests from client internals**

Delete these tests from `server/test/memory/client-internals.test.mjs`:

```text
extraction review validation requires every new extraction to be reviewed
extraction review validation rejects unknown removals
thread preparation validation rejects duplicate extraction coverage
thread preparation validation rejects single-extraction new threads
thread preparation validation rejects unknown target threads
thread preparation model validation failure falls back to unthreaded extractions
```

Expected: no imports or dynamic imports reference `extraction-review.js` or `thread-preparation.js`.

- [ ] **Step 5: Remove historical prompt-loader tests**

Delete these tests from `server/test/memory/prompt-loader.test.mjs`:

```text
extraction review prompt only removes extractions
thread preparation prompt enforces two extractions for new threads
```

Expected: no tests load `extraction_review` or `thread_preparation`.

- [ ] **Step 6: Verify historical residue is gone**

Run:

```bash
rg -n "extraction_review|extraction-review|thread_preparation|thread-preparation|gateway-trace|reviewExtractions|prepareThreads|writeGatewayTrace" server/src server/test benchmark/locomo/src
```

Expected: no matches.

- [ ] **Step 7: Build and test server**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/server build
source ~/.zprofile && pnpm --filter @muninn/server test
```

Expected: both commands pass.

- [ ] **Step 8: Commit**

Run:

```bash
git add -A
git commit -m "refactor: remove legacy extractor stages"
```

Expected: commit succeeds.

---

### Task 2: Rename One-To-One Extractor Files

**Files:**
- Move: `server/src/memory/extractor/extractor.ts` -> `server/src/memory/extractor/runtime.ts`
- Move: `server/src/memory/extractor/thread.ts` -> `server/src/memory/extractor/session.ts`
- Move: `server/src/memory/extractor/thread-memory.ts` -> `server/src/memory/extractor/snapshot.ts`
- Move: `server/src/memory/extractor/memory-delta.ts` -> `server/src/memory/extractor/extraction-index.ts`
- Modify: `server/src/memory/backend.ts`
- Modify: `server/src/memory/extractor/runtime.ts`
- Modify: `server/src/memory/extractor/session.ts`
- Modify: `server/src/memory/extractor/extraction-index.ts`
- Modify: `server/src/memory/llm/extracting.ts`
- Modify: `server/test/memory/client-internals.test.mjs`

- [ ] **Step 1: Move files with git**

Run:

```bash
git mv server/src/memory/extractor/extractor.ts server/src/memory/extractor/runtime.ts
git mv server/src/memory/extractor/thread.ts server/src/memory/extractor/session.ts
git mv server/src/memory/extractor/thread-memory.ts server/src/memory/extractor/snapshot.ts
git mv server/src/memory/extractor/memory-delta.ts server/src/memory/extractor/extraction-index.ts
```

Expected: files are renamed without content changes.

- [ ] **Step 2: Update imports for renamed files**

Apply these import path changes:

```text
./extractor/extractor.js -> ./extractor/runtime.js
./thread.js -> ./session.js
./thread-memory.js -> ./snapshot.js
./memory-delta.js -> ./extraction-index.js
../extractor/thread-memory.js -> ../extractor/snapshot.js
../../dist/memory/extractor/extractor.js -> ../../dist/memory/extractor/runtime.js
../../dist/memory/extractor/thread.js -> ../../dist/memory/extractor/session.js
../../dist/memory/extractor/memory-delta.js -> ../../dist/memory/extractor/extraction-index.js
```

Concrete expected imports include:

```ts
// server/src/memory/backend.ts
import { Extractor } from './extractor/runtime.js';
```

```ts
// server/src/memory/extractor/runtime.ts
import {
  cloneSessionMemoryThreads,
  getPendingIndex,
  getPendingIndexUpTo,
  isActiveThread,
  loadThreads,
  replaySnapshots,
  threadFromSnapshots,
} from './session.js';
import { buildExtraction, buildTouchedIndex, extractEpoch } from './update.js';
```

```ts
// server/src/memory/extractor/session.ts
import { parseSnapshotContent } from './snapshot.js';
```

```ts
// server/src/memory/extractor/update.ts
import { applyExtractionChanges, applyExtractionTableChanges } from './extraction-index.js';
```

```ts
// server/src/memory/llm/extracting.ts
import {
  parseSnapshotContent,
  parseSnapshotPatch,
  renderExtractionBlock,
  renderSnapshotContent,
} from '../extractor/snapshot.js';
```

- [ ] **Step 3: Verify old file import residue is gone**

Run:

```bash
rg -n "extractor/(extractor|thread|thread-memory|memory-delta)|from './(thread|thread-memory|memory-delta)'|from '../extractor/thread-memory'" server/src server/test benchmark/locomo/src
```

Expected: no matches.

- [ ] **Step 4: Build and test server**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/server build
source ~/.zprofile && pnpm --filter @muninn/server test
```

Expected: both commands pass.

- [ ] **Step 5: Commit**

Run:

```bash
git add -A
git commit -m "refactor: rename extractor runtime files"
```

Expected: commit succeeds.

---

### Task 3: Move Session Extraction Out Of `update.ts`

**Files:**
- Modify: `server/src/memory/extractor/session.ts`
- Modify: `server/src/memory/extractor/update.ts`
- Modify: `server/src/memory/extractor/runtime.ts`
- Modify: `server/test/memory/client-internals.test.mjs`

- [ ] **Step 1: Move session extraction imports into `session.ts`**

Add these imports to `server/src/memory/extractor/session.ts`:

```ts
import type { Turn } from '../backend.js';
import { Memories } from '../memories.js';
import type { NativeTables } from '../native.js';
import { extractSessionMemory } from '../llm/extracting.js';
import type { SealedEpoch } from './epoch.js';
import { applyExtractionChanges } from './extraction-index.js';
```

Keep existing snapshot imports from `./snapshot.js`.

- [ ] **Step 2: Add session extraction functions to `session.ts`**

Move the session-related code from `update.ts` into `session.ts` and rename it:

```ts
type ExtractSessionMemoryImpl = typeof extractSessionMemory;
const DEFAULT_SESSION_ID = '__muninn_default_session__';

type ExtractSessionThreadParams = {
  thread: SessionMemoryThread;
  pendingTurns: Turn[];
  extractionEpoch: number;
  signal?: AbortSignal;
  database?: string;
  memories?: Pick<Memories, 'get'>;
  extractSessionMemoryImpl?: ExtractSessionMemoryImpl;
};

export async function extractSessionEpoch(params: {
  client: NativeTables;
  extractorName: string;
  activeWindowDays: number;
  threads: SessionMemoryThread[];
  sealedEpoch: SealedEpoch;
  signal?: AbortSignal;
  database?: string;
  extractSessionMemoryImpl?: ExtractSessionMemoryImpl;
}): Promise<{ threads: SessionMemoryThread[]; touchedIds: Set<string> }> {
  throwIfAborted(params.signal);
  pruneInactiveSessionThreads(params.threads, params.activeWindowDays);
  const memories = new Memories(params.client);
  const touchedIds = new Set<string>();
  for (const turns of groupTurnsBySession(params.sealedEpoch.turns)) {
    const thread = getOrCreateSessionThread(
      params.threads,
      params.extractorName,
      turns,
      params.sealedEpoch.epoch,
    );
    const groupTouchedIds = await extractSessionThread({
      thread,
      pendingTurns: turns,
      extractionEpoch: params.sealedEpoch.epoch,
      signal: params.signal,
      database: params.database,
      memories,
      extractSessionMemoryImpl: params.extractSessionMemoryImpl,
    });
    for (const touchedId of groupTouchedIds) {
      touchedIds.add(touchedId);
    }
  }
  await flushSessionThreads(params.client, params.threads, touchedIds);
  return { threads: params.threads, touchedIds };
}
```

Use the existing bodies from `update.ts` for `groupTurnsBySession`, `sessionIdForTurns`, `ownershipForTurns`, `getOrCreateSessionThread`, and `extractSessionThread`, but apply the agreed names:

```text
ensureActiveThreads -> pruneInactiveSessionThreads
threadIdentityKey -> sessionThreadIdentityKey
flushThreads -> flushSessionThreads
```

- [ ] **Step 3: Rename existing session model exports in `session.ts`**

Apply these function renames in `server/src/memory/extractor/session.ts`:

```text
createSessionMemoryThread -> createSessionThread
cloneSessionMemoryThread -> cloneSessionThread
cloneSessionMemoryThreads -> cloneSessionThreads
loadThreads -> loadSessionThreads
threadFromSnapshots -> sessionThreadFromSnapshots
replaySnapshots -> replaySessionSnapshots
currentSessionMemoryContent -> currentSessionContent
applyExtractionResult -> applyExtraction
getPendingIndex -> pendingSnapshotRange
getPendingIndexUpTo -> pendingSnapshotRangeUpTo
```

The `applyExtraction` implementation is the old `applyExtractionResult` body with the new name:

```ts
export function applyExtraction(
  thread: SessionMemoryThread,
  result: ExtractSessionMemoryResult,
  extractionEpoch: number,
  diffExtractions: typeof applyExtractionChanges,
  now = new Date().toISOString(),
): void {
  const current = latestSnapshot(thread) ?? emptySnapshot();
  const patched = diffExtractions(current.extractions, result);
  const snapshot: SnapshotContent = {
    title: result.title,
    summary: result.summary,
    signals: result.signals ?? '',
    snapshotContent: result.snapshotContent,
    extractions: patched.extractions,
    extractionChanges: patched.extractionChanges,
    openQuestions: result.openQuestions,
    nextSteps: result.nextSteps,
    contextRefs: mergeContextRefs(current.contextRefs, result.contextRefs),
  };
  thread.title = result.title;
  thread.summary = result.summary;
  thread.snapshots.push(snapshot);
  thread.snapshotEpochs.push(extractionEpoch);
  for (const reference of snapshot.contextRefs.map((ref) => ref.turnId)) {
    pushReference(thread, reference);
  }
  thread.updatedAt = now;
}
```

- [ ] **Step 4: Update runtime imports and calls**

In `server/src/memory/extractor/runtime.ts`, import renamed session functions:

```ts
import {
  cloneSessionThreads,
  pendingSnapshotRange,
  pendingSnapshotRangeUpTo,
  isActiveThread,
  loadSessionThreads,
  replaySessionSnapshots,
  sessionThreadFromSnapshots,
  extractSessionEpoch,
} from './session.js';
```

Update calls:

```text
cloneSessionMemoryThreads -> cloneSessionThreads
getPendingIndex -> pendingSnapshotRange
getPendingIndexUpTo -> pendingSnapshotRangeUpTo
loadThreads -> loadSessionThreads
replaySnapshots -> replaySessionSnapshots
threadFromSnapshots -> sessionThreadFromSnapshots
extractEpoch -> extractSessionEpoch
```

- [ ] **Step 5: Leave `update.ts` with only index responsibilities**

After moving session extraction out, `server/src/memory/extractor/update.ts` should no longer import `Turn`, `Memories`, `extractSessionMemory`, `SealedEpoch`, `createSessionMemoryThread`, `currentSessionMemoryContent`, or `applyExtraction`.

It should keep only index-related functions until Task 4:

```text
catchUpIndex
buildExtraction
buildTouchedIndex
updateThreadsFromRows is removed because flushSessionThreads moved to session.ts
```

- [ ] **Step 6: Update tests for session rename**

In `server/test/memory/client-internals.test.mjs`, update the session module import and destructuring:

```ts
import sessionModule from '../../dist/memory/extractor/session.js';

const { __testing: sessionTesting } = sessionModule;
const {
  createSessionThread,
  pendingSnapshotRange,
  pendingSnapshotRangeUpTo,
  loadSessionThreads,
  toSessionSnapshot,
} = sessionModule;
```

Update test names and calls:

```text
getPendingIndex -> pendingSnapshotRange
getPendingIndexUpTo -> pendingSnapshotRangeUpTo
loadThreads -> loadSessionThreads
createSessionMemoryThread -> createSessionThread
threadTesting.applyExtractionResultForTests -> sessionTesting.applyExtractionForTests
updateTesting.extractEpoch -> sessionTesting.extractSessionEpoch
updateTesting.extractSessionThreadForTests -> sessionTesting.extractSessionThreadForTests
```

- [ ] **Step 7: Build and test server**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/server build
source ~/.zprofile && pnpm --filter @muninn/server test
```

Expected: both commands pass.

- [ ] **Step 8: Commit**

Run:

```bash
git add -A
git commit -m "refactor: move session extraction into session module"
```

Expected: commit succeeds.

---

### Task 4: Move Indexing Out Of `update.ts` And Delete It

**Files:**
- Modify: `server/src/memory/extractor/extraction-index.ts`
- Modify: `server/src/memory/extractor/runtime.ts`
- Modify: `server/test/memory/client-internals.test.mjs`
- Delete: `server/src/memory/extractor/update.ts`

- [ ] **Step 1: Move index functions into `extraction-index.ts`**

Move the remaining index functions from `update.ts` into `server/src/memory/extractor/extraction-index.ts` and rename them:

```text
catchUpIndex -> indexThreadSnapshots
buildExtraction -> indexAllUnindexedSnapshots
buildTouchedIndex -> indexTouchedSessionThreads
```

Add required imports to `extraction-index.ts`:

```ts
import type { QueuedExtractionChange } from '../checkpoint.js';
import type { NativeTables } from '../native.js';
import type { SessionMemoryThread } from './types.js';
import { pendingSnapshotRange, snapshotRef } from './session.js';
```

The exported index functions should have these signatures:

```ts
export async function indexThreadSnapshots(
  client: NativeTables,
  thread: SessionMemoryThread,
  signal?: AbortSignal,
): Promise<QueuedExtractionChange[]>;

export async function indexAllUnindexedSnapshots(
  client: NativeTables,
  threads: SessionMemoryThread[],
  signal?: AbortSignal,
): Promise<QueuedExtractionChange[]>;

export async function indexTouchedSessionThreads(
  client: NativeTables,
  threads: SessionMemoryThread[],
  touchedIds: Set<string>,
  signal?: AbortSignal,
): Promise<QueuedExtractionChange[]>;
```

- [ ] **Step 2: Update runtime indexing imports**

In `server/src/memory/extractor/runtime.ts`, replace:

```ts
import { buildExtraction, buildTouchedIndex } from './update.js';
```

with:

```ts
import {
  indexAllUnindexedSnapshots,
  indexTouchedSessionThreads,
} from './extraction-index.js';
```

Update calls:

```text
buildExtraction -> indexAllUnindexedSnapshots
buildTouchedIndex -> indexTouchedSessionThreads
```

- [ ] **Step 3: Delete `update.ts`**

Run:

```bash
git rm server/src/memory/extractor/update.ts
```

Expected: `update.ts` is staged for deletion.

- [ ] **Step 4: Update tests for index rename**

In `server/test/memory/client-internals.test.mjs`, replace:

```ts
import updateModule from '../../dist/memory/extractor/update.js';
const { __testing: updateTesting } = updateModule;
```

with:

```ts
import extractionIndexModule, {
  applyExtractionChanges,
  applyExtractionTableChanges,
} from '../../dist/memory/extractor/extraction-index.js';

const { __testing: extractionIndexTesting } = extractionIndexModule;
```

Update calls:

```text
updateTesting.buildExtraction -> extractionIndexTesting.indexAllUnindexedSnapshots
updateTesting.buildTouchedIndex -> extractionIndexTesting.indexTouchedSessionThreads
```

Keep existing direct imports of `applyExtractionChanges` and `applyExtractionTableChanges`, but make them come from `extraction-index.js`.

- [ ] **Step 5: Verify `update` residue is gone**

Run:

```bash
rg -n "extractor/update|from './update|updateTesting|buildExtraction|buildTouchedIndex|catchUpIndex" server/src server/test benchmark/locomo/src
```

Expected: no matches.

- [ ] **Step 6: Build and test server**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/server build
source ~/.zprofile && pnpm --filter @muninn/server test
```

Expected: both commands pass.

- [ ] **Step 7: Commit**

Run:

```bash
git add -A
git commit -m "refactor: move extraction indexing into index module"
```

Expected: commit succeeds.

---

### Task 5: Rename Runtime Methods And Observe Terminology

**Files:**
- Modify: `server/src/memory/extractor/runtime.ts`
- Modify: `server/test/memory/client-internals.test.mjs`

- [ ] **Step 1: Rename runtime private methods**

In `server/src/memory/extractor/runtime.ts`, apply these method renames and update all internal call sites:

```text
bootstrapInternal -> bootstrapRuntime
observeCurrentEpoch -> extractCurrentEpoch
buildCurrentEpochIndex -> indexCurrentEpochSnapshots
restoreCheckpointState -> restore
restoreThreadsFromCheckpoint -> replayCheckpoint
hasPendingExtraction -> hasAnyUnindexedSnapshots
hasPendingExtractionUpTo -> hasUnindexedSnapshotsAtOrBefore
retryExtraction -> retrySnapshotIndexing
```

The `flushPending()` barrier variable should use extraction terminology:

```ts
const barrierRequiresExtraction = sealedEpoch.turns.length > 0;
const barrierComplete = () => {
  const extracted = !barrierRequiresExtraction || (this.committedEpoch ?? -1) >= barrier.epoch;
  return extracted && !this.hasUnindexedSnapshotsAtOrBefore(barrier.epoch);
};
```

- [ ] **Step 2: Update runtime logic to use explicit unindexed snapshot names**

In `watermark()`, replace the local `hasPendingExtraction` name with:

```ts
const hasUnindexedSnapshots = this.hasAnyUnindexedSnapshots();
```

The phase logic should read:

```ts
const phase = this.lastIndexError && hasUnindexedSnapshots
  ? 'error'
  : this.currentEpoch || hasUnindexedSnapshots
    ? 'running'
    : pendingTurnIds.length > 0
      ? 'pending'
      : 'idle';
```

- [ ] **Step 3: Update tests for runtime method names**

In `server/test/memory/client-internals.test.mjs`, update test names and direct private method calls:

```text
observer restoreCheckpointState advances committedEpoch and excludes observed turns from pending
  -> extractor restore advances committedEpoch and excludes extracted turns from pending

observer restoreCheckpointState falls back when session delta refs are missing turn epochs
  -> extractor restore falls back when session delta refs are missing turn epochs

observer restoreCheckpointState skips stale threads resource only from session delta
  -> extractor restore skips stale session thread resource only from session delta

observer restoreCheckpointState rebuilds delta-only threads from full history
  -> extractor restore rebuilds delta-only session threads from full history

observer exportCheckpoint keeps the last committed snapshot while observeCurrentEpoch is mid-flight
  -> extractor exportCheckpoint keeps the last committed snapshot while extractCurrentEpoch is mid-flight

observer.observeCurrentEpoch keeps thread state unchanged when pre-commit work fails
  -> extractor.extractCurrentEpoch keeps thread state unchanged when pre-commit work fails

observer.retryExtraction refreshes the committed checkpoint snapshot after session rows are updated
  -> extractor.retrySnapshotIndexing refreshes the committed checkpoint snapshot after session rows are updated

observer.observeCurrentEpoch commits session rows before retrying extraction changes
  -> extractor.extractCurrentEpoch commits session rows before retrying extraction changes
```

Update direct method calls:

```text
observer.restoreCheckpointState() -> observer.restore()
observer.observeCurrentEpoch() -> observer.extractCurrentEpoch()
observer.buildCurrentEpochIndex = async () => ... -> observer.indexCurrentEpochSnapshots = async () => ...
observer.retryExtraction() -> observer.retrySnapshotIndexing()
```

- [ ] **Step 4: Verify old runtime names are gone**

Run:

```bash
rg -n "observeCurrentEpoch|barrierRequiresObserve|hasPendingExtraction|hasPendingExtractionUpTo|retryExtraction|buildCurrentEpochIndex|restoreCheckpointState|restoreThreadsFromCheckpoint" server/src server/test
```

Expected: no matches.

- [ ] **Step 5: Build and test server**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/server build
source ~/.zprofile && pnpm --filter @muninn/server test
```

Expected: both commands pass.

- [ ] **Step 6: Commit**

Run:

```bash
git add -A
git commit -m "refactor: rename extractor runtime methods"
```

Expected: commit succeeds.

---

### Task 6: Final Residue Checks And Benchmark Verification

**Files:**
- Inspect only unless checks reveal missed rename residue.

- [ ] **Step 1: Check final extractor directory shape**

Run:

```bash
rg --files server/src/memory/extractor | sort
```

Expected output:

```text
server/src/memory/extractor/epoch.ts
server/src/memory/extractor/extraction-index.ts
server/src/memory/extractor/runtime.ts
server/src/memory/extractor/session.ts
server/src/memory/extractor/snapshot.ts
server/src/memory/extractor/types.ts
```

- [ ] **Step 2: Check old file residue**

Run:

```bash
rg -n "extractor/(extractor|update|thread|thread-memory|memory-delta|extraction-review|thread-preparation|gateway-trace)|from './(update|thread|thread-memory|memory-delta|extraction-review|thread-preparation|gateway-trace)'" server/src server/test benchmark/locomo/src
```

Expected: no matches.

- [ ] **Step 3: Check old method residue**

Run:

```bash
rg -n "observeCurrentEpoch|barrierRequiresObserve|hasPendingExtraction|hasPendingExtractionUpTo|retryExtraction|buildCurrentEpochIndex|restoreCheckpointState|restoreThreadsFromCheckpoint|buildTouchedIndex|buildExtraction|catchUpIndex|getPendingIndex|getPendingIndexUpTo|currentSessionMemoryContent|createSessionMemoryThread|loadThreads|threadFromSnapshots|replaySnapshots|applyExtractionResult" server/src server/test
```

Expected: no matches, except unrelated web helper names such as `buildExtractionsForTests` if the search scope is widened outside `server/src/memory/extractor` and `server/test/memory`.

- [ ] **Step 4: Run full planned verification**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/server build
source ~/.zprofile && pnpm --filter @muninn/server test
source ~/.zprofile && pnpm --filter @muninn/benchmark-locomo build
source ~/.zprofile && pnpm --filter @muninn/benchmark-locomo test
```

Expected: all commands pass.

- [ ] **Step 5: Commit final residue fixes if needed**

If Step 1 through Step 4 required edits after the Task 5 commit, run:

```bash
git add -A
git commit -m "test: verify extractor runtime naming cleanup"
```

Expected: commit succeeds only if files changed. If no files changed, skip this commit.
