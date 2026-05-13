# Dual Route Recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recall from curated `observation` rows first, then fill with raw `extraction` rows while filtering raw hits covered by selected curated hits.

**Architecture:** Core recall will run two searches with the same query/mode/vector, merge candidates deterministically, and keep provenance layered as `observation -> extraction -> turn`. Rendering and LoCoMo evidence resolution will learn `observation:<id>` so benchmark output can resolve curated hits back to hidden source evidence.

**Tech Stack:** TypeScript core bindings, Rust Lance table bindings, Node test runner, LoCoMo TypeScript bridge.

---

## File Structure

- Modify `format/src/observation.rs`: add `load_by_ids()` for observation rows.
- Modify `packages/core/native/src/lib.rs`: expose `observationLoadByIds`.
- Modify `packages/core/src/native.ts`: expose `observationTable.loadByIds`.
- Modify `packages/core/src/memories/observations.ts`: create a small getter for `observation:<id>`.
- Modify `packages/core/src/memories/rendered.ts`: add `renderObservation()`.
- Modify `packages/core/src/memories/memories.ts`: route `memories.get("observation:<id>")`.
- Modify `packages/core/src/memories/recall.ts`: implement dual-route search and deterministic merge.
- Modify `benchmark/locomo/src/bridge.ts`: resolve `observation:<id>` through extraction refs.
- Modify `packages/core/test/client-internals.test.mjs`: add recall/rendering unit tests.
- Modify `benchmark/locomo/test/bridge.test.mjs`: add recursive observation evidence test.

## Task 1: Observation Row Lookup and Rendering

**Files:**
- Modify: `format/src/observation.rs`
- Modify: `packages/core/native/src/lib.rs`
- Modify: `packages/core/src/native.ts`
- Create: `packages/core/src/memories/observations.ts`
- Modify: `packages/core/src/memories/rendered.ts`
- Modify: `packages/core/src/memories/memories.ts`
- Test: `packages/core/test/client-internals.test.mjs`

- [ ] **Step 1: Write failing rendering tests**

Add tests near the existing native curation/observation tests in `packages/core/test/client-internals.test.mjs`:

```js
test('memories.get renders curated observation memories', async () => {
  const client = {
    observationTable: {
      loadByIds: async ({ ids }) => ids.includes('obs-1')
        ? [{
            id: 'obs-1',
            curationId: 'entity:caroline',
            snapshotId: 'curation:1',
            text: 'Caroline researched adoption agencies.',
            vector: [],
            references: ['extraction:ext-1'],
            createdAt: '2024-01-01T00:00:00Z',
          }]
        : [],
    },
    extractionTable: { loadByIds: async () => [] },
    sessionTable: { get: async () => null },
    turnTable: { get: async () => null },
  };
  const { Memories } = await import('../dist/memories/memories.js');
  const memory = await new Memories(client).get('observation:obs-1');

  assert.equal(memory.memoryId, 'observation:obs-1');
  assert.equal(memory.title, 'Caroline researched adoption agencies.');
  assert.equal(memory.summary, 'Caroline researched adoption agencies.');
  assert.match(memory.detail, /References:/);
  assert.match(memory.detail, /extraction:ext-1/);
});

test('memories.get returns null for unknown curated observation memories', async () => {
  const client = {
    observationTable: { loadByIds: async () => [] },
    extractionTable: { loadByIds: async () => [] },
    sessionTable: { get: async () => null },
    turnTable: { get: async () => null },
  };
  const { Memories } = await import('../dist/memories/memories.js');
  assert.equal(await new Memories(client).get('observation:missing'), null);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/core build && node --test packages/core/test/client-internals.test.mjs
```

Expected: FAIL because `observation:<id>` is not handled.

- [ ] **Step 3: Add observation parsing/getter**

Create `packages/core/src/memories/observations.ts`:

```ts
import type { NativeTables, Observation } from '../native.js';

export function parseObservationMemoryId(memoryId: string): string {
  const [layer, id, extra] = memoryId.split(':');
  if (layer !== 'observation' || !id || extra !== undefined) {
    throw new Error(`invalid observation memory id: ${memoryId}`);
  }
  return id;
}

export async function getObservation(
  client: NativeTables,
  memoryId: string,
): Promise<Observation | null> {
  const id = parseObservationMemoryId(memoryId);
  const rows = await client.observationTable.loadByIds({ ids: [id] });
  return rows[0] ?? null;
}
```

- [ ] **Step 4: Add table load interface**

Update `packages/core/src/native.ts`:

```ts
export interface ObservationTableBinding {
  replaceForCuration(params: {
    curationId: string;
    rows: Observation[];
  }): Promise<void>;
  search(params: {
    query: string;
    vector: number[];
    limit: number;
    mode: RecallMode;
  }): Promise<Observation[]>;
  loadByIds(params: {
    ids: string[];
  }): Promise<Observation[]>;
  stats(): Promise<TableStats | null>;
}
```

Also wire `observationTable.loadByIds` in `getNativeTables()` to the native binding method name used by this repo, mirroring `extractionTable.loadByIds`.

In `NativeCoreBinding`, add:

```ts
observationLoadByIds(params: {
  ids: string[];
}): MaybePromise<Observation[]>;
```

In `getNativeTables().observationTable`, add:

```ts
loadByIds: async (params) => resolveNativeResult(native.observationLoadByIds(params)),
```

- [ ] **Step 5: Implement Rust observation lookup**

In `format/src/observation.rs`, add:

```rust
    pub async fn load_by_ids(&self, ids: &[String]) -> Result<Vec<Observation>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(Vec::new());
        };
        let predicate = if ids.len() == 1 {
            format!("id = '{}'", escape_predicate_string(&ids[0]))
        } else {
            let quoted = ids
                .iter()
                .map(|id| format!("'{}'", escape_predicate_string(id)))
                .collect::<Vec<_>>()
                .join(", ");
            format!("id IN ({quoted})")
        };
        let batch = dataset.scan().filter(&predicate)?.try_into_batch().await?;
        if batch.num_rows() == 0 {
            return Ok(Vec::new());
        }
        record_batch_to_observations(&batch)
    }
```

In `packages/core/native/src/lib.rs`, add the params struct next to `ObservationSearchParams`:

```rust
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ObservationLoadByIdsParams {
    ids: Vec<String>,
}
```

Then expose this method next to `observationSearch`:

```rust
    #[napi(js_name = "observationLoadByIds")]
    pub async fn observation_load_by_ids(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<ObservationLoadByIdsParams>(params)?;
        let resources = self.resources().await?;
        into_napi_value(
            resources
                .observation_table
                .load_by_ids(&params.ids)
                .await,
        )
    }
```

- [ ] **Step 6: Add rendering**

Modify `packages/core/src/memories/rendered.ts`:

```ts
import type { Extraction, Observation } from '../native.js';
```

Add:

```ts
export function renderObservation(memory: Observation): RenderedMemory {
  const references = memory.references.length > 0
    ? `References:\n${memory.references.map((ref) => `- ${ref}`).join('\n')}`
    : undefined;
  return {
    memoryId: `observation:${memory.id}`,
    title: memory.text,
    summary: memory.text,
    detail: references,
    createdAt: memory.createdAt,
    updatedAt: memory.createdAt,
  };
}
```

- [ ] **Step 7: Route memories.get**

Modify `packages/core/src/memories/memories.ts`:

```ts
import { getObservation } from './observations.js';
import { renderExtraction, renderObservation, renderSessionSnapshot, renderTurn } from './rendered.js';
```

Inside `get(memoryId)` before the `session:` branch:

```ts
if (memoryId.startsWith('observation:')) {
  const observation = await getObservation(this.client, memoryId);
  return observation ? renderObservation(observation) : null;
}
```

- [ ] **Step 8: Run tests and commit**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/core build && node --test packages/core/test/client-internals.test.mjs
```

Expected: PASS.

Commit:

```bash
git add format/src/observation.rs packages/core/native/src/lib.rs packages/core/src/native.ts packages/core/src/memories/observations.ts packages/core/src/memories/rendered.ts packages/core/src/memories/memories.ts packages/core/test/client-internals.test.mjs
git commit -m "feat: render curated observations"
```

## Task 2: Deterministic Dual-Route Recall Merge

**Files:**
- Modify: `packages/core/src/memories/recall.ts`
- Test: `packages/core/test/client-internals.test.mjs`

- [ ] **Step 1: Replace existing recall tests with dual-route expectations**

Update the existing `recallMemories defaults to hybrid mode...` test to include `observationTable.search`:

```js
test('recallMemories searches curated and raw routes then returns curated-first hits', async () => {
  const calls = [];
  const client = {
    observationTable: {
      search: async (params) => {
        calls.push(['observation', params]);
        return [{
          id: 'curated-1',
          curationId: 'entity:caroline',
          snapshotId: 'curation:1',
          text: 'Caroline plans to research adoption agencies.',
          vector: [],
          references: ['extraction:raw-1'],
          createdAt: '2024-01-01T00:00:00Z',
        }];
      },
    },
    extractionTable: {
      search: async (params) => {
        calls.push(['extraction', params]);
        return [{
          id: 'raw-2',
          text: 'Caroline is interested in counseling work.',
          context: null,
          anchors: [],
          vector: [],
          importance: 1,
          category: 'Fact',
          references: ['session:2'],
          createdAt: '2024-01-01T00:00:00Z',
        }];
      },
    },
  };

  const hits = await recallMemories(client, 'What are Caroline plans?', 3, { embed: async () => [1, 0] });

  assert.deepEqual(hits, [
    {
      memoryId: 'observation:curated-1',
      text: 'Caroline plans to research adoption agencies.',
      references: ['extraction:raw-1'],
    },
    {
      memoryId: 'extraction:raw-2',
      text: 'Caroline is interested in counseling work.',
      references: ['session:2'],
    },
  ]);
  assert.deepEqual(calls.map(([table]) => table), ['observation', 'extraction']);
  assert.deepEqual(calls[0][1], {
    query: 'What are Caroline plans?',
    vector: [1, 0],
    limit: 3,
    mode: 'hybrid',
  });
});
```

- [ ] **Step 2: Add covered filtering tests**

Add:

```js
test('recallMemories filters raw hits covered by selected curated hits', async () => {
  const client = {
    observationTable: {
      search: async () => [
        {
          id: 'curated-1',
          curationId: 'entity:caroline',
          snapshotId: 'curation:1',
          text: 'Caroline researched adoption agencies.',
          vector: [],
          references: ['extraction:raw-1'],
          createdAt: '2024-01-01T00:00:00Z',
        },
      ],
    },
    extractionTable: {
      search: async () => [
        {
          id: 'raw-1',
          text: 'Caroline researched adoption agencies.',
          context: null,
          anchors: [],
          vector: [],
          importance: 1,
          category: 'Fact',
          references: ['session:1'],
          createdAt: '2024-01-01T00:00:00Z',
        },
        {
          id: 'raw-2',
          text: 'Melanie painted a lake sunrise in 2022.',
          context: null,
          anchors: [],
          vector: [],
          importance: 1,
          category: 'Fact',
          references: ['session:2'],
          createdAt: '2024-01-01T00:00:00Z',
        },
      ],
    },
  };

  const hits = await recallMemories(client, 'Caroline research', 2, { embed: async () => [1, 0] });
  assert.deepEqual(hits.map((hit) => hit.memoryId), ['observation:curated-1', 'extraction:raw-2']);
});
```

- [ ] **Step 3: Add selected-only filtering test**

Add:

```js
test('recallMemories does not filter raw hits covered only by unselected curated candidates', async () => {
  const client = {
    observationTable: {
      search: async () => [
        {
          id: 'curated-1',
          curationId: 'entity:one',
          snapshotId: 'curation:1',
          text: 'Selected curated memory.',
          vector: [],
          references: ['extraction:raw-1'],
          createdAt: '2024-01-01T00:00:00Z',
        },
        {
          id: 'curated-2',
          curationId: 'entity:two',
          snapshotId: 'curation:2',
          text: 'Unselected curated memory.',
          vector: [],
          references: ['extraction:raw-2'],
          createdAt: '2024-01-01T00:00:00Z',
        },
      ],
    },
    extractionTable: {
      search: async () => [
        {
          id: 'raw-2',
          text: 'Raw memory covered only by unselected curated memory.',
          context: null,
          anchors: [],
          vector: [],
          importance: 1,
          category: 'Fact',
          references: ['session:2'],
          createdAt: '2024-01-01T00:00:00Z',
        },
      ],
    },
  };

  const hits = await recallMemories(client, 'query', 1, { embed: async () => [1, 0] });
  assert.deepEqual(hits.map((hit) => hit.memoryId), ['observation:curated-1']);

  const hitsTwo = await recallMemories(client, 'query', 2, { embed: async () => [1, 0] });
  assert.deepEqual(hitsTwo.map((hit) => hit.memoryId), ['observation:curated-1', 'extraction:raw-2']);
});
```

- [ ] **Step 4: Implement merge helpers**

In `packages/core/src/memories/recall.ts`, add compact internal types and helpers:

```ts
type RouteHit = RecallHit & {
  route: 'curated' | 'raw';
};

function curatedQuota(limit: number): number {
  return Math.ceil(limit * 0.7);
}

function coveredExtractionIds(hits: RouteHit[]): Set<string> {
  const covered = new Set<string>();
  for (const hit of hits) {
    if (hit.route !== 'curated') {
      continue;
    }
    for (const ref of hit.references ?? []) {
      if (ref.startsWith('extraction:')) {
        covered.add(ref);
      }
    }
  }
  return covered;
}

function mergeRoutes(curated: RouteHit[], raw: RouteHit[], limit: number): RouteHit[] {
  if (limit <= 0) {
    return [];
  }
  const firstCurated = curated.slice(0, curatedQuota(limit));
  const covered = coveredExtractionIds(firstCurated);
  const rawFallback = raw.filter((hit) => !covered.has(hit.memoryId));
  const rawQuota = limit - firstCurated.length;
  const selected = firstCurated.concat(rawFallback.slice(0, rawQuota));
  if (selected.length >= limit) {
    return selected.slice(0, limit);
  }
  const selectedIds = new Set(selected.map((hit) => hit.memoryId));
  for (const hit of curated.concat(rawFallback)) {
    if (selected.length >= limit) {
      break;
    }
    if (!selectedIds.has(hit.memoryId)) {
      selected.push(hit);
      selectedIds.add(hit.memoryId);
    }
  }
  return selected;
}
```

- [ ] **Step 5: Search both routes**

Replace the single `extractionTable.search` call with:

```ts
const [observationRows, extractionRows] = await Promise.all([
  client.observationTable.search({
    query: trimmed,
    vector,
    limit: queryLimit,
    mode,
  }),
  client.extractionTable.search({
    query: trimmed,
    vector,
    limit: queryLimit,
    mode,
  }),
]);
const curatedHits: RouteHit[] = observationRows.map((row) => ({
  route: 'curated',
  memoryId: `observation:${row.id}`,
  text: row.text,
  references: row.references,
}));
const rawHits: RouteHit[] = extractionRows.map((row) => ({
  route: 'raw',
  memoryId: `extraction:${row.id}`,
  text: row.text,
  references: row.references,
}));
const merged = mergeRoutes(curatedHits, rawHits, budget > 0 ? queryLimit : limit);
```

For `budget === 0`, return:

```ts
return merged.slice(0, limit).map(({ route: _route, ...hit }) => hit);
```

- [ ] **Step 6: Run tests and commit**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/core build && node --test packages/core/test/client-internals.test.mjs
```

Expected: PASS.

Commit:

```bash
git add packages/core/src/memories/recall.ts packages/core/test/client-internals.test.mjs
git commit -m "feat: recall curated and raw memories"
```

## Task 3: memory-recaller Mixed Candidates

**Files:**
- Modify: `packages/core/src/memories/recall.ts`
- Test: `packages/core/test/client-internals.test.mjs`

- [ ] **Step 1: Update budget tests for mixed routes**

Update `recallMemories returns recalled memory when budget is positive` so the client has both routes:

```js
const client = {
  observationTable: {
    search: async () => [{
      id: 'curated-1',
      curationId: 'entity:caroline',
      snapshotId: 'curation:1',
      text: 'Caroline plans to research adoption agencies.',
      vector: [],
      references: ['extraction:obs-2'],
      createdAt: '2024-01-01T00:00:00Z',
    }],
  },
  extractionTable: {
    search: async (params) => {
      calls.push(params);
      return [
        {
          id: 'obs-1',
          text: 'Caroline and Melanie planned a summer outing.',
          context: 'They discussed summer plans together.',
          anchors: ['Caroline', 'summer outing'],
          vector: [],
          importance: 1,
          category: 'Fact',
          references: ['D12:17'],
          createdAt: '2024-01-01T00:00:00Z',
        },
        {
          id: 'obs-2',
          text: 'Caroline researched adoption agencies.',
          context: 'Melanie asked Caroline about her summer plans.',
          anchors: ['Caroline', 'adoption agencies'],
          vector: [],
          importance: 1,
          category: 'Fact',
          references: ['D2:8'],
          createdAt: '2024-01-01T00:00:00Z',
        },
      ];
    },
  },
};
```

Assert the recaller sees both route types after filtering:

```js
assert.deepEqual(seenCandidates.map((candidate) => candidate.memoryId), [
  'observation:curated-1',
  'extraction:obs-1',
]);
```

- [ ] **Step 2: Preserve candidate-pool refs for recalled memory**

Update `recallMemories uses candidate refs for recalled memory` expectation:

```js
assert.deepEqual(hits, [{
  memoryId: 'recalled:memory',
  text: 'Caroline researched adoption agencies.',
  references: ['extraction:curated-source', 'D2:8'],
}]);
```

The point is that returned refs come from the merged candidate pool, not from the recaller JSON.

- [ ] **Step 3: Implement mixed candidate conversion**

In `packages/core/src/memories/recall.ts`, create a row lookup map before calling recaller:

```ts
const extractionById = new Map(extractionRows.map((row) => [`extraction:${row.id}`, row]));
const observationById = new Map(observationRows.map((row) => [`observation:${row.id}`, row]));
```

Build candidates from `merged`:

```ts
const candidates = merged.map((hit) => {
  if (hit.route === 'curated') {
    const row = observationById.get(hit.memoryId);
    if (!row) {
      throw new Error(`missing recalled observation row: ${hit.memoryId}`);
    }
    return {
      memoryId: hit.memoryId,
      content: row.text,
      refs: row.references,
    };
  }
  const row = extractionById.get(hit.memoryId);
  if (!row) {
    throw new Error(`missing recalled extraction row: ${hit.memoryId}`);
  }
  return {
    memoryId: hit.memoryId,
    content: row.text,
    context: row.context,
    anchors: row.anchors,
    refs: row.references,
  };
});
```

Keep synthetic refs as candidate pool refs:

```ts
references: uniqueRefs(candidates.flatMap((candidate) => candidate.refs)),
```

- [ ] **Step 4: Run tests and commit**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/core build && node --test packages/core/test/client-internals.test.mjs
```

Expected: PASS.

Commit:

```bash
git add packages/core/src/memories/recall.ts packages/core/test/client-internals.test.mjs
git commit -m "feat: pass mixed recall candidates to recaller"
```

## Task 4: LoCoMo Observation Evidence Resolution

**Files:**
- Modify: `benchmark/locomo/src/bridge.ts`
- Test: `benchmark/locomo/test/bridge.test.mjs`

- [ ] **Step 1: Add graph test for observation lineage**

Add to `benchmark/locomo/test/bridge.test.mjs` near existing recursive evidence tests:

```js
test('recursive evidence resolution can walk observation lineage through extraction ids', async () => {
  const bridgeModule = await import(bridgePath);
  const evidenceIds = bridgeModule.resolveEvidenceIdsFromGraph(
    'observation:curated-1',
    [
      {
        turn_id: 'session:101',
        source_id: 'D2:8',
        sample_id: 'sample-a',
        session_id: 'locomo:sample-a:session_2',
        date_time: '1:14 pm on 25 May, 2023',
        import_order: 0,
      },
    ],
    {
      'observation:curated-1': ['extraction:raw-1'],
      'extraction:raw-1': ['session:101'],
    },
  );

  assert.deepEqual(evidenceIds, ['D2:8']);
});
```

- [ ] **Step 2: Add runtime observation branch**

Modify `resolveEvidenceIds()` in `benchmark/locomo/src/bridge.ts`:

```ts
if (memoryId.startsWith('observation:')) {
  const rendered = await coreClient.memories.get(memoryId);
  const sourceIds: string[] = [];
  for (const reference of renderedReferences(rendered)) {
    for (const sourceId of await resolveEvidenceReference(reference, turnMap, seen)) {
      if (!sourceIds.includes(sourceId)) {
        sourceIds.push(sourceId);
      }
    }
  }
  return sourceIds;
}
```

Also update `directSessionReferences()` so observation details can show referenced source turns in debug output:

```ts
if (memoryId.startsWith('observation:')) {
  const rendered = await coreClient.memories.get(memoryId);
  const sourceIds = await resolveEvidenceIds(memoryId, turnMap);
  return directSessionReferencesFromIds(
    [...renderedReferences(rendered), ...sourceIds],
    turnMap,
  );
}
```

- [ ] **Step 3: Confirm graph helper supports generic nodes**

`resolveEvidenceIdsFromGraphInner()` should walk arbitrary keys through `referenceGraph`. Keep or update it to this generic shape so `observation:<id>` works as a graph node:

```ts
const references = referenceGraph[memoryId] ?? [];
for (const reference of references) {
  for (const sourceId of resolveEvidenceIdsFromGraphInner(reference, turnMap, referenceGraph, seen)) {
    if (!sourceIds.includes(sourceId)) {
      sourceIds.push(sourceId);
    }
  }
}
```

- [ ] **Step 4: Run bridge tests and commit**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/benchmark-locomo build && node --test benchmark/locomo/test/bridge.test.mjs
```

Expected: PASS.

Commit:

```bash
git add benchmark/locomo/src/bridge.ts benchmark/locomo/test/bridge.test.mjs
git commit -m "feat: resolve curated observation evidence"
```

## Task 5: End-to-End Verification and Small Slice

**Files:**
- No source edits expected.

- [ ] **Step 1: Run full focused test suite**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/core build
source ~/.zprofile && node --test packages/core/test/client-internals.test.mjs packages/core/test/prompt-loader.test.mjs
source ~/.zprofile && pnpm --filter @muninn/benchmark-locomo build
source ~/.zprofile && node --test benchmark/locomo/test/bridge.test.mjs
```

Expected: all commands PASS.

- [ ] **Step 2: Run the agreed LoCoMo small slice**

Use `benchmark/locomo/.cache/data/conv-26-sessions-1-2.json` as the agreed session1+session2 small slice. If that file is missing, stop this verification task and report the missing fixture path instead of silently switching back to first-3-QA.

Run with deterministic raw hits first:

```bash
source ~/.zprofile && MUNINN_LOCOMO_WATERMARK_TIMEOUT_MS=1800000 python3 benchmark/locomo/run.py \
  --data-file benchmark/locomo/.cache/data/conv-26-sessions-1-2.json \
  --out-file benchmark/locomo/out/conv-26-sessions-1-2-dual-route.real.json \
  --progress-file benchmark/locomo/out/conv-26-sessions-1-2-dual-route.progress.jsonl \
  --sample-id conv-26 \
  --top-k 8 \
  --budget 0 \
  --query-limit 8 \
  --recall-mode hybrid \
  --keep-home
```

Expected:

- Recall hits include `observation:<id>` when curation has produced rows.
- Raw hits covered by selected curated observations are absent.
- Hidden recall still resolves source evidence ids.

- [ ] **Step 3: Run small slice with memory-recaller**

Run:

```bash
source ~/.zprofile && MUNINN_LOCOMO_WATERMARK_TIMEOUT_MS=1800000 python3 benchmark/locomo/run.py \
  --data-file benchmark/locomo/.cache/data/conv-26-sessions-1-2.json \
  --out-file benchmark/locomo/out/conv-26-sessions-1-2-dual-route-budget.real.json \
  --progress-file benchmark/locomo/out/conv-26-sessions-1-2-dual-route-budget.progress.jsonl \
  --sample-id conv-26 \
  --top-k 8 \
  --budget 400 \
  --query-limit 8 \
  --recall-mode hybrid \
  --keep-home
```

Expected:

- Output returns `recalled:memory` hits.
- The candidate pool used by memory-recaller includes curated and raw candidates.
- Evidence ids are resolved from the merged candidate pool refs.

- [ ] **Step 4: Summarize results**

Report:

- Average F1 and hidden recall for budget 0.
- Average F1 and hidden recall for budget 400.
- Whether `summer plans -> adoption agencies` improved, regressed, or stayed the same.
- Whether negative/judgment cases see less subject mismatch.
- Any bad case caused by curated compression filtering raw evidence.

- [ ] **Step 5: Confirm no tracked benchmark artifacts were added**

Run:

```bash
git status --short
```

Expected: no new tracked benchmark output files. If benchmark output files appear, move them under the existing ignored experiment output location or leave them untracked; do not commit benchmark result artifacts.

## Self-Review Checklist

- Spec coverage: The plan covers dual route search, selected-only coverage filtering, observation rendering, recursive evidence resolution, budget integration, and tests.
- Scope control: The plan does not add recall configuration, message grep, recall agent loop, coverage claims, or migration.
- Type consistency: `observation:<id>` references remain `extraction:<id>` in core; LoCoMo bridge resolves recursively.
- Native binding risk addressed: Task 1 explicitly modifies `packages/core/native/src/lib.rs` and `packages/core/src/native.ts` using the existing `extractionLoadByIds` pattern.
