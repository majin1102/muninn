# Observing Snapshot Observations Routing Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename observing snapshot internals to observations, persist bounded thread-local routed turn slices, and use the latest slice as gateway continuity context without polluting semantic recall.

**Architecture:** Keep public memory APIs unchanged while changing only the observing snapshot content schema and direct observer pipeline. Gateway keeps producing route updates with `why`, but only `summary` enters observer state; `why` is exposed to LoCoMo through a temporary JSONL trace file when explicitly enabled.

**Tech Stack:** TypeScript, Node test runner, YAML prompt templates, Python unittest, LoCoMo benchmark harness

---

## File Map

- Modify: `packages/core/src/observer/types.ts`
  - Rename snapshot internals to `Observation`, `ObservationCategory`, `observations`, and `observationDelta`.
  - Add `ObservedTurnSlice`.
  - Remove `whyRelated` from `ObservingTurnInput`.
  - Add `continuityHint?: string` to `ObservingThreadGatewayInput`.
- Modify: `packages/core/src/config.ts`
  - Add `observer.contextTurns` with default `8`.
  - Return it from `getObserverLlmConfig`.
  - Validate it as an optional positive integer.
- Modify: `packages/core/src/observer/thread.ts`
  - Serialize, deserialize, clone, and expose `observations`, `observationDelta`, and bounded `turns`.
  - Merge routed slices into each new snapshot.
- Modify: `packages/core/src/observer/memory-delta.ts`
  - Rename internal observation delta helpers while keeping semantic index behavior unchanged.
- Modify: `packages/core/src/observer/update.ts`
  - Preserve `GatewayUpdate.summary` into observer input.
  - Persist routed slices into `SnapshotContent.turns`.
  - Pass `observer.contextTurns`.
  - Export `applyGatewayUpdates` in `__testing`.
- Modify: `packages/core/src/session/session.ts`
  - Attach non-persisted previous-turn context to the returned observable `SessionTurn`.
- Modify: `packages/core/src/session/types.ts`
  - Ensure serialization ignores the transient previous-turn context.
- Modify: `packages/core/src/llm/observing-gateway.ts`
  - Feed `continuityHint` and pending-turn previous context to gateway.
  - Rename observer schema to observations/observationDelta.
  - Keep `GatewayUpdate.why` validated but do not pass it to observer.
- Modify: `packages/core/prompts/observing.yaml`
  - Rename schema wording from memories/memoryDelta to observations/observationDelta.
  - Remove `whyRelated`.
- Modify: `packages/core/prompts/observing-gateway.yaml`
  - Document `continuityHint` and previous turn context as reference-only continuity signals.
- Modify: `packages/core/test/prompt-loader.test.mjs`
  - Lock prompt schema and continuity rules.
- Modify: `packages/core/test/client-internals.test.mjs`
  - Add data-flow and snapshot persistence regression tests.
- Modify: `benchmark/locomo/src/bridge.ts`
  - Enable a per-import gateway JSONL trace file and expose the path.
- Modify: `benchmark/locomo/run.py`
  - Read the gateway trace and include per-hit routing `why` in the final trace when available.
- Modify: `benchmark/locomo/tests/test_answering.py`, `benchmark/locomo/tests/test_run.py`, or `benchmark/locomo/tests/test_scoring.py`
  - Add focused assertions for benchmark trace visibility.

## Task 1: Lock the New Snapshot and Prompt Schema With Failing Tests

**Files:**
- Modify: `packages/core/test/prompt-loader.test.mjs`
- Test: `packages/core/test/prompt-loader.test.mjs`

- [ ] **Step 1: Update the observing schema prompt test to expect observation names**

Replace the current `observing prompt preserves the current memory schema` assertions with the observation schema contract:

```js
test('observing prompt preserves the current observation schema', () => {
  const template = loadPromptTemplate('observing');
  const system = template.system;

  for (const category of ['Preference', 'Fact', 'Decision', 'Entity', 'Concept', 'Other']) {
    assert.match(system, new RegExp(`\\\`${category}\\\``));
  }
  assert.doesNotMatch(system, /"category": "Goal"/);
  assert.doesNotMatch(system, /`Goal`/);
  assert.match(system, /observations/);
  assert.match(system, /observationDelta\.before/);
  assert.match(system, /observationDelta\.after/);
  assert.match(system, /Preserve `id` for existing observations/);
  assert.doesNotMatch(system, /whyRelated/);
  assert.doesNotMatch(system, /memoryDelta\.before/);
});
```

- [ ] **Step 2: Add a gateway prompt continuity contract test**

Add this test to the same file:

```js
test('observing gateway prompt constrains continuity hints', () => {
  const template = loadPromptTemplate('observing_gateway');
  const system = template.system;

  assert.match(system, /continuityHint/);
  assert.match(system, /only to judge semantic continuity/);
  assert.match(system, /Do not copy, restate, route, or observe/);
  assert.match(system, /previousTurn/);
  assert.match(system, /reference context/);
});
```

- [ ] **Step 3: Run the prompt tests and verify failure**

Run: `pnpm --filter @muninn/core build && node --test packages/core/test/prompt-loader.test.mjs`

Expected: FAIL because prompts still use `memories`, `memoryDelta`, and `whyRelated`, and gateway prompt does not mention `continuityHint`.

## Task 2: Rename Snapshot Types and Observer LLM Schema

**Files:**
- Modify: `packages/core/src/observer/types.ts`
- Modify: `packages/core/src/llm/observing-gateway.ts`
- Modify: `packages/core/prompts/observing.yaml`
- Test: `packages/core/test/prompt-loader.test.mjs`

- [ ] **Step 1: Rename observer types**

In `packages/core/src/observer/types.ts`, replace the memory-specific names at the snapshot layer:

```ts
export type ObservationCategory = 'Preference' | 'Fact' | 'Decision' | 'Entity' | 'Concept' | 'Other';

export type Observation = {
  id?: string | null;
  text: string;
  category: ObservationCategory;
  updatedMemory?: string | null;
};

export type ObservedTurnSlice = {
  turnId: string;
  summary: string;
};

export type SnapshotContent = {
  observations: Observation[];
  turns: ObservedTurnSlice[];
  openQuestions?: string[];
  nextSteps?: string[];
  observationDelta: LlmFieldUpdate<Observation>;
};
```

Update dependent types in the same file:

```ts
export type ObservingTurnInput = {
  turnId: string;
  summary: string;
};

export type ObservingContent = {
  title: string;
  summary: string;
  observations: Observation[];
  openQuestions: string[];
  nextSteps: string[];
};

export type ObserveResult = {
  observingContentUpdate: ObservingContentUpdate;
  observationDelta: LlmFieldUpdate<Observation>;
};
```

- [ ] **Step 2: Update the observer prompt schema**

In `packages/core/prompts/observing.yaml`, change the LLM-facing schema:

```yaml
  Thread fields:
  - `title`: compact label for this observing thread.
  - `summary`: concise aggregate narrative of the thread.
  - `observations`: durable structured conclusions currently held by this observing thread.
  - `openQuestions`: unresolved questions that remain live; remove resolved ones. Do not keep questions that have already been answered by the current or later pending turns.
  - `nextSteps`: concrete next actions still worth tracking.
  - `observationDelta.before` / `observationDelta.after`: only observations changed by the pending turns.
```

Change the returned JSON example to:

```json
{
  "observingContentUpdate": {
    "title": "string",
    "summary": "string",
    "openQuestions": ["string"],
    "nextSteps": ["string"]
  },
  "observationDelta": {
    "before": [
      {
        "id": "string",
        "text": "string",
        "category": "Preference|Fact|Decision|Entity|Concept|Other"
      }
    ],
    "after": [
      {
        "id": "string",
        "text": "string",
        "category": "Preference|Fact|Decision|Entity|Concept|Other"
      }
    ]
  }
}
```

Also replace wording such as `memory`, `memories`, and `memoryDelta` in this prompt only when it refers to snapshot-level observations. Keep product-level phrases such as "observing memory system" if they describe the overall system.

- [ ] **Step 3: Update `observeThread` JSON input and retry text**

In `packages/core/src/llm/observing-gateway.ts`, change the observer input JSON:

```ts
const inputJson = JSON.stringify(
  {
    observingContent: {
      title: input.observingContent.title,
      summary: input.observingContent.summary,
      observations: input.observingContent.observations,
      openQuestions: input.observingContent.openQuestions,
      nextSteps: input.observingContent.nextSteps,
    },
    pendingTurns: input.pendingTurns.map((turn) => ({
      turnId: turn.turnId,
      summary: turn.summary,
    })),
  },
  null,
  2,
);
```

Change retry text to:

```ts
'Keep all required content fields and observationDelta arrays present.'
```

- [ ] **Step 4: Update mock and validation result names**

In `buildMockObserveResult`, return `observationDelta`:

```ts
return {
  observingContentUpdate: {
    title: normalizeText(titleSeed),
    summary: normalizeText(summarySeed || titleSeed),
    openQuestions: input.observingContent.openQuestions,
    nextSteps: input.observingContent.nextSteps,
  },
  observationDelta: {
    before: [],
    after: joined ? [{
      text: joined,
      category: 'Fact',
      updatedMemory: null,
    }] : [],
  },
};
```

In `validateObserveResult`, normalize `result.observationDelta.before` and `result.observationDelta.after`.

- [ ] **Step 5: Run targeted prompt tests**

Run: `pnpm --filter @muninn/core build && node --test packages/core/test/prompt-loader.test.mjs`

Expected: PASS.

## Task 3: Add Observer Context-Turn Configuration

**Files:**
- Modify: `packages/core/src/config.ts`
- Modify: `packages/core/test/client-internals.test.mjs`
- Test: `packages/core/test/client-internals.test.mjs`

- [ ] **Step 1: Add config tests**

Add a focused test near existing config tests in `packages/core/test/client-internals.test.mjs`:

```js
test('observer config exposes contextTurns with default and explicit values', async (t) => {
  const home = await makeConfigHome();
  t.after(async () => {
    await rm(home.dir, { recursive: true, force: true });
    delete process.env.MUNINN_HOME;
  });
  process.env.MUNINN_HOME = home.dir;

  await writeFile(path.join(home.dir, 'muninn.json'), JSON.stringify({
    observer: { name: 'observer-a', llm: 'mock-observer' },
    llm: { 'mock-observer': { provider: 'mock' } },
    semanticIndex: { embedding: { provider: 'mock' } },
  }));
  assert.equal(getObserverLlmConfig().contextTurns, 8);

  await writeFile(path.join(home.dir, 'muninn.json'), JSON.stringify({
    observer: { name: 'observer-a', llm: 'mock-observer', contextTurns: 3 },
    llm: { 'mock-observer': { provider: 'mock' } },
    semanticIndex: { embedding: { provider: 'mock' } },
  }));
  assert.equal(getObserverLlmConfig().contextTurns, 3);
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `pnpm --filter @muninn/core build && node --test --test-name-pattern 'observer config exposes contextTurns' packages/core/test/client-internals.test.mjs`

Expected: FAIL because `contextTurns` is not defined.

- [ ] **Step 3: Add config field and default**

In `packages/core/src/config.ts`, add:

```ts
const DEFAULT_OBSERVER_CONTEXT_TURNS = 8;
```

Extend `ObserverConfigRecord`:

```ts
type ObserverConfigRecord = {
  name: string;
  llm: string;
  maxAttempts?: number;
  activeWindowDays?: number;
  contextTurns?: number;
};
```

Extend `ObserverLlmConfig`:

```ts
export type ObserverLlmConfig = TextProviderConfig & {
  name: string;
  maxAttempts: number;
  activeWindowDays: number;
  contextTurns: number;
};
```

Return the value from `getObserverLlmConfig`:

```ts
contextTurns: observer.contextTurns ?? DEFAULT_OBSERVER_CONTEXT_TURNS,
```

Validate it in `validateObserverConfig`:

```ts
validateOptionalPositiveInteger(config.contextTurns, 'observer.contextTurns');
```

- [ ] **Step 4: Run the config test**

Run: `pnpm --filter @muninn/core build && node --test --test-name-pattern 'observer config exposes contextTurns' packages/core/test/client-internals.test.mjs`

Expected: PASS.

## Task 4: Persist Bounded Routed Turn Slices in Snapshots

**Files:**
- Modify: `packages/core/src/observer/thread.ts`
- Modify: `packages/core/src/observer/memory-delta.ts`
- Modify: `packages/core/src/observer/update.ts`
- Modify: `packages/core/test/client-internals.test.mjs`
- Test: `packages/core/test/client-internals.test.mjs`

- [ ] **Step 1: Add snapshot turns window regression test**

Add a test near existing `flushThreads` / snapshot tests:

```js
test('observing snapshots keep a bounded cumulative routed turn slice window', () => {
  const thread = createObservingThread('observer-a', 'Career', 'Career thread', [], 1, '2026-01-01T00:00:00.000Z');
  const result = (summary) => ({
    observingContentUpdate: {
      title: 'Career',
      summary,
      openQuestions: [],
      nextSteps: [],
    },
    observationDelta: {
      before: [],
      after: [{ text: summary, category: 'Fact', updatedMemory: null }],
    },
  });

  for (let index = 1; index <= 10; index += 1) {
    threadModule.__testing.applyObserveResultForTests(
      thread,
      result(`slice ${index}`),
      index,
      [{ turnId: `session:${index}`, summary: `slice ${index}` }],
      8,
    );
  }

  const latest = thread.snapshots[thread.snapshots.length - 1];
  assert.deepEqual(latest.turns.map((turn) => turn.turnId), [
    'session:3',
    'session:4',
    'session:5',
    'session:6',
    'session:7',
    'session:8',
    'session:9',
    'session:10',
  ]);
});
```

If `threadModule.__testing` does not exist, add it in the implementation step below.

- [ ] **Step 2: Run the test and verify failure**

Run: `pnpm --filter @muninn/core build && node --test --test-name-pattern 'bounded cumulative routed turn slice window' packages/core/test/client-internals.test.mjs`

Expected: FAIL because `turns`, `observationDelta`, and the test helper do not exist.

- [ ] **Step 3: Rename delta helper**

In `packages/core/src/observer/memory-delta.ts`, rename exported helper and types:

```ts
export function applyObservationDelta(
  currentObservations: Observation[],
  result: ObserveResult,
): {
  observationDelta: LlmFieldUpdate<Observation>;
  observations: Observation[];
} {
  const before = result.observationDelta.before;
  const after = materializeObservationIds(result.observationDelta.after);
  // keep the existing merge/delete logic, replacing memory variable names with observation names
}
```

Keep the file name for now to avoid a broad module rename. Update `applySemanticMemoryDelta` to read:

```ts
const delta = snapshot.observationDelta;
```

and otherwise keep semantic indexing behavior unchanged.

- [ ] **Step 4: Update thread snapshot handling**

In `packages/core/src/observer/thread.ts`, update `currentObservingContent`:

```ts
return {
  title: thread.title,
  summary: thread.summary,
  observations: snapshot.observations,
  openQuestions: snapshot.openQuestions ?? [],
  nextSteps: snapshot.nextSteps ?? [],
};
```

Change `applyObserveResult` to accept turn slices and a limit:

```ts
export function applyObserveResult(
  thread: ObservingThread,
  result: ObserveResult,
  observingEpoch: number,
  applyObservationDelta: (
    observations: Observation[],
    result: ObserveResult,
  ) => { observationDelta: SnapshotContent['observationDelta']; observations: Observation[] },
  turnSlices: ObservedTurnSlice[] = [],
  contextTurns = 8,
  now = new Date().toISOString(),
): void {
  const current = latestSnapshot(thread) ?? emptySnapshot();
  const patched = applyObservationDelta(current.observations, result);
  thread.title = result.observingContentUpdate.title;
  thread.summary = result.observingContentUpdate.summary;
  thread.observingEpoch = observingEpoch;
  thread.snapshots.push({
    observations: patched.observations,
    turns: mergeTurnSlices(current.turns ?? [], turnSlices, contextTurns),
    openQuestions: result.observingContentUpdate.openQuestions,
    nextSteps: result.observingContentUpdate.nextSteps,
    observationDelta: patched.observationDelta,
  });
  thread.snapshotEpochs = [...(thread.snapshotEpochs ?? []), observingEpoch];
  thread.snapshotId = undefined;
  thread.updatedAt = now;
}
```

Add the merge helper:

```ts
function mergeTurnSlices(
  current: ObservedTurnSlice[],
  next: ObservedTurnSlice[],
  limit: number,
): ObservedTurnSlice[] {
  const merged = [...current];
  for (const slice of next) {
    const summary = normalizeText(slice.summary);
    if (!summary) {
      continue;
    }
    const existingIndex = merged.findIndex((item) => item.turnId === slice.turnId);
    const normalized = { turnId: slice.turnId, summary };
    if (existingIndex >= 0) {
      merged.splice(existingIndex, 1);
    }
    merged.push(normalized);
  }
  return merged.slice(Math.max(merged.length - limit, 0));
}
```

Update `deserializeSnapshot` and `emptySnapshot`:

```ts
return {
  observations: Array.isArray(parsed.observations) ? parsed.observations as Observation[] : [],
  turns: Array.isArray(parsed.turns) ? parsed.turns as ObservedTurnSlice[] : [],
  openQuestions: Array.isArray(parsed.openQuestions) ? parsed.openQuestions : [],
  nextSteps: Array.isArray(parsed.nextSteps) ? parsed.nextSteps : [],
  observationDelta: {
    before: Array.isArray(parsed.observationDelta?.before) ? parsed.observationDelta!.before : [],
    after: Array.isArray(parsed.observationDelta?.after) ? parsed.observationDelta!.after : [],
  },
};
```

Expose a test helper:

```ts
export const __testing = {
  applyObserveResultForTests: applyObserveResult,
};
```

- [ ] **Step 5: Run the snapshot window test**

Run: `pnpm --filter @muninn/core build && node --test --test-name-pattern 'bounded cumulative routed turn slice window' packages/core/test/client-internals.test.mjs`

Expected: PASS.

## Task 5: Preserve Gateway Slices and Remove `whyRelated` From Observer Input

**Files:**
- Modify: `packages/core/src/observer/update.ts`
- Modify: `packages/core/src/llm/observing-gateway.ts`
- Modify: `packages/core/test/client-internals.test.mjs`
- Test: `packages/core/test/client-internals.test.mjs`

- [ ] **Step 1: Add regression test for sliced summaries**

Add this test:

```js
test('applyGatewayUpdates sends routed update summaries to observer and stores slices', async () => {
  const now = '2026-01-01T00:00:00.000Z';
  const career = createObservingThread('observer-a', 'Career', 'Career thread', [], 1, now);
  const painting = createObservingThread('observer-a', 'Painting', 'Painting thread', [], 1, now);
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
      observationDelta: { before: [], after: [] },
    };
  };

  await updateTesting.applyGatewayUpdatesForTests({
    threads: [career, painting],
    observerName: 'observer-a',
    pendingTurns: [{
      turnId: 'session:12',
      createdAt: now,
      updatedAt: now,
      sessionId: 'locomo',
      agent: 'Melanie',
      observer: 'observer-a',
      title: 'mixed',
      summary: 'Melanie praised Caroline as a counselor and shared a lake painting.',
      prompt: 'raw mixed prompt',
      response: 'raw mixed response',
      observingEpoch: 2,
    }],
    observingEpoch: 2,
    updates: [
      {
        turnId: 'session:12',
        action: 'append',
        observingId: career.observingId,
        summary: 'Melanie said Caroline would be a great counselor.',
        newThread: null,
        why: 'career',
      },
      {
        turnId: 'session:12',
        action: 'append',
        observingId: painting.observingId,
        summary: 'Melanie shared a lake painting.',
        newThread: null,
        why: 'painting',
      },
    ],
    contextTurns: 8,
    observeThreadImpl,
  });

  assert.deepEqual(observedInputs.map((input) => input.pendingTurns), [
    [{ turnId: 'session:12', summary: 'Melanie said Caroline would be a great counselor.' }],
    [{ turnId: 'session:12', summary: 'Melanie shared a lake painting.' }],
  ]);
  assert.deepEqual(career.snapshots.at(-1).turns, [
    { turnId: 'session:12', summary: 'Melanie said Caroline would be a great counselor.' },
  ]);
  assert.deepEqual(painting.snapshots.at(-1).turns, [
    { turnId: 'session:12', summary: 'Melanie shared a lake painting.' },
  ]);
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `pnpm --filter @muninn/core build && node --test --test-name-pattern 'sends routed update summaries' packages/core/test/client-internals.test.mjs`

Expected: FAIL because `applyGatewayUpdatesForTests` does not exist and `whyRelated` is still part of observer input.

- [ ] **Step 3: Refactor `applyGatewayUpdates` to accept a parameter object**

Change the helper signature to:

```ts
type ApplyGatewayUpdatesParams = {
  threads: ObservingThread[];
  observerName: string;
  pendingTurns: SessionTurn[];
  observingEpoch: number;
  updates: GatewayUpdate[];
  contextTurns: number;
  signal?: AbortSignal;
  observeThreadImpl?: typeof observeThread;
};
```

Implement it so `observeTurn.summary` comes from `update.summary`:

```ts
const observeTurn = {
  turnId: turn.turnId,
  summary: normalizeText(update.summary, 220),
};
```

Call `applyObserveResult` with the routed slices and config limit:

```ts
const turnSlices = [...turnsById.values()].map((turn) => ({
  turnId: turn.turnId,
  summary: turn.summary,
}));
applyObserveResult(
  thread,
  result,
  observingEpoch,
  applyObservationDelta,
  turnSlices,
  contextTurns,
);
```

Export it for tests:

```ts
export const __testing = {
  flushThreads,
  buildTouchedIndex,
  buildSemanticIndex,
  observeEpoch,
  applyGatewayUpdatesForTests: applyGatewayUpdates,
};
```

- [ ] **Step 4: Update `observeEpoch` to pass config contextTurns**

Read config once through `getObserverLlmConfig()` or pass `contextTurns` down from the caller. The minimal implementation inside `observeEpoch` is:

```ts
const observerConfig = getObserverLlmConfig();
const contextTurns = observerConfig?.contextTurns ?? 8;
```

Then call:

```ts
const touchedIds = await applyGatewayUpdates({
  threads: params.threads,
  observerName: params.observerName,
  pendingTurns: params.sealedEpoch.turns,
  observingEpoch: params.sealedEpoch.epoch,
  updates: gatewayResult.updates,
  contextTurns,
  signal: params.signal,
});
```

- [ ] **Step 5: Run the sliced-summary test**

Run: `pnpm --filter @muninn/core build && node --test --test-name-pattern 'sends routed update summaries' packages/core/test/client-internals.test.mjs`

Expected: PASS.

## Task 6: Add Continuity Hint and Previous-Turn Context to Gateway Input

**Files:**
- Modify: `packages/core/src/session/session.ts`
- Modify: `packages/core/src/session/types.ts`
- Modify: `packages/core/src/backend.ts`
- Modify: `packages/core/src/observer/update.ts`
- Modify: `packages/core/src/llm/observing-gateway.ts`
- Modify: `packages/core/prompts/observing-gateway.yaml`
- Modify: `packages/core/test/client-internals.test.mjs`
- Test: `packages/core/test/client-internals.test.mjs`

- [ ] **Step 1: Add a gateway input test**

Add a test that injects the gateway builder or calls a test helper:

```js
test('gateway input includes continuity hint and transient previous turn context', () => {
  const thread = createObservingThread('observer-a', 'Career', 'Career thread', [], 1, '2026-01-01T00:00:00.000Z');
  thread.snapshots.push({
    observations: [],
    turns: [{ turnId: 'session:11', summary: 'Caroline is considering counseling work.' }],
    openQuestions: [],
    nextSteps: [],
    observationDelta: { before: [], after: [] },
  });

  const input = updateTesting.activeGatewayInputsForTests([thread], 'observer-a', 7);
  assert.equal(input[0].continuityHint, 'Caroline is considering counseling work.');

  const turns = updateTesting.gatewayTurnsForTests([{
    turnId: 'session:12',
    summary: 'Melanie encouraged Caroline.',
    previousTurnSummary: 'Caroline said she is keen on counseling or mental health.',
  }]);
  assert.deepEqual(turns[0], {
    turnId: 'session:12',
    summary: 'Melanie encouraged Caroline.',
    previousTurn: 'Caroline said she is keen on counseling or mental health.',
  });
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `pnpm --filter @muninn/core build && node --test --test-name-pattern 'continuity hint' packages/core/test/client-internals.test.mjs`

Expected: FAIL because helper exports and fields do not exist.

- [ ] **Step 3: Add transient previous-turn context**

In `packages/core/src/backend.ts`, extend `SessionTurn`:

```ts
previousTurnSummary?: string | null;
```

In `packages/core/src/session/session.ts`, before building the new turn:

```ts
const previousTurnSummary = summarizeRecentTurn(this.recentTurns.at(-1));
```

After reading the persisted row, return a non-persisted copy:

```ts
const observableTurn = previousTurnSummary
  ? { ...persisted, previousTurnSummary }
  : persisted;
this.rememberTurn(persisted);
return {
  turn: observableTurn,
  deduped: false,
};
```

Add helper:

```ts
function summarizeRecentTurn(turn: RecentTurn | undefined): string | null {
  if (!turn) {
    return null;
  }
  const text = [turn.prompt, turn.response]
    .filter((value) => value && value.trim())
    .join('\nResponse: ')
    .split(/\s+/)
    .join(' ')
    .trim();
  return text || null;
}
```

In `packages/core/src/session/types.ts`, do not serialize `previousTurnSummary`; `readSessionTurn` should leave it absent.

- [ ] **Step 4: Add continuity hint to gateway thread input**

In `activeGatewayInputs`, include latest slice:

```ts
continuityHint: latestSnapshot(thread)?.turns?.at(-1)?.summary,
```

Export `activeGatewayInputsForTests` in `update.ts` `__testing`.

- [ ] **Step 5: Build gateway pending turns with previous context**

In `packages/core/src/llm/observing-gateway.ts`, create a helper:

```ts
function toGatewayTurns(pendingTurns: SessionTurn[]) {
  return pendingTurns.map((turn) => ({
    turnId: turn.turnId,
    summary: turn.summary ?? turn.prompt ?? turn.response ?? '',
    previousTurn: turn.previousTurnSummary ?? undefined,
  }));
}
```

Use it in `routeObservingThreads`. When rendering JSON:

```ts
pendingTurns: gatewayTurns.map((turn) => ({
  turnId: turn.turnId,
  summary: turn.summary,
  ...(turn.previousTurn ? { previousTurn: turn.previousTurn } : {}),
})),
```

For threads:

```ts
observingThreads: observingThreads.map((thread) => ({
  observingId: thread.observingId,
  title: thread.title,
  summary: thread.summary,
  ...(thread.continuityHint ? { continuityHint: thread.continuityHint } : {}),
})),
```

Export the gateway-turn helper through `__testing` if direct testing is simpler.

- [ ] **Step 6: Update gateway prompt**

In `packages/core/prompts/observing-gateway.yaml`, add fields:

```yaml
  1. current observing threads, each with:
  - observingId
  - title
  - summary
  - continuityHint: optional latest routed slice previously consumed by this thread

  2. pending turns, each with:
  - turnId
  - summary
  - previousTurn: optional previous conversation turn, provided only as reference context
```

Add constraint:

```yaml
  Continuity context:
  - Use `continuityHint` only to judge semantic continuity between the pending turn and the thread.
  - Use `previousTurn` only to understand short replies or continuation context in the pending turn.
  - Do not copy, restate, route, or observe `continuityHint` or `previousTurn` as new information.
```

- [ ] **Step 7: Run continuity tests and prompt tests**

Run: `pnpm --filter @muninn/core build && node --test --test-name-pattern 'continuity hint' packages/core/test/client-internals.test.mjs && node --test packages/core/test/prompt-loader.test.mjs`

Expected: PASS.

## Task 7: Keep Gateway `why` Out of Snapshot Storage but Expose It to LoCoMo Trace

**Files:**
- Modify: `packages/core/src/observer/update.ts`
- Create or modify: `packages/core/src/observer/gateway-trace.ts`
- Modify: `benchmark/locomo/src/bridge.ts`
- Modify: `benchmark/locomo/run.py`
- Modify: `benchmark/locomo/tests/test_run.py`
- Test: `benchmark/locomo/tests/test_run.py`

- [ ] **Step 1: Add benchmark trace test**

Add a Python test that passes a small gateway trace payload into the trace builder and asserts `gateway_routes` is present:

```python
def test_build_trace_includes_gateway_routes_when_available(self) -> None:
    sample = {
        "sample_id": "conv-a",
        "qa": [{
            "question": "What did Caroline pursue?",
            "answer": "counseling",
            "category": 3,
            "evidence": [],
            "muninn_top_5_prediction": "counseling",
            "muninn_top_5_heuristic_prediction": "counseling",
            "muninn_top_5_hits": [{
                "memory_id": "observing:1",
                "matched_text": "Caroline is interested in counseling.",
                "evidence_ids": ["D1:11"],
                "references": [],
            }],
        }],
    }
    trace = build_trace([sample], "muninn_top_5", gateway_routes={
        "observing:1": [{
            "turnId": "session:11",
            "summary": "Caroline is interested in counseling.",
            "why": "career continuation",
        }]
    })
    self.assertEqual(trace["samples"][0]["qa"][0]["hits"][0]["gateway_routes"][0]["why"], "career continuation")
```

- [ ] **Step 2: Run the test and verify failure**

Run: `python3 -m unittest benchmark.locomo.tests.test_run -k gateway_routes`

Expected: FAIL because `build_trace` does not accept `gateway_routes`.

- [ ] **Step 3: Add explicit gateway trace JSONL writer in core**

Create `packages/core/src/observer/gateway-trace.ts`:

```ts
import { appendFile } from 'node:fs/promises';

import type { GatewayUpdate } from './types.js';

export async function writeGatewayTrace(event: {
  observingEpoch: number;
  updates: GatewayUpdate[];
}): Promise<void> {
  const file = process.env.MUNINN_OBSERVER_GATEWAY_TRACE_FILE;
  if (!file) {
    return;
  }
  const line = `${JSON.stringify({
    observingEpoch: event.observingEpoch,
    updates: event.updates.map((update) => ({
      turnId: update.turnId,
      action: update.action,
      observingId: update.observingId ?? null,
      summary: update.summary,
      why: update.why,
    })),
  })}\n`;
  await appendFile(file, line, 'utf8');
}
```

In `observeEpoch`, after `gatewayResult` is returned and before applying updates:

```ts
await writeGatewayTrace({
  observingEpoch: params.sealedEpoch.epoch,
  updates: gatewayResult.updates,
});
```

Do not call this from tests unless the env var is set.

- [ ] **Step 4: Set trace file during LoCoMo import**

In `benchmark/locomo/src/bridge.ts`, when running `import-sample`, set:

```ts
const gatewayTracePath = path.join(home, 'locomo-gateway-trace.jsonl');
process.env.MUNINN_OBSERVER_GATEWAY_TRACE_FILE = gatewayTracePath;
```

Return it:

```ts
return {
  sample_id: sample.sample_id,
  imported_count: manifestTurns.length,
  manifest_path: manifestPath(home),
  gateway_trace_path: gatewayTracePath,
};
```

- [ ] **Step 5: Read gateway routes in Python trace**

In `benchmark/locomo/run.py`, change signature:

```python
def build_trace(
    samples: list[dict[str, Any]],
    model_key: str,
    gateway_routes: dict[str, list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
```

Pass `gateway_routes` to `build_qa_trace`.

In `benchmark/locomo/answering.py`, extend `build_qa_trace`:

```python
def build_qa_trace(
    *,
    sample_id: str,
    qa_index: int,
    qa: dict[str, Any],
    query_candidates: list[str],
    prediction_key: str,
    heuristic_key: str,
    gateway_routes: dict[str, list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    hits = qa.get(f"{prediction_key.removesuffix('_prediction')}_hits", [])
    if gateway_routes:
        for hit in hits:
            memory_id = str(hit.get("memory_id", ""))
            routes = gateway_routes.get(memory_id)
            if routes:
                hit["gateway_routes"] = routes
```

Return `hits` in the trace row instead of re-reading from `qa`.

- [ ] **Step 6: Parse the JSONL file**

Add in `benchmark/locomo/run.py`:

```python
def load_gateway_routes(path: Path | None) -> dict[str, list[dict[str, Any]]]:
    if path is None or not path.exists():
        return {}
    routes: dict[str, list[dict[str, Any]]] = {}
    for line in path.read_text(encoding="utf8").splitlines():
        if not line.strip():
            continue
        event = json.loads(line)
        for update in event.get("updates", []):
            observing_id = update.get("observingId")
            if not observing_id:
                continue
            routes.setdefault(str(observing_id), []).append({
                "turnId": update.get("turnId"),
                "summary": update.get("summary"),
                "why": update.get("why"),
            })
    return routes
```

Use the `gateway_trace_path` returned by `import-sample` to load routes before calling `write_trace`.

- [ ] **Step 7: Run benchmark trace tests**

Run: `python3 -m unittest benchmark.locomo.tests.test_run -k gateway_routes`

Expected: PASS.

## Task 8: Update Existing Tests for Observation Schema

**Files:**
- Modify: `packages/core/test/client-internals.test.mjs`
- Modify: `packages/core/test/client.test.mjs`
- Test: `packages/core/test/client-internals.test.mjs`, `packages/core/test/client.test.mjs`

- [ ] **Step 1: Replace test fixtures**

Replace fixture objects like:

```js
{ memories: [], openQuestions: [], nextSteps: [], memoryDelta: { before: [], after: [] } }
```

with:

```js
{ observations: [], turns: [], openQuestions: [], nextSteps: [], observationDelta: { before: [], after: [] } }
```

Replace expected semantic index fixture references to `memoryDelta` with `observationDelta`.

- [ ] **Step 2: Run core internals tests**

Run: `pnpm --filter @muninn/core build && node --test packages/core/test/client-internals.test.mjs`

Expected: PASS.

- [ ] **Step 3: Run public client tests**

Run: `node --test packages/core/test/client.test.mjs`

Expected: PASS. Public test names may still say "memory" because public APIs remain memory-oriented.

## Task 9: Full Verification and Small LoCoMo Slice

**Files:**
- No planned source edits unless tests reveal implementation mistakes.
- Test: core Node tests, LoCoMo Python tests, small LoCoMo slice.

- [ ] **Step 1: Run core package tests**

Run: `pnpm --filter @muninn/core test`

Expected: PASS.

- [ ] **Step 2: Run LoCoMo unit tests**

Run: `python3 -m unittest benchmark.locomo.tests.test_answering benchmark.locomo.tests.test_run benchmark.locomo.tests.test_scoring`

Expected: PASS.

- [ ] **Step 3: Run the small LoCoMo benchmark slice**

Use the same small conv-26 command used in the current branch, with a new output stem such as `conv-26-session-1.observing-v11.real`.

Expected:

- Import completes.
- Observer watermark resolves.
- Recall has no misses for the four QA rows.
- Latest observing snapshots contain `observations`, `observationDelta`, and `turns`.
- Snapshot content does not contain `whyRelated`.
- Snapshot content does not persist gateway `why`.
- Trace contains gateway `why` under hit-level `gateway_routes` when routes are available.

- [ ] **Step 4: Inspect the small slice output**

Print or summarize:

- final observing threads
- each thread title and summary
- each thread `turns` window
- each thread observations by category
- four QA questions, predictions, clarity scores, F1, and top hits
- gateway route summaries and `why`

Expected qualitative result:

- career/support thread no longer consumes painting-only slices as primary routed content
- painting thread no longer consumes career/support-only slices as primary routed content
- observations are less transcript-like
- recall quality does not regress materially from v10

## Self-Review Checklist

- Spec coverage: Covers observation rename, bounded `turns`, `continuityHint`, previous-turn context, `why` trace, no public memory API rename, and semantic index exclusion.
- Placeholder scan: This plan contains no placeholder implementation steps; all new public names and commands are explicit.
- Type consistency: Uses `Observation`, `ObservationCategory`, `ObservedTurnSlice`, `observations`, `observationDelta`, `contextTurns`, `continuityHint`, and `previousTurnSummary` consistently.
