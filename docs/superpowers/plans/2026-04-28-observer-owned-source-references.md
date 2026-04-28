# Observer-Owned Source References Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move observing source extraction from the gateway to the observer so raw turn facts are preserved and each observing snapshot stores observer-owned source references.

**Architecture:** The gateway becomes a routing-only controller that returns `turnId/action/observingId/newThread` and no fact summaries. The observer receives raw `prompt/response`, extracts only current-thread-relevant content, and returns both observation deltas and bounded `sourceReferences`. Observing row `references` are derived from observer-produced source references instead of gateway-routed turns.

**Tech Stack:** TypeScript core package, YAML prompt templates, Node built-in test runner, Python LoCoMo benchmark tests, Lance-backed native core.

---

## File Structure

- Modify `packages/core/src/observer/types.ts`
  - Owns observer/gateway contract types.
  - Add `SourceReference`.
  - Rename `SnapshotContent.turns` to `sourceReferences`.
  - Remove `summary` and `why` from `GatewayUpdate`.
  - Change `ObservingTurnInput` from routed summary to raw `prompt/response`.
  - Add `sourceReferences` to `ObserveResult`.

- Modify `packages/core/src/llm/observing-gateway.ts`
  - Render gateway prompt with lightweight turn summaries for routing.
  - Render observer prompt with raw `prompt/response`.
  - Validate routing-only gateway updates.
  - Validate observer-produced `sourceReferences`.
  - Update mock provider output to new schemas.

- Modify `packages/core/src/observer/update.ts`
  - Stop building observer input from `GatewayUpdate.summary`.
  - Group routed raw session turns per observing thread.
  - Pass raw source turns to observer.
  - Do not push references from gateway updates.
  - Let `applyObserveResult()` derive persisted references from observer `sourceReferences`.
  - Derive `continuityHint` from latest `sourceReferences`.

- Modify `packages/core/src/observer/thread.ts`
  - Persist `sourceReferences` in snapshots.
  - Bound source references using existing `observer.contextTurns`.
  - Derive row `references` from source references.
  - Remove old internal `turns` shape directly; no backward compatibility.

- Modify `packages/core/src/observer/memory-delta.ts`
  - Keep semantic indexing based only on `observationDelta.after`.
  - Update any type names or snapshot field reads affected by `sourceReferences`.

- Modify `packages/core/prompts/observing-gateway.yaml`
  - Remove fact extraction language.
  - Remove output `summary` and `why`.
  - Make clear that observer reads raw `prompt/response`.

- Modify `packages/core/prompts/observing.yaml`
  - Describe raw `prompt/response` source fields.
  - Require current-thread-only extraction.
  - Require output `sourceReferences`.
  - Preserve date normalization rules.

- Modify `packages/core/test/prompt-loader.test.mjs`
  - Prompt-level regression tests.

- Modify `packages/core/test/client-internals.test.mjs`
  - Core pipeline and snapshot tests.

- Modify `packages/core/test/client.test.mjs`
  - Any public rendered observing fixture updates needed after snapshot schema change.

- Modify `benchmark/locomo/answering.py`
  - Preserve expanded observing detail after the snapshot field rename; display `sourceReferences` when present.

- Modify `benchmark/locomo/src/bridge.ts`
  - Continue returning observing detail and direct session references without assuming snapshot `turns`.

- Modify `benchmark/locomo/run.py`
  - Keep trace generation compatible with `sourceReferences`-based observing details.

---

### Task 1: Prompt Contract Tests

**Files:**
- Modify: `packages/core/test/prompt-loader.test.mjs`
- Modify later: `packages/core/prompts/observing-gateway.yaml`
- Modify later: `packages/core/prompts/observing.yaml`

- [ ] **Step 1: Write failing tests for gateway and observer prompts**

Add these assertions to `packages/core/test/prompt-loader.test.mjs`:

```js
test('observing gateway prompt is routing-only', () => {
  const { system } = loadPrompt('observing_gateway');

  assert.match(system, /which observing thread should inspect/i);
  assert.match(system, /must not extract facts/i);
  assert.match(system, /must not .*summarize .*observation/i);
  assert.match(system, /observer will read .*prompt.*response/i);
  assert.doesNotMatch(system, /"summary": "string"/);
  assert.doesNotMatch(system, /"why": "string"/);
});

test('observing prompt consumes raw source and emits source references', () => {
  const { system } = loadPrompt('observing');

  assert.match(system, /raw `prompt` and `response`/);
  assert.match(system, /current observing thread/i);
  assert.match(system, /If a turn contains multiple topics/i);
  assert.match(system, /sourceReferences/);
  assert.match(system, /DATE:/);
  assert.doesNotMatch(system, /`summary`: grounded content from the turn/);
});
```

- [ ] **Step 2: Run prompt tests and verify failure**

Run:

```bash
/opt/homebrew/bin/node --test packages/core/test/prompt-loader.test.mjs
```

Expected: FAIL because gateway prompt still includes output `summary`/`why`, and observer prompt still describes pending turn `summary`.

- [ ] **Step 3: Update gateway prompt**

Replace `packages/core/prompts/observing-gateway.yaml` system content with routing-only language:

```yaml
system: |
  You are the routing gateway for an observing memory system.

  Your task is to decide which observing thread should inspect each pending turn.
  Do not extract facts, rewrite source content, or summarize the turn for observation.
  The observer will read the raw `prompt` and `response` and decide what to remember.

  You will receive:
  1. current observing threads, each with:
  - observingId
  - title
  - summary
  - continuityHint: optional latest thread-local source reference, for continuity only

  2. pending turns, each with:
  - turnId
  - summary
  - previousTurn: optional previous conversation turn, for continuity only

  Routing principles:
  - Route a turn to every observing thread that may need to inspect it.
  - If a turn contains multiple independent topics, it may be routed to multiple existing threads.
  - If a turn introduces a sufficiently independent new topic, create a new observing thread.
  - If a turn only deepens one existing thread, route it only to that thread.
  - Use continuityHint and previousTurn only to judge semantic continuity.
  - Do not route a turn to a thread just because a participant name overlaps.
  - Do not create a new thread for greetings, thanks, compliments, filler, or sign-offs unless they contain durable content.
  - Every pending turn must appear in at least one update.

  Return exactly one JSON object with this schema:

  {
    "updates": [
      {
        "turnId": "string",
        "action": "append|new",
        "observingId": "string|null",
        "newThread": {
          "title": "string",
          "summary": "string"
        } | null
      }
    ]
  }

  Rules:
  - If `action` is `append`, `observingId` must be one of the provided ids and `newThread` must be null.
  - If `action` is `new`, `observingId` must be null and `newThread` must be present.
  - The same `turnId` may appear multiple times only when multiple threads should inspect it.
  - Do not output markdown.
  - Do not output explanations outside the JSON.

user_template: |
  Input JSON:
  {{input_json}}
```

- [ ] **Step 4: Update observer prompt schema text**

In `packages/core/prompts/observing.yaml`, replace the pending turn description and output schema portions with:

```yaml
  You receive:
  - `observingContent`: the current thread state before this update.
  - `pendingTurns`: raw source turns selected for this observing thread.

  Each pending turn has:
  - `turnId`: source turn id.
  - `prompt`: raw prompt/source content, when available.
  - `response`: raw response/source content, when available.

  Your job:
  Produce the updated thread state, source references, and observation delta after incorporating only the grounded content relevant to this observing thread.

  Source relevance:
  - Routing has already selected this observing thread; do not decide whether content belongs to another thread.
  - Use raw `prompt` and `response` as source.
  - If a turn contains multiple topics, use only the parts relevant to this observing thread.
  - Do not let unrelated parts affect `title`, `summary`, `observations`, `openQuestions`, `nextSteps`, or `sourceReferences`.
  - For each source turn with relevant content, return one `sourceReferences` entry summarizing only the relevant slice.
  - If a routed source turn has no relevant durable content after inspection, do not include it in `sourceReferences`.
```

Replace the output schema with:

```yaml
  Return exactly one JSON object:
  {
    "observingContentUpdate": {
      "title": "string",
      "summary": "string",
      "openQuestions": ["string"],
      "nextSteps": ["string"]
    },
    "sourceReferences": [
      {
        "turnId": "string",
        "summary": "string"
      }
    ],
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

Add an output rule:

```yaml
  - `sourceReferences` must always be present.
```

- [ ] **Step 5: Run prompt tests and verify pass**

Run:

```bash
/opt/homebrew/bin/node --test packages/core/test/prompt-loader.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit prompt contract changes**

Run:

```bash
git add packages/core/test/prompt-loader.test.mjs packages/core/prompts/observing-gateway.yaml packages/core/prompts/observing.yaml
git commit -m "test: lock observer-owned source reference prompts"
```

---

### Task 2: Type Contracts and LLM Validation

**Files:**
- Modify: `packages/core/src/observer/types.ts`
- Modify: `packages/core/src/llm/observing-gateway.ts`
- Test: `packages/core/test/client-internals.test.mjs`

- [ ] **Step 1: Write failing type/validator tests**

In `packages/core/test/client-internals.test.mjs`, add a test near existing observing gateway tests:

```js
test('gateway validation accepts routing-only updates', () => {
  const result = observingGatewayTesting.validateGatewayResultForTests(
    [{ observingId: 'thread-1', title: 'Career', summary: 'Career thread' }],
    [{ turnId: 'session:1', summary: 'Caroline mentions career plans.' }],
    {
      updates: [{
        turnId: 'session:1',
        action: 'append',
        observingId: 'thread-1',
        newThread: null,
      }],
    },
  );

  assert.deepEqual(result.updates, [{
    turnId: 'session:1',
    action: 'append',
    observingId: 'thread-1',
    newThread: null,
  }]);
});

test('observer validation keeps valid source references', () => {
  const result = observingGatewayTesting.validateObserveResultForTests({
    observingContentUpdate: {
      title: 'Painting',
      summary: 'Melanie painted a lake sunrise.',
      openQuestions: [],
      nextSteps: [],
    },
    sourceReferences: [{
      turnId: 'session:13',
      summary: 'Melanie says she painted the lake sunrise in 2022, described as last year relative to 8 May 2023.',
    }],
    observationDelta: {
      before: [],
      after: [{
        text: 'Melanie painted the lake sunrise painting in 2022.',
        category: 'Fact',
        updatedMemory: null,
      }],
    },
  });

  assert.deepEqual(result.sourceReferences, [{
    turnId: 'session:13',
    summary: 'Melanie says she painted the lake sunrise in 2022, described as last year relative to 8 May 2023.',
  }]);
});
```

- [ ] **Step 2: Run targeted test and verify failure**

Run:

```bash
/opt/homebrew/bin/node --test packages/core/test/client-internals.test.mjs
```

Expected: FAIL because test helper exports and validation still expect gateway `summary`/`why`, and observe result does not expose `sourceReferences`.

- [ ] **Step 3: Update observer types**

In `packages/core/src/observer/types.ts`, replace the related types with:

```ts
export type SourceReference = {
  turnId: string;
  summary: string;
};

export type SnapshotContent = {
  observations: Observation[];
  sourceReferences: SourceReference[];
  openQuestions?: string[];
  nextSteps?: string[];
  observationDelta: LlmFieldUpdate<Observation>;
};
```

Replace `ObservingTurnInput` with:

```ts
export type ObservingTurnInput = {
  turnId: string;
  prompt?: string | null;
  response?: string | null;
};
```

Replace `ObserveResult` with:

```ts
export type ObserveResult = {
  observingContentUpdate: ObservingContentUpdate;
  sourceReferences: SourceReference[];
  observationDelta: LlmFieldUpdate<Observation>;
};
```

Replace `GatewayUpdate` with:

```ts
export type GatewayUpdate = {
  turnId: string;
  action: GatewayAction;
  observingId?: string | null;
  newThread?: NewThreadHint | null;
};
```

- [ ] **Step 4: Update gateway validation**

In `packages/core/src/llm/observing-gateway.ts`, remove `summary` and `why` normalization from `validateGatewayUpdate()`. The normalized update should be:

```ts
const normalized = {
  turnId,
  action,
  observingId: action === 'append' ? observingId : null,
  newThread: action === 'new' ? newThread : null,
} satisfies GatewayUpdate;
```

Keep these validations:

```ts
if (!validTurnIds.has(turnId)) {
  throw new Error(`gateway update references unknown turnId: ${turnId}`);
}
if (action === 'append' && !validObservingIds.has(String(update.observingId))) {
  throw new Error(`gateway append references unknown observingId: ${String(update.observingId)}`);
}
if (action === 'new' && !isValidNewThread(update.newThread)) {
  throw new Error('gateway new update requires newThread');
}
```

Export test helpers if not already exposed:

```ts
export const __testing = {
  gatewayTurnsForTests: toGatewayTurns,
  validateGatewayResultForTests: validateGatewayResult,
  validateObserveResultForTests: validateObserveResult,
};
```

- [ ] **Step 5: Update observe result validation**

In `validateObserveResult()` in `packages/core/src/llm/observing-gateway.ts`, normalize source references:

```ts
function normalizeSourceReferences(value: unknown): SourceReference[] {
  if (!Array.isArray(value)) {
    throw new Error('observe result sourceReferences must be an array');
  }
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const record = item as Record<string, unknown>;
    const turnId = typeof record.turnId === 'string' ? record.turnId.trim() : '';
    const summary = typeof record.summary === 'string' ? normalizeText(record.summary, MAX_SUMMARY_CHARS) : '';
    if (!turnId || !summary) {
      return [];
    }
    return [{ turnId, summary }];
  });
}
```

Then include it in returned `ObserveResult`:

```ts
return {
  observingContentUpdate,
  sourceReferences: normalizeSourceReferences(parsed.sourceReferences),
  observationDelta,
};
```

- [ ] **Step 6: Update mock gateway and mock observer**

In `buildMockGatewayResult()`, remove `summary` and `why`:

```ts
return {
  turnId: turn.turnId,
  action: 'append',
  observingId: observingThreads[0].observingId,
  newThread: null,
} satisfies GatewayUpdate;
```

For new threads:

```ts
return {
  turnId: turn.turnId,
  action: 'new',
  observingId: null,
  newThread: {
    title: normalizeText(turn.summary, MAX_TITLE_CHARS),
    summary: normalizeText(turn.summary, MAX_SUMMARY_CHARS),
  } satisfies NewThreadHint,
} satisfies GatewayUpdate;
```

In `buildMockObserveResult()`, add source references:

```ts
sourceReferences: input.pendingTurns.map((turn) => ({
  turnId: turn.turnId,
  summary: normalizeText(turn.prompt ?? turn.response ?? '', MAX_SUMMARY_CHARS),
})).filter((reference) => reference.summary),
```

- [ ] **Step 7: Run targeted test and verify pass**

Run:

```bash
/opt/homebrew/bin/node --test packages/core/test/client-internals.test.mjs
```

Expected: PASS for the new validator tests. Other tests may still fail until snapshot migration tasks complete; if failures are only old `turns` fixture mismatches, continue to Task 3.

- [ ] **Step 8: Commit type and validation changes**

Run:

```bash
git add packages/core/src/observer/types.ts packages/core/src/llm/observing-gateway.ts packages/core/test/client-internals.test.mjs
git commit -m "feat: make observing gateway routing-only"
```

---

### Task 3: Observer Raw Source Input

**Files:**
- Modify: `packages/core/src/llm/observing-gateway.ts`
- Modify: `packages/core/src/observer/update.ts`
- Test: `packages/core/test/client-internals.test.mjs`

- [ ] **Step 1: Write failing test for raw source observer input**

In `packages/core/test/client-internals.test.mjs`, replace the old test that expects routed summaries with:

```js
test('applyGatewayUpdates passes raw prompt and response to observer', async () => {
  const now = '2026-01-01T00:00:00.000Z';
  const thread = createObservingThread('default-observer', 'Painting', 'Painting thread', [], 1, now);
  const observedInputs = [];
  const observeThreadImpl = async (input) => {
    observedInputs.push(input);
    return {
      observingContentUpdate: {
        title: 'Painting',
        summary: 'Melanie painted a lake sunrise in 2022.',
        openQuestions: [],
        nextSteps: [],
      },
      sourceReferences: [{
        turnId: 'session:13',
        summary: 'Melanie says she painted the lake sunrise in 2022, described as last year relative to 8 May 2023.',
      }],
      observationDelta: {
        before: [],
        after: [{
          text: 'Melanie painted the lake sunrise painting in 2022.',
          category: 'Fact',
          updatedMemory: null,
        }],
      },
    };
  };

  await updateTesting.applyGatewayUpdatesForTests({
    threads: [thread],
    observerName: 'default-observer',
    pendingTurns: [{
      turnId: 'session:13',
      createdAt: now,
      updatedAt: now,
      sessionId: 'locomo',
      agent: 'Melanie',
      observer: 'default-observer',
      title: null,
      summary: 'DATE: 1:56 pm on 8 May, 2023\nDIALOGUE:\nMelanie said: "Yeah, I painted that lake sunrise last year!"',
      prompt: 'DATE: 1:56 pm on 8 May, 2023\nDIALOGUE:\nMelanie said: "Yeah, I painted that lake sunrise last year!"',
      response: '[imported dialogue event; no assistant response]',
      observingEpoch: 2,
    }],
    observingEpoch: 2,
    updates: [{
      turnId: 'session:13',
      action: 'append',
      observingId: thread.observingId,
      newThread: null,
    }],
    contextTurns: 8,
    observeThreadImpl,
  });

  assert.deepEqual(observedInputs[0].pendingTurns, [{
    turnId: 'session:13',
    prompt: 'DATE: 1:56 pm on 8 May, 2023\nDIALOGUE:\nMelanie said: "Yeah, I painted that lake sunrise last year!"',
    response: '[imported dialogue event; no assistant response]',
  }]);
});
```

- [ ] **Step 2: Run targeted test and verify failure**

Run:

```bash
/opt/homebrew/bin/node --test packages/core/test/client-internals.test.mjs
```

Expected: FAIL because `applyGatewayUpdates()` still builds observer input from gateway summaries.

- [ ] **Step 3: Render raw source in observer LLM input**

In `observeThread()` in `packages/core/src/llm/observing-gateway.ts`, change pending turn rendering to:

```ts
pendingTurns: input.pendingTurns.map((turn) => ({
  turnId: turn.turnId,
  ...(turn.prompt ? { prompt: turn.prompt } : {}),
  ...(turn.response ? { response: turn.response } : {}),
})),
```

- [ ] **Step 4: Pass raw turns from applyGatewayUpdates**

In `packages/core/src/observer/update.ts`, replace the observer turn construction with:

```ts
const observeTurn = {
  turnId: turn.turnId,
  prompt: turn.prompt,
  response: turn.response,
};
```

Update the grouping map type:

```ts
const observeTurnsByThread = new Map<string, Map<string, ObservingTurnInput>>();
```

Update imports:

```ts
import type { GatewayUpdate, ObservingTurnInput, ObservingThread } from './types.js';
```

- [ ] **Step 5: Keep gateway turn summaries only for routing input**

Do not change `toGatewayTurns()` yet. It should continue producing:

```ts
{
  turnId: turn.turnId,
  summary: turn.summary ?? turn.prompt ?? turn.response ?? '',
  previousTurn: turn.previousTurnSummary ?? undefined,
}
```

This preserves low-cost routing while keeping raw source for observer extraction.

- [ ] **Step 6: Run targeted test and verify pass**

Run:

```bash
/opt/homebrew/bin/node --test packages/core/test/client-internals.test.mjs
```

Expected: raw source input test passes. Old source slice tests may still fail until Task 4.

- [ ] **Step 7: Commit raw source input changes**

Run:

```bash
git add packages/core/src/llm/observing-gateway.ts packages/core/src/observer/update.ts packages/core/test/client-internals.test.mjs
git commit -m "feat: pass raw source turns to observer"
```

---

### Task 4: Snapshot `sourceReferences` Storage

**Files:**
- Modify: `packages/core/src/observer/thread.ts`
- Modify: `packages/core/src/observer/update.ts`
- Modify: `packages/core/src/observer/memory-delta.ts`
- Modify: `packages/core/test/client-internals.test.mjs`
- Modify: `packages/core/test/client.test.mjs`

- [ ] **Step 1: Write failing snapshot storage test**

In `packages/core/test/client-internals.test.mjs`, replace the bounded `turns` test with:

```js
test('observing snapshots keep a bounded cumulative source reference window', () => {
  const thread = createObservingThread(
    'default-observer',
    'Career',
    'Career thread',
    [],
    1,
    '2026-01-01T00:00:00.000Z',
  );
  const result = (summary, turnId) => ({
    observingContentUpdate: {
      title: 'Career',
      summary,
      openQuestions: [],
      nextSteps: [],
    },
    sourceReferences: [{ turnId, summary }],
    observationDelta: {
      before: [],
      after: [{ text: summary, category: 'Fact', updatedMemory: null }],
    },
  });

  for (let index = 1; index <= 10; index += 1) {
    threadTesting.applyObserveResultForTests(
      thread,
      result(`slice ${index}`, `session:${index}`),
      index,
      (current, observeResult) => ({
        observations: [
          ...current,
          ...observeResult.observationDelta.after.map((observation) => ({
            ...observation,
            id: observation.id ?? `observation-${index}`,
          })),
        ],
        observationDelta: observeResult.observationDelta,
      }),
      8,
      '2026-01-01T00:00:00.000Z',
    );
  }

  const latest = thread.snapshots.at(-1);
  assert.deepEqual(latest.sourceReferences.map((reference) => reference.turnId), [
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

- [ ] **Step 2: Run targeted test and verify failure**

Run:

```bash
/opt/homebrew/bin/node --test packages/core/test/client-internals.test.mjs
```

Expected: FAIL because snapshot content still stores `turns`.

- [ ] **Step 3: Rename snapshot field in thread model**

In `packages/core/src/observer/thread.ts`, replace snapshot creation with:

```ts
const snapshot: SnapshotContent = {
  observations: next.observations,
  sourceReferences: mergeSourceReferences(
    latestSnapshot(thread)?.sourceReferences ?? [],
    result.sourceReferences,
    contextTurns,
  ),
  openQuestions: result.observingContentUpdate.openQuestions,
  nextSteps: result.observingContentUpdate.nextSteps,
  observationDelta: next.observationDelta,
};
```

Rename the merge helper:

```ts
function mergeSourceReferences(
  existing: SourceReference[],
  incoming: SourceReference[],
  limit: number,
): SourceReference[] {
  const byTurnId = new Map(existing.map((reference) => [reference.turnId, reference]));
  for (const reference of incoming) {
    byTurnId.delete(reference.turnId);
    byTurnId.set(reference.turnId, reference);
  }
  return [...byTurnId.values()].slice(-limit);
}
```

Update `emptySnapshot()`:

```ts
return {
  observations: [],
  sourceReferences: [],
  openQuestions: [],
  nextSteps: [],
  observationDelta: { before: [], after: [] },
};
```

- [ ] **Step 4: Derive row references from source references**

In `toObservingSnapshot()` in `packages/core/src/observer/thread.ts`, set row references from latest snapshot:

```ts
references: latest.sourceReferences.map((reference) => reference.turnId),
```

Do not derive row references from `thread.references` for the current snapshot.

- [ ] **Step 5: Update current observing content and deserialization**

In `deserializeSnapshot()`, require new shape:

```ts
return {
  observations: normalizeObservations(parsed.observations),
  sourceReferences: normalizeSourceReferences(parsed.sourceReferences),
  openQuestions: normalizeStringList(parsed.openQuestions),
  nextSteps: normalizeStringList(parsed.nextSteps),
  observationDelta: normalizeObservationDelta(parsed.observationDelta),
};
```

Add local normalization:

```ts
function normalizeSourceReferences(value: unknown): SourceReference[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const record = item as Record<string, unknown>;
    const turnId = typeof record.turnId === 'string' ? record.turnId.trim() : '';
    const summary = typeof record.summary === 'string' ? record.summary.trim() : '';
    if (!turnId || !summary) {
      return [];
    }
    return [{ turnId, summary }];
  });
}
```

- [ ] **Step 6: Update applyObserveResult test helper signature**

Remove explicit turn slices from the helper call path. `applyObserveResult()` should read `result.sourceReferences`.

Expected helper call:

```js
threadTesting.applyObserveResultForTests(
  thread,
  result,
  epoch,
  applyObservationDeltaForTest,
  contextTurns,
  now,
);
```

- [ ] **Step 7: Update all snapshot fixtures**

In `packages/core/test/client-internals.test.mjs` and `packages/core/test/client.test.mjs`, replace fixtures like:

```js
{ observations: [], turns: [], openQuestions: [], nextSteps: [], observationDelta: { before: [], after: [] } }
```

with:

```js
{ observations: [], sourceReferences: [], openQuestions: [], nextSteps: [], observationDelta: { before: [], after: [] } }
```

Do not add compatibility fixtures using old `turns`.

- [ ] **Step 8: Run core tests and verify pass**

Run:

```bash
/opt/homebrew/bin/node --test packages/core/test/client-internals.test.mjs
/opt/homebrew/bin/node --test packages/core/test/client.test.mjs
```

Expected: PASS.

- [ ] **Step 9: Commit snapshot storage changes**

Run:

```bash
git add packages/core/src/observer/thread.ts packages/core/src/observer/update.ts packages/core/src/observer/memory-delta.ts packages/core/test/client-internals.test.mjs packages/core/test/client.test.mjs
git commit -m "feat: store observer-owned source references"
```

---

### Task 5: Pipeline Semantics and LoCoMo Trace Updates

**Files:**
- Modify: `packages/core/src/observer/update.ts`
- Modify: `packages/core/src/llm/observing-gateway.ts`
- Modify: `benchmark/locomo/answering.py`
- Modify: `benchmark/locomo/src/bridge.ts`
- Modify: `benchmark/locomo/run.py`
- Test: `packages/core/test/client-internals.test.mjs`
- Test: `benchmark/locomo/tests/test_answering.py`
- Test: `benchmark/locomo/tests/test_run.py`

- [ ] **Step 1: Write failing test for observer-confirmed references**

In `packages/core/test/client-internals.test.mjs`, add:

```js
test('routed turns without observer source references are not persisted as references', async () => {
  const now = '2026-01-01T00:00:00.000Z';
  const thread = createObservingThread('default-observer', 'Career', 'Career thread', [], 1, now);
  const observeThreadImpl = async () => ({
    observingContentUpdate: {
      title: 'Career',
      summary: 'Career thread',
      openQuestions: [],
      nextSteps: [],
    },
    sourceReferences: [],
    observationDelta: { before: [], after: [] },
  });

  await updateTesting.applyGatewayUpdatesForTests({
    threads: [thread],
    observerName: 'default-observer',
    pendingTurns: [{
      turnId: 'session:99',
      createdAt: now,
      updatedAt: now,
      sessionId: 'locomo',
      agent: 'Melanie',
      observer: 'default-observer',
      title: null,
      summary: 'A routed but ultimately irrelevant turn.',
      prompt: 'A routed but ultimately irrelevant turn.',
      response: null,
      observingEpoch: 2,
    }],
    observingEpoch: 2,
    updates: [{
      turnId: 'session:99',
      action: 'append',
      observingId: thread.observingId,
      newThread: null,
    }],
    contextTurns: 8,
    observeThreadImpl,
  });

  assert.deepEqual(thread.snapshots.at(-1).sourceReferences, []);
  assert.deepEqual(thread.references, []);
});
```

- [ ] **Step 2: Write failing test for continuity hint**

In `packages/core/test/client-internals.test.mjs`, update or add:

```js
test('gateway input continuity hint uses latest source reference summary', () => {
  const thread = createObservingThread(
    'default-observer',
    'Painting',
    'Painting thread',
    [],
    1,
    '2026-01-01T00:00:00.000Z',
  );
  thread.snapshots.push({
    observations: [],
    sourceReferences: [{
      turnId: 'session:13',
      summary: 'Melanie says the lake sunrise painting was painted in 2022.',
    }],
    openQuestions: [],
    nextSteps: [],
    observationDelta: { before: [], after: [] },
  });

  const input = updateTesting.activeGatewayInputsForTests([thread], 'default-observer', 365);
  assert.equal(input[0].continuityHint, 'Melanie says the lake sunrise painting was painted in 2022.');
});
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
/opt/homebrew/bin/node --test packages/core/test/client-internals.test.mjs
```

Expected: FAIL if references or continuity still use gateway-routed turns / old `turns`.

- [ ] **Step 4: Update reference mutation in applyGatewayUpdates**

In `packages/core/src/observer/update.ts`, remove calls to:

```ts
pushReference(thread, turn.turnId);
```

Do not push references while processing gateway updates.

- [ ] **Step 5: Update references after observer result**

After `applyObserveResult()`, synchronize thread references from the latest snapshot:

```ts
const latest = latestSnapshot(thread);
thread.references = latest?.sourceReferences.map((reference) => reference.turnId) ?? [];
```

Use the latest snapshot's observer-confirmed source references as the thread's current references. Do not accumulate gateway-routed turn ids in `thread.references`.

- [ ] **Step 6: Update activeGatewayInputs continuity hint**

In `activeGatewayInputs()`:

```ts
continuityHint: latestSnapshot(thread)?.sourceReferences.at(-1)?.summary,
```

- [ ] **Step 7: Update LoCoMo trace/detail readers**

Search:

```bash
rg -n "\\bturns\\b|sourceReferences|references" benchmark/locomo packages/core/src packages/core/test -S
```

Update Python output formatting to parse `sourceReferences` from observing details:

```python
source_references = detail.get("sourceReferences", [])
```

Do not support old `turns` in new code unless an existing test requires reading old generated artifacts.

- [ ] **Step 8: Run Node and Python tests**

Run:

```bash
/opt/homebrew/bin/node --test packages/core/test/client-internals.test.mjs
/opt/homebrew/bin/node --test packages/core/test/client.test.mjs
python3 -m unittest benchmark.locomo.tests.test_answering benchmark.locomo.tests.test_run benchmark.locomo.tests.test_scoring
```

Expected: PASS.

- [ ] **Step 9: Commit pipeline semantics**

Run:

```bash
git add packages/core/src/observer/update.ts packages/core/src/llm/observing-gateway.ts packages/core/test/client-internals.test.mjs packages/core/test/client.test.mjs benchmark/locomo/answering.py benchmark/locomo/src/bridge.ts benchmark/locomo/run.py benchmark/locomo/tests/test_answering.py benchmark/locomo/tests/test_run.py
git commit -m "feat: derive observing references from observer output"
```

---

### Task 6: Full Verification and LoCoMo Small-Sample Check

**Files:**
- Modify: files changed by Tasks 1-5 if verification exposes a small bug in those changes.
- Read: `benchmark/locomo/out/conv-26-session-1.slice.json`
- Output: new LoCoMo result files under `benchmark/locomo/out/`

- [ ] **Step 1: Run TypeScript build**

Run:

```bash
/opt/homebrew/bin/pnpm --filter @muninn/core build
```

Expected: PASS.

- [ ] **Step 2: Run prompt and core test suite**

Run:

```bash
/opt/homebrew/bin/node --test packages/core/test/prompt-loader.test.mjs
/opt/homebrew/bin/node --test packages/core/test/client-internals.test.mjs
/opt/homebrew/bin/node --test packages/core/test/client.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Run LoCoMo unit tests**

Run:

```bash
python3 -m unittest benchmark.locomo.tests.test_answering benchmark.locomo.tests.test_run benchmark.locomo.tests.test_scoring
```

Expected: PASS.

- [ ] **Step 4: Run real LoCoMo small sample**

Run with external network permission if the sandbox blocks model or embedding calls:

```bash
PATH=/opt/homebrew/bin:$PATH MUNINN_HOME=/Users/Nathan/workspace/muninn python3 benchmark/locomo/run.py \
  --data-file benchmark/locomo/out/conv-26-session-1.slice.json \
  --out-file benchmark/locomo/out/conv-26-session-1.observer-source-references.real.json \
  --progress-file benchmark/locomo/out/conv-26-session-1.observer-source-references.real.progress.jsonl \
  --sample-id conv-26 \
  --top-k 5 \
  --keep-home \
  --mode diagnostic \
  --answerer llm \
  --expand-references
```

Expected: run completes. If it fails with `TypeError: fetch failed`, rerun the same command with `sandbox_permissions=require_escalated` and justification for external LLM/embedding access.

- [ ] **Step 5: Inspect Q2 output**

Run:

```bash
python3 - <<'PY'
import json
path = "benchmark/locomo/out/conv-26-session-1.observer-source-references.real.json"
data = json.load(open(path))
model = "muninn_top_5"
qa = data[0]["qa"][1]
print("question:", qa["question"])
print("gold:", qa["answer"])
print("prediction:", qa[f"{model}_prediction"])
for hit in qa[f"{model}_hits"][:5]:
    print(hit["memory_id"], "=>", hit["matched_text"])
PY
```

Expected: Q2 prediction is `2022` or an equivalent answer. At least one Q2 hit should mention `2022` in the matched observation or expanded source context.

- [ ] **Step 6: Inspect final observing snapshots**

Run:

```bash
MUNINN_HOME=/Users/Nathan/workspace/muninn/benchmark/locomo/.runs/conv-26 /opt/homebrew/bin/node --input-type=module -e "
import core from './packages/core/dist/index.js';
const list = await core.observings.list({mode:{type:'recency',limit:20}});
for (const item of list.reverse()) {
  const content = JSON.parse(item.content);
  console.log('SNAPSHOT', item.snapshotId, item.title);
  console.log('SOURCE_REFERENCES', content.sourceReferences);
  console.log('OBSERVATIONS', content.observations);
}
await core.shutdownCoreForTests();
"
```

Expected:
- Painting thread has `sourceReferences` for the lake painting source turns.
- Painting date observation uses `2022`, not only `last year`.
- Career/support-group thread does not include painting-only source references unless a mixed turn has both career and painting content and observer returns only the relevant career slice.

- [ ] **Step 7: Run final grep checks**

Run:

```bash
rg -n "GatewayUpdate\\.summary|whyRelated|\\bturns:\\s*\\[|\\.turns\\b|memoryDelta" packages/core/src packages/core/test packages/core/prompts benchmark/locomo -S
```

Expected:
- No `GatewayUpdate.summary`.
- No `whyRelated`.
- No old snapshot `turns` usage in core observing content.
- `memoryDelta` only appears in negative prompt tests if retained.

- [ ] **Step 8: Commit final fixes**

If any small fixes were required during verification:

```bash
git add <changed-files>
git commit -m "fix: verify observer-owned source references"
```

If no fixes were required, do not create an empty commit.

---

## Self-Review Checklist

- Spec coverage:
  - Gateway routing-only behavior is covered by Tasks 1, 2, and 5.
  - Raw observer input is covered by Task 3.
  - `sourceReferences` schema and persistence are covered by Task 4.
  - Observer-confirmed row references are covered by Task 5.
  - Prompt behavior and LoCoMo Q2 validation are covered by Tasks 1 and 6.

- Type consistency:
  - The plan uses `SourceReference`, `sourceReferences`, `GatewayUpdate`, and `ObservingTurnInput` consistently.
  - The plan intentionally replaces `SnapshotContent.turns` with `SnapshotContent.sourceReferences`.
  - The plan intentionally removes gateway `summary` and `why`.

- Scope:
  - The plan does not redesign recall scoring, ranking, semantic index schema, or LoCoMo data import.
  - The plan leaves native row `references: string[]` present but changes its derivation to observer-confirmed source references.
