# Observing Thread-Scoped Slicing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make observing routing thread-scoped so one turn can contribute different grounded slices to multiple threads, while observing update stores durable conclusions instead of transcript-like speech acts.

**Architecture:** Tighten the gateway contract so each `(turn, thread)` update carries a thread-local summary, then preserve that summary all the way into `observeThread` instead of falling back to the raw turn summary. In parallel, strengthen the observing prompt and final title/summary normalization so stored observing threads read like topic state rather than clipped event lists.

**Tech Stack:** TypeScript, Node test runner, prompt YAML templates, `@muninn/core` observer pipeline

---

## File Map

- Modify: `packages/core/prompts/observing-gateway.yaml`
  - Define thread-scoped slicing rules for gateway updates.
- Modify: `packages/core/prompts/observing.yaml`
  - Tighten memory/title/summary rules for durable conclusions.
- Modify: `packages/core/src/llm/observing-gateway.ts`
  - Preserve final title/summary readability and keep gateway update validation aligned with the new prompt contract.
- Modify: `packages/core/src/observer/update.ts`
  - Pass `update.summary` into observing update instead of falling back to the raw turn summary.
  - Export the helper needed for direct regression tests.
- Modify: `packages/core/src/observer/thread.ts`
  - Keep final stored title/summary complete and readable instead of clipping them with `...`.
- Modify: `packages/core/test/prompt-loader.test.mjs`
  - Add prompt contract tests for `observing_gateway` and the new observing title/summary rules.
- Modify: `packages/core/test/client-internals.test.mjs`
  - Add regression tests for per-thread sliced summaries and non-clipped stored title/summary.

## Task 1: Lock Prompt Contracts With Tests First

**Files:**
- Modify: `packages/core/test/prompt-loader.test.mjs`
- Test: `packages/core/test/prompt-loader.test.mjs`

- [ ] **Step 1: Write the failing gateway prompt contract test**

Add a new test that loads `observing_gateway` and asserts the prompt explicitly requires thread-scoped sliced summaries for each target thread.

```js
test('observing gateway prompt requires thread-scoped sliced updates', () => {
  const template = loadPromptTemplate('observing_gateway');
  const system = template.system;

  assert.match(system, /relevant only to the target thread/);
  assert.match(system, /The same `turnId` may appear more than once/);
  assert.match(system, /Do not treat the whole turn as one indivisible unit/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test packages/core/test/prompt-loader.test.mjs`
Expected: FAIL because the new gateway-specific assertions are not all present yet.

- [ ] **Step 3: Write the failing observing prompt title/summary quality assertions**

Extend the existing observing prompt test with explicit assertions for:
- short readable topic label
- not a sentence or event list
- durable state summary, not chronological transcript
- no ellipsis-ending summary requirement

```js
assert.match(system, /Thread title/);
assert.match(system, /short readable topic label/);
assert.match(system, /Summary quality/);
assert.match(system, /durable state summary, not a chronological transcript/);
assert.match(system, /must be complete and must not end with an ellipsis/);
```

- [ ] **Step 4: Run test to verify it still fails for the right reason**

Run: `node --test packages/core/test/prompt-loader.test.mjs`
Expected: FAIL with missing prompt text assertions, not with syntax errors.

- [ ] **Step 5: Update the prompt YAML files minimally**

Modify `packages/core/prompts/observing-gateway.yaml` to make the gateway contract explicit:

```yaml
  Routing rules:
  - A single turn may contribute updates to multiple existing observing threads
  - For each target thread, `summary` must contain only the grounded fragment relevant to that thread
  - If the same `turnId` appears more than once, each occurrence must use a different thread-scoped summary when the turn contributes different content to different threads
```

Modify `packages/core/prompts/observing.yaml` to add the hard title/summary and speech-act rules:

```yaml
  Do not store speech acts as memories.
  If a turn only asks, reacts, thanks, praises, greets, or closes the conversation, do not store it as a memory unless it changes durable state.
```

```yaml
  Thread title:
  - `title` must be a short readable topic label, not a sentence or event list.
```

```yaml
  Summary quality:
  - `summary` must be a durable state summary, not a chronological transcript.
  - `summary` must be complete and must not end with an ellipsis.
```

- [ ] **Step 6: Run the prompt tests to verify they pass**

Run: `node --test packages/core/test/prompt-loader.test.mjs`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/core/prompts/observing-gateway.yaml packages/core/prompts/observing.yaml packages/core/test/prompt-loader.test.mjs
git commit -m "test: lock observing prompt contracts"
```

## Task 2: Add a Regression Test for Per-Thread Sliced Summaries

**Files:**
- Modify: `packages/core/test/client-internals.test.mjs`
- Modify: `packages/core/src/observer/update.ts`
- Test: `packages/core/test/client-internals.test.mjs`

- [ ] **Step 1: Write the failing regression test**

Add a test that calls an exported `applyGatewayUpdates` test helper directly with:
- two existing threads
- one pending turn with a broad raw summary
- two gateway updates for the same `turnId`, each with a different sliced `summary`
- an injected `observeThreadImpl` stub that records the `pendingTurns` it receives

The test should assert that each thread receives only its own sliced summary in `pendingTurns`.

```js
test('applyGatewayUpdates preserves per-thread sliced summaries for the same turn', async () => {
  const observedInputs = [];
  const observeThreadImpl = async (input) => {
    observedInputs.push(input);
    return {
      observingContentUpdate: {
        title: input.observingContent.title,
        summary: input.observingContent.summary,
        openQuestions: [],
        nextSteps: [],
      },
      memoryDelta: { before: [], after: [] },
    };
  };
  // call applyGatewayUpdates with two append updates for the same turn
  assert.deepEqual(observedInputs[0].pendingTurns, [{
    turnId: 'turn-1',
    summary: 'Melanie said Caroline would be a great counselor.',
    whyRelated: 'Career direction',
  }]);
  assert.deepEqual(observedInputs[1].pendingTurns, [{
    turnId: 'turn-1',
    summary: 'Melanie shared a sunset lake painting.',
    whyRelated: 'Painting topic',
  }]);
});
```

- [ ] **Step 2: Run the targeted test to verify it fails**

Run: `node --test --test-name-pattern 'applyGatewayUpdates preserves per-thread sliced summaries for the same turn' packages/core/test/client-internals.test.mjs`
Expected: FAIL because `applyGatewayUpdates` is not exported for tests, does not accept an injected `observeThreadImpl`, and currently rebuilds input summaries from `turn.summary`.

- [ ] **Step 3: Export the helper and add an injected observe function**

Change `applyGatewayUpdates` to accept an optional injected observe function:

```ts
async function applyGatewayUpdates(
  threads: ObservingThread[],
  observerName: string,
  pendingTurns: SessionTurn[],
  observingEpoch: number,
  updates: GatewayUpdate[],
  signal?: AbortSignal,
  observeThreadImpl = observeThread,
): Promise<Set<string>> {
```

and call the injected function here:

```ts
const result = await observeThreadImpl({
  observingContent: currentObservingContent(thread),
  pendingTurns: [...turnsById.values()],
}, signal);
```

Expose `applyGatewayUpdates` through `__testing` in `packages/core/src/observer/update.ts`.

```ts
export const __testing = {
  flushThreads,
  buildTouchedIndex,
  buildSemanticIndex,
  observeEpoch,
  applyGatewayUpdates,
};
```

- [ ] **Step 4: Make `applyGatewayUpdates` preserve `update.summary`**

Replace the current fallback summary wiring:

```ts
const observeTurn = {
  turnId: turn.turnId,
  summary: turn.summary ?? turn.prompt ?? turn.response ?? '',
  whyRelated: normalizeText(update.why, 100),
};
```

with:

```ts
const observeTurn = {
  turnId: turn.turnId,
  summary: update.summary,
  whyRelated: normalizeText(update.why, 100),
};
```

This is the critical behavior fix. Without it, gateway slicing is discarded before observing update runs.

- [ ] **Step 5: Keep append/new thread creation behavior unchanged**

Do not change the gateway schema or the rule that one turn may produce multiple updates. Only preserve the per-update sliced `summary` instead of re-expanding it.

- [ ] **Step 6: Run the targeted regression test again**

Run: `node --test --test-name-pattern 'applyGatewayUpdates preserves per-thread sliced summaries for the same turn' packages/core/test/client-internals.test.mjs`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/observer/update.ts packages/core/test/client-internals.test.mjs
git commit -m "fix: preserve sliced observing gateway summaries"
```

## Task 3: Keep Stored Observing Titles And Summaries Readable

**Files:**
- Modify: `packages/core/test/client-internals.test.mjs`
- Modify: `packages/core/src/observer/thread.ts`
- Modify: `packages/core/src/llm/observing-gateway.ts`
- Test: `packages/core/test/client-internals.test.mjs`

- [ ] **Step 1: Write the failing readability regression test**

Add a test that creates an observing thread with a long but still valid readable title and summary and asserts they are stored intact rather than ending with `...`.

```js
test('createObservingThread preserves complete readable title and summary text', () => {
  const thread = createObservingThread(
    'default-observer',
    'Caroline LGBTQ support group impact and counseling career direction',
    'Caroline attended an LGBTQ support group on 7 May 2023. The group made Caroline feel accepted and gave her courage to embrace herself. Caroline plans to continue education and explore counseling or mental health work.',
    [],
    1,
    '2024-01-01T00:00:00Z',
  );

  assert.doesNotMatch(thread.title, /\.\.\.$/);
  assert.doesNotMatch(thread.summary, /\.\.\.$/);
});
```

- [ ] **Step 2: Run the targeted test to verify it fails**

Run: `node --test --test-name-pattern 'createObservingThread preserves complete readable title and summary text' packages/core/test/client-internals.test.mjs`
Expected: FAIL because `thread.ts` still clips long title / summary text.

- [ ] **Step 3: Remove final storage clipping in `thread.ts`**

Change final normalization to collapse whitespace only:

```ts
function normalizeTitle(value: string): string {
  return normalizeText(value);
}

function normalizeSummary(value: string): string {
  return normalizeText(value);
}
```

```ts
function normalizeText(value: string): string {
  return value.split(/\s+/).join(' ').trim();
}
```

- [ ] **Step 4: Keep input-side clipping only where it protects prompt payload size**

In `packages/core/src/llm/observing-gateway.ts`, keep bounded normalization for:
- gateway updates
- `why`
- memory text
- list items

But stop clipping the final validated `observingContentUpdate.title` and `observingContentUpdate.summary` before persistence:

```ts
const title = normalizeText(result.observingContentUpdate.title);
const summary = normalizeText(result.observingContentUpdate.summary);
```

- [ ] **Step 5: Run the targeted readability test again**

Run: `node --test --test-name-pattern 'createObservingThread preserves complete readable title and summary text' packages/core/test/client-internals.test.mjs`
Expected: PASS

- [ ] **Step 6: Run the full core node test suite**

Run: `pnpm --filter @muninn/core test:node`
Expected: PASS with all existing `@muninn/core` node tests green.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/observer/thread.ts packages/core/src/llm/observing-gateway.ts packages/core/test/client-internals.test.mjs
git commit -m "fix: keep observing titles and summaries readable"
```

## Task 4: Manual Validation on the Existing LoCoMo Slice

**Files:**
- Modify: none required
- Read: `benchmark/locomo/out/conv-26-session-1.slice.json`
- Output: `benchmark/locomo/out/conv-26-session-1.observing-v4.real*.json`

- [ ] **Step 1: Build the core package before rerunning the benchmark**

Run: `pnpm --filter @muninn/core build`
Expected: PASS

- [ ] **Step 2: Rerun the existing small real slice**

Run:

```bash
MUNINN_HOME=/Users/Nathan/workspace/muninn python3 benchmark/locomo/run.py \
  --data-file benchmark/locomo/out/conv-26-session-1.slice.json \
  --out-file benchmark/locomo/out/conv-26-session-1.observing-v4.real.json \
  --progress-file benchmark/locomo/out/conv-26-session-1.observing-v4.real.progress.jsonl \
  --sample-id conv-26 \
  --top-k 5 \
  --keep-home \
  --mode diagnostic \
  --answerer llm \
  --expand-references
```

Expected: PASS after several minutes, producing a new `observing-v4` output set.

- [ ] **Step 3: Inspect the latest observing snapshots directly from the preserved run home**

Run:

```bash
node -e 'process.env.MUNINN_HOME="/Users/Nathan/workspace/muninn/benchmark/locomo/.runs/conv-26"; import("./packages/core/dist/index.js").then(async core=>{ const rows=await core.observings.list({mode:{type:"recency",limit:50}}); console.log(JSON.stringify(rows.map(r=>({snapshotId:r.snapshotId,title:r.title,summary:r.summary,references:r.references,content:JSON.parse(r.content)})),null,2)); await core.shutdownCoreForTests(); })'
```

Expected review points:
- still two main threads
- D1:12 content is split differently across the two threads
- Caroline thread no longer centers Melanie painting
- painting thread no longer centers Caroline career/support-group state
- titles are short and readable
- summaries are complete and no longer end in `...`
- transcript-like memories are materially reduced

- [ ] **Step 4: Commit**

This validation step does not require a commit if no code changes were needed. If fixture/test adjustments were made during verification, commit them separately with a focused message.

## Task 5: Final Verification

**Files:**
- Modify: none
- Test: all changed observing-side files

- [ ] **Step 1: Run the prompt tests**

Run: `node --test packages/core/test/prompt-loader.test.mjs`
Expected: PASS

- [ ] **Step 2: Run the targeted internal regression tests**

Run:

```bash
node --test --test-name-pattern 'applyGatewayUpdates preserves per-thread sliced summaries for the same turn|createObservingThread preserves complete readable title and summary text' packages/core/test/client-internals.test.mjs
```

Expected: PASS

- [ ] **Step 3: Run the full core node suite**

Run: `pnpm --filter @muninn/core test:node`
Expected: PASS

- [ ] **Step 4: Record the manual benchmark outcome**

Capture in the final handoff:
- whether the two-thread split remained
- whether titles/summaries improved
- whether transcript-like memories dropped
- any remaining leakage that still needs a follow-up pass
