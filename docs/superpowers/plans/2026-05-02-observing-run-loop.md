# Observing Run Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current gateway-first observing write path with an observation-first run loop where observations are first-class memory objects and observing snapshots are higher-level thread synthesis.

**Architecture:** First rename the current `semantic_index` storage surface to `observation` and expose `observation:{id}` through recall/detail. Then add the staged observing run pipeline: extraction, commit, review, thread preparation, thread observing, snapshot commit/index, and checkpoint recovery. Keep session and observing Lance schemas unchanged.

**Tech Stack:** Rust Lance storage in `format/`, N-API bindings in `packages/core/native`, TypeScript core packages, Node test runner, Rust `cargo test`, existing prompt YAML loader.

---

## File Structure

- Modify `format/src/schema.rs`: rename `semantic_index_schema()` to `observation_schema()`, remove `memory_id`, add `references`.
- Rename/modify `format/src/semantic_index.rs` to `format/src/observation.rs`: expose `Observation` and `ObservationTable`.
- Modify `format/src/codec.rs`: replace semantic row codecs with observation row codecs.
- Modify `format/src/lib.rs`, `format/src/maintenance.rs`, `format/src/config.rs`: update exports, tests, and config terminology.
- Modify `packages/core/native/src/lib.rs`: rename native binding methods from `semantic*` to `observation*`.
- Modify `packages/core/src/native.ts`: expose `observationTable`.
- Modify `packages/core/src/config.ts`: rename `semanticIndex` config to `observation`.
- Modify `packages/core/src/checkpoint.ts`: rename baseline `semanticIndex` to `observation` and add `ObservingRun`.
- Modify `packages/core/src/observer/types.ts`: rename snapshot-local `Observation` to `ThreadObservation`, add public `Observation`, `ObservationInput`, review and preparation result types.
- Modify `packages/core/src/observer/memory-delta.ts`: write thread-level observations into `observationTable` with `references`.
- Create `packages/core/src/observer/observation-extraction.ts`: extraction structured call.
- Create `packages/core/src/observer/observation-review.ts`: review structured call.
- Create `packages/core/src/observer/thread-preparation.ts`: progressive detail thread preparation with `memory_get`.
- Modify `packages/core/src/observer/update.ts`: replace gateway flow with observation-first staged flow.
- Modify `packages/core/src/observer/observer.ts`: persist and resume `ObservingRun`.
- Modify `packages/core/src/memories/*.ts`: support `observation:{id}` in recall/detail/render.
- Modify `packages/types/src/api.ts`: add `observation` memory kind and observation references in detail documents.
- Modify prompts under `packages/core/prompts/`: add extraction/review/preparation prompts and update thread observing prompt terminology.
- Modify tests under `packages/core/test/` and Rust unit tests in `format/src/*`.
- Modify benchmark bridge output where it assumes recall returns `observing:*`.

## Task 1: Rename Storage Surface to Observation

**Files:**
- Modify: `format/src/schema.rs`
- Modify: `format/src/semantic_index.rs`
- Modify: `format/src/codec.rs`
- Modify: `format/src/lib.rs`
- Modify: `format/src/maintenance.rs`

- [ ] **Step 1: Write failing Rust schema tests**

Add tests near existing semantic schema tests or at the bottom of `format/src/schema.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observation_schema_has_references_and_no_memory_id() {
        let schema = observation_schema(3);
        assert!(schema.field_with_name("id").is_ok());
        assert!(schema.field_with_name("text").is_ok());
        assert!(schema.field_with_name("vector").is_ok());
        assert!(schema.field_with_name("importance").is_ok());
        assert!(schema.field_with_name("category").is_ok());
        assert!(schema.field_with_name("references").is_ok());
        assert!(schema.field_with_name("created_at").is_ok());
        assert!(schema.field_with_name("memory_id").is_err());
    }
}
```

- [ ] **Step 2: Run the failing schema test**

Run: `cargo test -p muninn-format observation_schema_has_references_and_no_memory_id`

Expected: FAIL because `observation_schema` does not exist.

- [ ] **Step 3: Rename schema and add references**

In `format/src/schema.rs`, replace `semantic_index_schema(dimensions)` with:

```rust
pub fn observation_schema(dimensions: usize) -> Schema {
    let mut id_metadata = HashMap::new();
    id_metadata.insert("lance-schema:unenforced-primary-key".to_string(), "true".to_string());
    id_metadata.insert("lance-schema:unenforced-primary-key:position".to_string(), "1".to_string());

    Schema::new(vec![
        Field::new("id", DataType::Utf8, false).with_metadata(id_metadata),
        Field::new("text", DataType::Utf8, false),
        Field::new(
            "vector",
            DataType::FixedSizeList(
                Arc::new(Field::new("item", DataType::Float32, true)),
                dimensions as i32,
            ),
            false,
        ),
        Field::new("importance", DataType::Float32, false),
        Field::new("category", DataType::Utf8, false),
        Field::new(
            "references",
            DataType::List(Arc::new(Field::new("item", DataType::Utf8, true))),
            false,
        ),
        Field::new(
            "created_at",
            DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())),
            false,
        ),
    ])
}
```

- [ ] **Step 4: Rename Rust row/table types**

Rename `format/src/semantic_index.rs` to `format/src/observation.rs` with `git mv`.

Replace the row type with:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub id: String,
    pub text: String,
    pub vector: Vec<f32>,
    pub importance: f32,
    pub category: String,
    pub references: Vec<String>,
    pub created_at: DateTime<Utc>,
}
```

Rename `SemanticIndexTable` to `ObservationTable`, use table path:

```rust
Path::parse("observation").expect("valid observation table path")
```

- [ ] **Step 5: Rename codecs**

In `format/src/codec.rs`, replace semantic row codec functions with observation names:

```rust
pub(crate) fn observations_to_record_batch(rows: &[Observation]) -> Result<RecordBatch>
pub(crate) fn observations_to_reader(rows: Vec<Observation>) -> Result<RecordBatchIterator<impl Iterator<Item = std::result::Result<RecordBatch, ArrowError>>>>
pub(crate) fn record_batch_to_observations(batch: &RecordBatch) -> Result<Vec<Observation>>
```

Column order must match `observation_schema()`:

```rust
id, text, vector, importance, category, references, created_at
```

Use the existing `build_string_list_array()` helper for `references`.

- [ ] **Step 6: Update exports and maintenance tests**

In `format/src/lib.rs`, export:

```rust
pub mod observation;
pub use observation::{Observation, ObservationTable};
```

Remove `pub mod semantic_index` and `SemanticIndexRow/SemanticIndexTable` exports.

Update maintenance tests to construct `Observation` rows:

```rust
Observation {
    id: "obs-1".to_string(),
    text: "Caroline joined a support group.".to_string(),
    vector: vec![0.1, 0.2, 0.3],
    importance: 1.0,
    category: "fact".to_string(),
    references: vec!["session:1".to_string()],
    created_at: Utc::now(),
}
```

- [ ] **Step 7: Run Rust storage tests**

Run: `cargo test -p muninn-format`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add format/src/schema.rs format/src/codec.rs format/src/lib.rs format/src/maintenance.rs format/src/observation.rs
git commit -m "refactor: rename semantic index storage to observation"
```

## Task 2: Rename Core Native Binding and Config

**Files:**
- Modify: `packages/core/native/src/lib.rs`
- Modify: `packages/core/src/native.ts`
- Modify: `packages/core/src/config.ts`
- Modify: `packages/core/src/backend.ts`
- Modify: `packages/core/src/watchdog.ts`
- Modify: `packages/core/test/client-internals.test.mjs`
- Modify: `packages/core/test/client.test.mjs`

- [ ] **Step 1: Write failing config tests**

In `packages/core/test/client-internals.test.mjs`, add:

```js
test('config reads observation embedding config and rejects semanticIndex', async () => {
  const { validateMuninnConfigInput } = await import('../dist/config.js');
  assert.doesNotThrow(() => validateMuninnConfigInput({
    storage: { type: 'local' },
    observer: { provider: 'mock' },
    observation: { embedding: { provider: 'mock' } },
  }));
  assert.throws(() => validateMuninnConfigInput({
    storage: { type: 'local' },
    observer: { provider: 'mock' },
    semanticIndex: { embedding: { provider: 'mock' } },
  }), /semanticIndex/);
});
```

- [ ] **Step 2: Run the failing test**

Run: `pnpm --filter @muninn/core test:node -- client-internals.test.mjs`

Expected: FAIL because config still expects `semanticIndex`.

- [ ] **Step 3: Rename config types and accessors**

In `packages/core/src/config.ts`, rename:

```ts
type SemanticIndexConfigRecord -> ObservationConfigRecord
semanticIndex?: SemanticIndexConfigRecord -> observation?: ObservationConfigRecord
getEmbeddingConfig() reads config.observation
validateSemanticIndexConfig() -> validateObservationConfig()
```

Error messages must say `observation.embedding`.

- [ ] **Step 4: Rename native binding surface**

In `packages/core/native/src/lib.rs`, rename exported N-API methods:

```rust
semantic_nearest -> observation_nearest
semantic_load_by_ids -> observation_load_by_ids
semantic_upsert -> observation_upsert
semantic_delete -> observation_delete
semantic_validate_dimensions -> observation_validate_dimensions
semantic_table_stats -> observation_table_stats
semantic_ensure_vector_index -> observation_ensure_vector_index
semantic_compact -> observation_compact
semantic_cleanup -> observation_cleanup
semantic_optimize -> observation_optimize
describe_semantic_index_table -> describe_observation_table
describe_semantic_index_for_storage -> describe_observation_for_storage
```

Keep the method behavior identical except it calls `ObservationTable`.

- [ ] **Step 5: Rename TS native binding**

In `packages/core/src/native.ts`, replace `SemanticIndexTableBinding` with:

```ts
export interface ObservationTableBinding {
  nearest(params: { vector: number[]; limit: number }): Promise<Observation[]>;
  loadByIds(params: { ids: string[] }): Promise<Observation[]>;
  upsert(params: { rows: Observation[] }): Promise<void>;
  delete(params: { ids: string[] }): Promise<{ deleted: number }>;
  validateDimensions(params: { expected: number }): Promise<void>;
  stats(): Promise<TableStats | null>;
  ensureVectorIndex(params: { targetPartitionSize: number }): Promise<EnsureVectorIndexResult>;
  compact(): Promise<CompactResult>;
  cleanup(params: { floorVersion: number }): Promise<CompactResult>;
  optimize(params: { mergeCount: number }): Promise<CompactResult>;
  describe(): Promise<TableDescription | null>;
}
```

Expose `observationTable` on `NativeTables`.

- [ ] **Step 6: Rename watchdog config**

In `packages/core/src/watchdog.ts`, replace `semanticIndex` watchdog references with `observation`. Maintenance still ensures vector index, compacts, optimizes, and cleans up the observation table.

- [ ] **Step 7: Build and run core tests**

Run: `pnpm --filter @muninn/core build`

Expected: PASS.

Run: `pnpm --filter @muninn/core test:node`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/native/src/lib.rs packages/core/src/native.ts packages/core/src/config.ts packages/core/src/backend.ts packages/core/src/watchdog.ts packages/core/test/client-internals.test.mjs packages/core/test/client.test.mjs
git commit -m "refactor: expose observation storage in core"
```

## Task 3: Support Observation Memory Recall and Detail

**Files:**
- Modify: `packages/core/src/observer/types.ts`
- Modify: `packages/core/src/memories/recall.ts`
- Create: `packages/core/src/memories/observations.ts`
- Modify: `packages/core/src/memories/memories.ts`
- Modify: `packages/core/src/memories/rendered.ts`
- Modify: `packages/types/src/api.ts`
- Modify: `packages/sidecar/src/render.ts`
- Test: `packages/core/test/client.test.mjs`

- [ ] **Step 1: Write failing memory API tests**

In `packages/core/test/client.test.mjs`, add:

```js
test('recall returns observation memory ids and detail renders references', async () => {
  const client = await createTestClient({
    observer: { provider: 'mock' },
    observation: { embedding: { provider: 'mock' } },
  });
  await client.__testing.native.observationTable.upsert({
    rows: [{
      id: 'obs-1',
      text: 'Caroline joined an LGBTQ support group in May 2023.',
      vector: [1, 0, 0],
      importance: 1,
      category: 'fact',
      references: ['session:1'],
      createdAt: new Date().toISOString(),
    }],
  });
  const hits = await client.memories.recall('support group', 1);
  assert.equal(hits[0].memoryId, 'observation:obs-1');
  const detail = await client.memories.get('observation:obs-1');
  assert.equal(detail.memoryId, 'observation:obs-1');
  assert.match(detail.detail, /session:1/);
});
```

- [ ] **Step 2: Run the failing test**

Run: `pnpm --filter @muninn/core test:node -- client.test.mjs`

Expected: FAIL because `observation:{id}` detail is unsupported.

- [ ] **Step 3: Define public Observation type**

In `packages/core/src/observer/types.ts`, rename snapshot-local `Observation` to `ThreadObservation`, and add:

```ts
export type Observation = {
  id: string;
  text: string;
  vector: number[];
  importance: number;
  category: string;
  references: string[];
  createdAt: string;
};
```

Update `SnapshotContent` to use `ThreadObservation`.

- [ ] **Step 4: Implement observation memory loader**

Create `packages/core/src/memories/observations.ts`:

```ts
import type { NativeTables } from '../native.js';
import type { Observation } from '../observer/types.js';

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

- [ ] **Step 5: Simplify recall**

In `packages/core/src/memories/recall.ts`, remove grouping by `memoryId`. Return nearest observation rows directly:

```ts
return rows.slice(0, limit).map((row) => ({
  memoryId: `observation:${row.id}`,
  text: row.text,
}));
```

- [ ] **Step 6: Render observation detail**

In `packages/core/src/memories/rendered.ts`, add:

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

- [ ] **Step 7: Add observation branch to Memories**

In `packages/core/src/memories/memories.ts`, handle:

```ts
if (memoryId.startsWith('observation:')) {
  const observation = await getObservation(this.client, memoryId);
  return observation ? renderObservation(observation) : null;
}
```

- [ ] **Step 8: Update public API kind**

In `packages/types/src/api.ts`, change:

```ts
kind: 'session' | 'observing' | 'observation';
```

Update sidecar rendering so `observation:{id}` returns kind `observation`.

- [ ] **Step 9: Run memory API tests**

Run: `pnpm --filter @muninn/core test:node -- client.test.mjs`

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/observer/types.ts packages/core/src/memories/recall.ts packages/core/src/memories/observations.ts packages/core/src/memories/memories.ts packages/core/src/memories/rendered.ts packages/types/src/api.ts packages/sidecar/src/render.ts packages/core/test/client.test.mjs
git commit -m "feat: expose observation memories"
```

## Task 4: Update Thread-Level Observation Indexing

**Files:**
- Modify: `packages/core/src/observer/memory-delta.ts`
- Modify: `packages/core/src/observer/thread.ts`
- Modify: `packages/core/src/observer/types.ts`
- Test: `packages/core/test/client-internals.test.mjs`

- [ ] **Step 1: Write failing thread indexing test**

In `packages/core/test/client-internals.test.mjs`, add a test that builds a `SnapshotContent` delta and indexes it:

```js
test('snapshot observation delta writes observation rows with snapshot references', async () => {
  const { applyObservationDelta, applyObservationTableDelta } = await import('../dist/observer/memory-delta.js');
  const rows = [];
  const client = {
    observationTable: {
      loadByIds: async () => [],
      delete: async () => ({ deleted: 0 }),
      upsert: async ({ rows: next }) => rows.push(...next),
    },
  };
  await applyObservationTableDelta(client, {
    observations: [],
    contextRefs: [],
    observationDelta: {
      before: [],
      after: [{ id: 'thread-obs-1', text: 'Caroline has an ongoing support group thread.', category: 'Fact' }],
    },
  }, 'observing:12');
  assert.equal(rows[0].id, 'thread-obs-1');
  assert.deepEqual(rows[0].references, ['observing:12']);
});
```

- [ ] **Step 2: Run the failing test**

Run: `pnpm --filter @muninn/core build && pnpm --filter @muninn/core test:node -- client-internals.test.mjs`

Expected: FAIL because `applyObservationTableDelta` does not exist.

- [ ] **Step 3: Rename and update memory-delta functions**

In `packages/core/src/observer/memory-delta.ts`:

```ts
export async function applyObservationTableDelta(
  client: NativeTables,
  snapshot: SnapshotContent,
  snapshotMemoryId: string,
  signal?: AbortSignal,
): Promise<void>
```

Rows should be:

```ts
rows.push({
  id,
  text,
  vector: await embedText(text, signal),
  importance: existing?.importance ?? embeddingConfig.defaultImportance,
  category: semanticCategory(observation.category),
  references: [snapshotMemoryId],
  createdAt: existing?.createdAt ?? new Date().toISOString(),
});
```

- [ ] **Step 4: Update update.ts call sites**

Replace `applySemanticMemoryDelta()` imports and calls with `applyObservationTableDelta()`.

- [ ] **Step 5: Run core tests**

Run: `pnpm --filter @muninn/core test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/observer/memory-delta.ts packages/core/src/observer/update.ts packages/core/src/observer/thread.ts packages/core/src/observer/types.ts packages/core/test/client-internals.test.mjs
git commit -m "refactor: index thread observations as observations"
```

## Task 5: Add Observation Extraction and Commit

**Files:**
- Create: `packages/core/prompts/observation-extraction.yaml`
- Modify: `packages/core/src/llm/prompt-loader.ts`
- Create: `packages/core/src/observer/observation-extraction.ts`
- Modify: `packages/core/src/observer/update.ts`
- Test: `packages/core/test/prompt-loader.test.mjs`
- Test: `packages/core/test/client-internals.test.mjs`

- [ ] **Step 1: Add prompt loader test**

In `packages/core/test/prompt-loader.test.mjs`, add:

```js
test('observation extraction prompt exists and describes grounded observations', () => {
  const { loadPromptTemplate } = await import('../dist/llm/prompt-loader.js');
  const prompt = loadPromptTemplate('observation_extraction');
  assert.match(prompt.system, /durable memory observations/i);
  assert.match(prompt.userTemplate, /input_json/);
});
```

- [ ] **Step 2: Create extraction prompt**

Create `packages/core/prompts/observation-extraction.yaml`:

```yaml
system: |
  You extract durable memory observations from conversation evidence for future recall.
  Record what became useful to know, not the fact that a conversation happened.
  Each observation must be grounded, self-contained, and specific.
  Avoid greetings, thanks, filler, acknowledgements, routine reactions, and assistant mechanics unless they establish useful future context.
  Do not infer private identity, stable preference, intent, or long-term meaning unless explicitly stated or directly entailed.
user: |
  Extract observations from this JSON input.
  Return JSON only:
  {
    "observations": [
      {
        "text": "self-contained observation",
        "category": "Fact",
        "references": ["session:1"]
      }
    ]
  }

  Input:
  {{input_json}}
```

- [ ] **Step 3: Register prompt**

In `prompt-loader.ts`, add `observation_extraction: 'observation-extraction'`.

- [ ] **Step 4: Implement extraction module**

Create `packages/core/src/observer/observation-extraction.ts` with:

```ts
export type ObservationExtractionResult = {
  observations: ObservationInput[];
};

export async function extractObservations(
  turns: SessionTurn[],
  signal?: AbortSignal,
): Promise<ObservationExtractionResult> {
  const config = getObserverLlmConfig();
  if (!config) throw new Error('observer is not configured');
  if (config.provider === 'mock') return buildMockExtraction(turns);
  const template = loadPromptTemplate('observation_extraction');
  const inputJson = JSON.stringify({ turns: turns.map(toExtractionTurn) }, null, 2);
  const raw = await generateText('observer', {
    system: template.system,
    prompt: renderPromptTemplate(template.userTemplate, { input_json: inputJson }),
    signal,
  });
  return validateExtraction(parseJson<ObservationExtractionResult>(raw ?? ''));
}
```

Validation must require non-empty `text`, valid `category`, and at least one `references` entry.

- [ ] **Step 5: Implement commit helper**

In `observation-extraction.ts`, add:

```ts
export async function commitObservations(
  client: NativeTables,
  inputs: ObservationInput[],
  signal?: AbortSignal,
): Promise<Observation[]> {
  const embeddingConfig = getEmbeddingConfig();
  const rows: Observation[] = [];
  for (const input of inputs) {
    const text = input.text.trim();
    if (!text) continue;
    rows.push({
      id: randomUUID(),
      text,
      vector: await embedText(text, signal),
      importance: embeddingConfig.defaultImportance,
      category: semanticCategory(input.category),
      references: [...new Set(input.references)],
      createdAt: new Date().toISOString(),
    });
  }
  if (rows.length > 0) await client.observationTable.upsert({ rows });
  return rows;
}
```

- [ ] **Step 6: Unit test extraction validation**

Add tests for invalid category, empty text, and missing references in `client-internals.test.mjs`.

- [ ] **Step 7: Run tests**

Run: `pnpm --filter @muninn/core test:node -- prompt-loader.test.mjs client-internals.test.mjs`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/prompts/observation-extraction.yaml packages/core/src/llm/prompt-loader.ts packages/core/src/observer/observation-extraction.ts packages/core/test/prompt-loader.test.mjs packages/core/test/client-internals.test.mjs
git commit -m "feat: extract atomic observations"
```

## Task 6: Add Observation Review

**Files:**
- Create: `packages/core/prompts/observation-review.yaml`
- Create: `packages/core/src/observer/observation-review.ts`
- Modify: `packages/core/src/llm/prompt-loader.ts`
- Test: `packages/core/test/prompt-loader.test.mjs`
- Test: `packages/core/test/client-internals.test.mjs`

- [ ] **Step 1: Add prompt test**

In `prompt-loader.test.mjs`:

```js
test('observation review prompt only removes observations', () => {
  const { loadPromptTemplate } = await import('../dist/llm/prompt-loader.js');
  const prompt = loadPromptTemplate('observation_review');
  assert.match(prompt.system, /remove duplicate/i);
  assert.doesNotMatch(prompt.system, /create new observations/i);
});
```

- [ ] **Step 2: Create review prompt**

Create `packages/core/prompts/observation-review.yaml`:

```yaml
system: |
  You review memory observations for duplicates, noise, stale statements, or observations superseded by clearer evidence.
  You may remove observations. You must not create or rewrite observations.
user: |
  Review this JSON input.
  Return JSON only:
  {
    "removeObservationIds": ["obs-id"],
    "reviewedObservationIds": ["obs-id"]
  }

  Every new observation id must appear in either removeObservationIds or reviewedObservationIds.
  Only remove old observation ids if they are included in candidateObservations.

  Input:
  {{input_json}}
```

- [ ] **Step 3: Implement review module**

Create `packages/core/src/observer/observation-review.ts`:

```ts
export type ObservationReviewResult = {
  removeObservationIds: string[];
  reviewedObservationIds: string[];
};

export async function reviewObservations(input: {
  newObservations: Observation[];
  candidateObservations: Observation[];
}, signal?: AbortSignal): Promise<ObservationReviewResult> {
  const config = getObserverLlmConfig();
  if (!config) throw new Error('observer is not configured');
  if (config.provider === 'mock') {
    return {
      removeObservationIds: [],
      reviewedObservationIds: input.newObservations.map((observation) => observation.id),
    };
  }
  const template = loadPromptTemplate('observation_review');
  const inputJson = JSON.stringify(input, null, 2);
  const raw = await generateText('observer', {
    system: template.system,
    prompt: renderPromptTemplate(template.userTemplate, { input_json: inputJson }),
    signal,
  });
  return validateReview(input, parseJson<ObservationReviewResult>(raw ?? ''));
}
```

- [ ] **Step 4: Validate exact coverage**

`validateReview()` must enforce:

```ts
const newIds = new Set(input.newObservations.map((observation) => observation.id));
const removed = new Set(result.removeObservationIds);
const reviewed = new Set(result.reviewedObservationIds);
for (const id of newIds) {
  if (removed.has(id) === reviewed.has(id)) {
    throw new Error(`observation review must cover new observation exactly once: ${id}`);
  }
}
```

- [ ] **Step 5: Apply removals**

Add:

```ts
export async function applyObservationReview(
  client: NativeTables,
  result: ObservationReviewResult,
): Promise<void> {
  if (result.removeObservationIds.length > 0) {
    await client.observationTable.delete({ ids: result.removeObservationIds });
  }
}
```

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @muninn/core test:node -- prompt-loader.test.mjs client-internals.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/prompts/observation-review.yaml packages/core/src/observer/observation-review.ts packages/core/src/llm/prompt-loader.ts packages/core/test/prompt-loader.test.mjs packages/core/test/client-internals.test.mjs
git commit -m "feat: review observations before threading"
```

## Task 7: Add Thread Preparation with Progressive Detail

**Files:**
- Create: `packages/core/prompts/thread-preparation.yaml`
- Create: `packages/core/src/observer/thread-preparation.ts`
- Modify: `packages/core/src/llm/prompt-loader.ts`
- Test: `packages/core/test/prompt-loader.test.mjs`
- Test: `packages/core/test/client-internals.test.mjs`

- [ ] **Step 1: Add prompt test**

In `prompt-loader.test.mjs`:

```js
test('thread preparation prompt enforces two observations for new threads', () => {
  const { loadPromptTemplate } = await import('../dist/llm/prompt-loader.js');
  const prompt = loadPromptTemplate('thread_preparation');
  assert.match(prompt.system, /at least two related observations/i);
  assert.match(prompt.system, /memory_get/i);
});
```

- [ ] **Step 2: Create thread preparation prompt**

Create `packages/core/prompts/thread-preparation.yaml`:

```yaml
system: |
  You prepare observation groups for observing threads.
  You may route reviewed observations to existing observing threads, create a new thread for at least two related observations, or leave observations unthreaded.
  Do not create a new thread from a single observation.
  Use memory_get only when a candidate summary is insufficient.
user: |
  Return JSON only:
  {
    "workItems": [
      {
        "observationIds": ["obs-1", "obs-2"],
        "targetThreadId": "thread-id",
        "newThreadTitle": null,
        "rationale": "short trace-only reason"
      }
    ],
    "unthreadedObservationIds": ["obs-3"]
  }

  Each reviewed observation id must appear exactly once.
  Each work item must have either targetThreadId or newThreadTitle, not both.
  Any work item with newThreadTitle must contain at least two observationIds.

  Input:
  {{input_json}}
```

- [ ] **Step 3: Implement bounded loop runner**

Create `packages/core/src/observer/thread-preparation.ts`:

```ts
export type ThreadWorkItem = {
  observationIds: string[];
  targetThreadId?: string | null;
  newThreadTitle?: string | null;
  rationale: string;
};

export type ThreadPreparationResult = {
  workItems: ThreadWorkItem[];
  unthreadedObservationIds: string[];
};
```

Implement:

```ts
export async function prepareThreads(input: ThreadPreparationInput, signal?: AbortSignal): Promise<ThreadPreparationResult>
```

The MVP loop uses the existing `generateText()` transport and validates the final JSON. If the current provider abstraction cannot emit tool calls, implement preparation as a structured call first and keep `memory_get` candidates in the input; add a code comment:

```ts
// The prompt contract is get-only. The current text provider path runs it as a structured call;
// the loop runner can replace this call without changing ThreadPreparationResult.
```

- [ ] **Step 4: Validate preparation output**

Validation must enforce:

```ts
each reviewed id appears exactly once;
targetThreadId and newThreadTitle are mutually exclusive;
newThreadTitle requires observationIds.length >= 2;
targetThreadId must exist in activeThreads;
rationale must be non-empty;
```

- [ ] **Step 5: Unit test validator**

In `client-internals.test.mjs`, add cases:

```js
assert.throws(() => validateThreadPreparation(input, duplicateOutput), /exactly once/);
assert.throws(() => validateThreadPreparation(input, singleNewThreadOutput), /at least two/);
assert.throws(() => validateThreadPreparation(input, unknownThreadOutput), /unknown targetThreadId/);
```

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @muninn/core test:node -- prompt-loader.test.mjs client-internals.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/prompts/thread-preparation.yaml packages/core/src/observer/thread-preparation.ts packages/core/src/llm/prompt-loader.ts packages/core/test/prompt-loader.test.mjs packages/core/test/client-internals.test.mjs
git commit -m "feat: prepare observing threads from observations"
```

## Task 8: Adapt Thread Observing to Observation Work Items

**Files:**
- Modify: `packages/core/src/llm/observing-gateway.ts`
- Modify: `packages/core/prompts/observing.yaml`
- Modify: `packages/core/src/observer/update.ts`
- Modify: `packages/core/src/observer/thread.ts`
- Test: `packages/core/test/client-internals.test.mjs`

- [ ] **Step 1: Add test for work-item observing**

In `client-internals.test.mjs`, add a test that passes two observations into a new thread work item and asserts one snapshot is produced with context refs derived from observation references.

```js
test('thread observing consumes prepared observation work items', async () => {
  const result = await observePreparedThread({
    observingContent: {
      title: 'Caroline support group',
      summary: 'Caroline support group',
      observations: [],
      openQuestions: [],
      nextSteps: [],
    },
    observations: [{
      id: 'obs-1',
      text: 'Caroline joined an LGBTQ support group in May 2023.',
      category: 'fact',
      references: ['session:1'],
      importance: 1,
      vector: [1],
      createdAt: new Date().toISOString(),
    }],
  });
  assert.equal(result.contextRefs[0].turnId, 'session:1');
});
```

- [ ] **Step 2: Update observing prompt**

In `packages/core/prompts/observing.yaml`, replace pending raw turn wording with prepared observations:

```text
You are updating one observing thread from linked observations.
Use the observations as the source facts for this thread.
Use references only for provenance and contextRefs.
Do not create or delete point observations.
```

- [ ] **Step 3: Add observePreparedThread**

In `observing-gateway.ts`, add:

```ts
export async function observePreparedThread(input: ObservePreparedRequest, signal?: AbortSignal): Promise<ObserveResult>
```

It renders:

```ts
{
  observingContent,
  observations: input.observations.map(({ id, text, category, references }) => ({ id, text, category, references }))
}
```

Mock provider returns one `contextRefs` entry for each `session:*` reference.

- [ ] **Step 4: Update update.ts**

In the new observation-first path, group `ThreadWorkItem` by target/new thread and call `observePreparedThread()`.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @muninn/core test:node -- client-internals.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/llm/observing-gateway.ts packages/core/prompts/observing.yaml packages/core/src/observer/update.ts packages/core/src/observer/thread.ts packages/core/test/client-internals.test.mjs
git commit -m "feat: observe threads from observation work items"
```

## Task 9: Add ObservingRun Checkpoint and Recovery

**Files:**
- Modify: `packages/core/src/checkpoint.ts`
- Modify: `packages/core/src/observer/observer.ts`
- Modify: `packages/core/src/observer/update.ts`
- Test: `packages/core/test/client-internals.test.mjs`

- [ ] **Step 1: Add checkpoint parse/serialize tests**

In `client-internals.test.mjs`, add:

```js
test('checkpoint preserves observing runs', async () => {
  const { parseCheckpointFile, serializeCheckpointFile } = await import('../dist/checkpoint.js');
  const file = {
    schemaVersion: 4,
    writtenAt: new Date().toISOString(),
    writerPid: 1,
    observer: {
      baseline: { turn: 1, observing: 1, observation: 1 },
      nextEpoch: 2,
      recentSessions: [],
      threads: [],
      runs: [{
        observer: 'default',
        epoch: 1,
        status: 'running',
        stage: 'preparingThreads',
        inputTurnIds: ['session:1'],
        pending: {},
        committed: { observationIds: ['obs-1'], snapshotIds: [] },
        traceRefs: [],
        errors: [],
      }],
    },
  };
  const parsed = parseCheckpointFile(serializeCheckpointFile(file));
  assert.equal(parsed.observer.runs[0].stage, 'preparingThreads');
});
```

- [ ] **Step 2: Bump checkpoint schema**

In `checkpoint.ts`, change:

```ts
schemaVersion: 4
baseline.semanticIndex -> baseline.observation
observer.runs: ObservingRun[]
```

No v3 compatibility is required.

- [ ] **Step 3: Define ObservingRun types**

Add:

```ts
export type ObservingRun = {
  observer: string;
  epoch: number;
  status: 'running' | 'completed' | 'failed';
  stage: 'extracting' | 'committingObservations' | 'reviewingObservations' | 'preparingThreads' | 'observingThreads' | 'committingSnapshots' | 'indexingSnapshots' | 'completed';
  inputTurnIds: string[];
  pending?: {
    observationInputs?: ObservationInput[];
    reviewResult?: ObservationReviewResult;
    threadPreparationResult?: ThreadPreparationResult;
    snapshotResults?: ObservingSnapshot[];
  };
  committed: {
    observationIds: string[];
    snapshotIds: string[];
  };
  traceRefs: string[];
  errors: Array<{ stage: string; message: string; at: string }>;
};
```

- [ ] **Step 4: Export checkpoint state from Observer**

In `observer.ts`, include `runs` in `ObserverCheckpointState`. Update `exportCheckpoint()` so it serializes active/recoverable runs.

- [ ] **Step 5: Resume run on bootstrap**

In `bootstrapInternal()`, after threads restore, resume checkpoint runs in order:

```ts
for (const run of this.checkpoint?.runs ?? []) {
  if (run.status === 'running') {
    await this.resumeObservingRun(run);
  }
}
```

`resumeObservingRun()` loads committed observations:

```ts
const observations = await this.client.observationTable.loadByIds({ ids: run.committed.observationIds });
```

Then resumes from `run.stage`.

- [ ] **Step 6: Run checkpoint tests**

Run: `pnpm --filter @muninn/core test:node -- client-internals.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/checkpoint.ts packages/core/src/observer/observer.ts packages/core/src/observer/update.ts packages/core/test/client-internals.test.mjs
git commit -m "feat: checkpoint observing runs"
```

## Task 10: Replace observeEpoch Pipeline

**Files:**
- Modify: `packages/core/src/observer/update.ts`
- Modify: `packages/core/src/observer/observer.ts`
- Modify: `packages/core/src/observer/types.ts`
- Test: `packages/core/test/client.test.mjs`

- [ ] **Step 1: Add integration test for observation-first flow**

In `packages/core/test/client.test.mjs`, add:

```js
test('observer writes atomic observations before observing snapshots', async () => {
  const client = await createTestClient({
    observer: { provider: 'mock' },
    observation: { embedding: { provider: 'mock' } },
  });
  await client.captureTurn({
    turn: {
      sessionId: 's1',
      agent: 'agent',
      prompt: 'Caroline is thinking about counseling.',
      response: 'Caroline will research counseling programs.',
    },
  });
  await client.observer.flushPending();
  const hits = await client.memories.recall('counseling programs', 5);
  assert.ok(hits.some((hit) => hit.memoryId.startsWith('observation:')));
});
```

- [ ] **Step 2: Implement new observeEpoch orchestration**

In `update.ts`, replace the gateway-first implementation with:

```ts
const extracted = await extractObservations(params.sealedEpoch.turns, signal);
const committed = await commitObservations(params.client, extracted.observations, signal);
const review = await reviewObservations({ newObservations: committed, candidateObservations }, signal);
await applyObservationReview(params.client, review);
const reviewed = committed.filter((observation) => review.reviewedObservationIds.includes(observation.id));
const preparation = await prepareThreads({ observations: reviewed, activeThreads, candidateMemories }, signal);
const touchedIds = await observePreparedWorkItems(...);
await flushThreads(params.client, params.threads, touchedIds);
```

Keep candidate recall empty in this task:

```ts
const candidateObservations = [];
const candidateMemories = [];
```

Task 11 adds real pre-recall after the observation-first pipeline is executable.

- [ ] **Step 3: Remove old gateway route dependency**

Stop calling `routeObservingThreads()` in `observeEpoch()`. Keep old gateway files until all tests are moved, then delete or repurpose in a cleanup task.

- [ ] **Step 4: Run integration tests**

Run: `pnpm --filter @muninn/core test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/observer/update.ts packages/core/src/observer/observer.ts packages/core/src/observer/types.ts packages/core/test/client.test.mjs
git commit -m "feat: run observation-first observing pipeline"
```

## Task 11: Add Candidate Pre-Recall and `memory_get` Expansion

**Files:**
- Modify: `packages/core/src/observer/thread-preparation.ts`
- Modify: `packages/core/src/memories/memories.ts`
- Test: `packages/core/test/client-internals.test.mjs`

- [ ] **Step 1: Add pre-recall helper test**

In `client-internals.test.mjs`:

```js
test('thread preparation candidates dedupe memory ids', async () => {
  const candidates = mergeThreadCandidates([
    { memoryId: 'observation:1', summary: 'A' },
    { memoryId: 'observation:1', summary: 'A duplicate' },
  ]);
  assert.deepEqual(candidates.map((candidate) => candidate.memoryId), ['observation:1']);
});
```

- [ ] **Step 2: Implement candidate pre-recall**

In `thread-preparation.ts`, add:

```ts
export async function prepareThreadCandidates(client: NativeTables, observations: Observation[]): Promise<CandidateMemory[]> {
  const byId = new Map<string, CandidateMemory>();
  for (const observation of observations) {
    const hits = await recallMemories(client, observation.text, 8);
    for (const hit of hits) {
      if (!byId.has(hit.memoryId) && hit.memoryId !== `observation:${observation.id}`) {
        byId.set(hit.memoryId, { memoryId: hit.memoryId, summary: hit.text });
      }
    }
  }
  return [...byId.values()].slice(0, 30);
}
```

- [ ] **Step 3: Implement get-only detail expansion interface**

Add:

```ts
export async function getCandidateDetail(memories: Memories, candidateIds: Set<string>, memoryId: string): Promise<RenderedMemory | null> {
  if (!candidateIds.has(memoryId)) {
    throw new Error(`memory_get can only expand initial candidates: ${memoryId}`);
  }
  return memories.get(memoryId);
}
```

- [ ] **Step 4: Wire candidates into observeEpoch**

Use `prepareThreadCandidates()` before `prepareThreads()`.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @muninn/core test:node -- client-internals.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/observer/thread-preparation.ts packages/core/src/memories/memories.ts packages/core/src/observer/update.ts packages/core/test/client-internals.test.mjs
git commit -m "feat: pre-recall thread preparation candidates"
```

## Task 12: Update LoCoMo Benchmark and Dumps

**Files:**
- Modify: `benchmark/common/muninn_bridge.py`
- Modify: `benchmark/locomo/src/bridge.ts`
- Modify: `benchmark/locomo/tests/test_muninn_bridge.py`
- Modify: `benchmark/locomo/test/bridge.test.mjs`

- [ ] **Step 1: Update benchmark expectation tests**

In Python and JS bridge tests, assert recall accepts `observation:*`:

```py
assert hit["memoryId"].startswith("observation:")
```

and no longer assume all recall hits are `observing:*`.

- [ ] **Step 2: Update dump output**

Include observation hits with references:

```json
{
  "memoryId": "observation:1",
  "text": "...",
  "references": ["session:1"]
}
```

- [ ] **Step 3: Run benchmark tests**

Run: `python -m pytest benchmark/locomo/tests`

Expected: PASS.

Run: `pnpm --filter @muninn/core test:node`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add benchmark/common/muninn_bridge.py benchmark/locomo/src/bridge.ts benchmark/locomo/tests/test_muninn_bridge.py benchmark/locomo/test/bridge.test.mjs
git commit -m "test: update locomo for observation memories"
```

## Task 13: End-to-End Verification

**Files:**
- No new files expected.

- [ ] **Step 1: Run Rust tests**

Run: `cargo test -p muninn-format`

Expected: PASS.

- [ ] **Step 2: Run core build and tests**

Run: `pnpm --filter @muninn/core test`

Expected: PASS.

- [ ] **Step 3: Run sidecar tests**

Run: `pnpm --filter @muninn/sidecar test`

Expected: PASS.

- [ ] **Step 4: Run LoCoMo small sample**

Run:

```bash
PATH=/opt/homebrew/bin:$PATH MUNINN_HOME=/Users/Nathan/workspace/muninn python3 benchmark/locomo/run.py \
  --data-file benchmark/locomo/out/conv-26-session-1.slice.json \
  --out-file benchmark/locomo/out/conv-26-session-1.observing-run-loop.real.json \
  --progress-file benchmark/locomo/out/conv-26-session-1.observing-run-loop.real.progress.jsonl \
  --sample-id conv-26 \
  --top-k 5 \
  --answer-mode llm \
  --keep-home
```

Expected output should show:

- recall hits include `observation:*`
- observation details include `references`
- observing snapshots are still created for touched threads
- thread-level observations are indexed into the observation table

- [ ] **Step 5: Confirm generated files are not staged**

Run: `git status --short benchmark/locomo/out benchmark/locomo/.runs`

Expected: generated benchmark outputs are untracked or ignored and are not staged for commit.

## Self-Review Notes

- Spec coverage: storage rename, public observation memory, references, checkpoint, review, preparation, thread observing, and benchmark updates are covered.
- Scope: the plan keeps session and observing Lance schemas unchanged and confines physical schema change to the old semantic index table.
- Type consistency: public `Observation` means observation table row; snapshot-local memory item is `ThreadObservation`; extraction output is `ObservationInput`.
- Deferred intentionally: old config compatibility, `memory_search` tool inside thread preparation, per-turn partial extraction, physical cleanup of `tool_calls_json` and `artifacts_json`.
