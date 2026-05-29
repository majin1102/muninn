# Curation Snapshot Observation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the next memory layer: extraction anchors trigger entity curation snapshots, and each curation snapshot derives thin observation rows.

**Architecture:** Add `curation_snapshot` as an append-only Rust/Lance table and `observation` as a replace-by-`curation_id` index table. TypeScript owns prompt rendering, curated Markdown parsing, curation checkpoint progress, and the observer write pipeline. Recall merge is intentionally not wired in this plan.

**Tech Stack:** Rust `format/` Lance tables, N-API bridge in `packages/core/native`, TypeScript observer pipeline in `packages/core`, YAML prompt loader, Node tests, Rust cargo tests.

---

## File Structure

- Create `format/src/curation.rs`: Rust table for append-only `curation_snapshot` rows.
- Create `format/src/observation.rs`: Rust table for latest searchable `observation` rows derived from curation snapshots.
- Modify `format/src/schema.rs`: add `curation_snapshot_schema()` and `observation_schema()`.
- Modify `format/src/codec.rs`: add record-batch codecs for curation snapshots and observations.
- Modify `format/src/maintenance.rs`: add observation vector and FTS index helpers.
- Modify `format/src/memory_id.rs`: add `MemoryLayer::Curation`.
- Modify `format/src/lib.rs`: export new table types.
- Modify `packages/core/native/src/lib.rs`: expose curation/observation bindings through N-API.
- Modify `packages/core/src/native.ts`: add TypeScript binding interfaces.
- Modify `packages/core/src/config.ts`: add `curation.anchorThreshold` config with default `5`.
- Modify `packages/core/src/checkpoint.ts`: add `curationRuns` to checkpoint schema.
- Create `packages/core/src/curation/types.ts`: TS curation and observation runtime types.
- Create `packages/core/src/curation/markdown.ts`: parse and validate curated Markdown.
- Create `packages/core/src/curation/runner.ts`: select extraction anchors, call curator, append snapshot, replace observations.
- Create `packages/core/src/llm/curating.ts`: render `thread-curating.yaml` and call the observer LLM.
- Modify `packages/core/src/observer/observer.ts`: trigger curation after extraction indexing and retry checkpointed curation runs.
- Modify `packages/core/src/backend.ts`: include curation/observation baselines in checkpoint export.
- Modify `packages/core/test/client-internals.test.mjs`: add TS curation unit/integration tests.
- Modify `packages/core/test/prompt-loader.test.mjs`: add prompt shape checks for `thread-curating.yaml`.
- Modify `format/README.md`: document `curation_snapshot` and `observation`.

## Task 1: Rust Schemas And Memory Ids

**Files:**
- Modify: `format/src/schema.rs`
- Modify: `format/src/memory_id.rs`
- Modify: `format/src/lib.rs`

- [ ] **Step 1: Write schema and memory id tests**

Add tests in `format/src/schema.rs`:

```rust
#[test]
fn curation_snapshot_schema_has_expected_fields() {
    let schema = curation_snapshot_schema();
    assert!(schema.field_with_name("curation_id").is_ok());
    assert!(schema.field_with_name("snapshot_sequence").is_ok());
    assert!(schema.field_with_name("created_at").is_ok());
    assert!(schema.field_with_name("updated_at").is_ok());
    assert!(schema.field_with_name("observer").is_ok());
    assert!(schema.field_with_name("anchor").is_ok());
    assert!(schema.field_with_name("title").is_ok());
    assert!(schema.field_with_name("summary").is_ok());
    assert!(schema.field_with_name("content").is_ok());
    assert!(schema.field_with_name("references").is_ok());
}

#[test]
fn observation_schema_is_thin_index_row() {
    let schema = observation_schema(3);
    assert!(schema.field_with_name("id").is_ok());
    assert!(schema.field_with_name("curation_id").is_ok());
    assert!(schema.field_with_name("snapshot_id").is_ok());
    assert!(schema.field_with_name("text").is_ok());
    assert!(schema.field_with_name("search_text").is_ok());
    assert!(schema.field_with_name("vector").is_ok());
    assert!(schema.field_with_name("references").is_ok());
    assert!(schema.field_with_name("created_at").is_ok());
    assert!(schema.field_with_name("anchor").is_err());
    assert!(schema.field_with_name("context").is_err());
}
```

Add tests in `format/src/memory_id.rs`:

```rust
#[test]
fn curation_memory_id_roundtrip() {
    let parsed = MemoryId::from_str("curation:7").unwrap();
    assert_eq!(parsed.memory_layer(), MemoryLayer::Curation);
    assert_eq!(parsed.memory_point(), 7);
    assert_eq!(parsed.to_string(), "curation:7");
}
```

- [ ] **Step 2: Run failing Rust tests**

Run:

```bash
cargo test -p muninn-format curation_snapshot_schema_has_expected_fields observation_schema_is_thin_index_row curation_memory_id_roundtrip
```

Expected: fails because the schema functions and `MemoryLayer::Curation` do not exist.

- [ ] **Step 3: Implement schemas and memory layer**

Add to `format/src/memory_id.rs`:

```rust
pub enum MemoryLayer {
    Session,
    Turn,
    Curation,
}
```

Update `as_str()` and `FromStr` with `"curation"`.

Add to `format/src/schema.rs`:

```rust
pub fn curation_snapshot_schema() -> Schema {
    Schema::new(vec![
        Field::new("curation_id", DataType::Utf8, false),
        Field::new("snapshot_sequence", DataType::Int64, false),
        Field::new("created_at", DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())), false),
        Field::new("updated_at", DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())), false),
        Field::new("observer", DataType::Utf8, false),
        Field::new("anchor", DataType::Utf8, false),
        Field::new("title", DataType::Utf8, false),
        Field::new("summary", DataType::Utf8, false),
        Field::new("content", DataType::Utf8, false),
        Field::new("references", DataType::List(Arc::new(Field::new("item", DataType::Utf8, true))), false),
    ])
}

pub fn observation_schema(dimensions: usize) -> Schema {
    let mut id_metadata = HashMap::new();
    id_metadata.insert("lance-schema:unenforced-primary-key".to_string(), "true".to_string());
    id_metadata.insert("lance-schema:unenforced-primary-key:position".to_string(), "1".to_string());

    Schema::new(vec![
        Field::new("id", DataType::Utf8, false).with_metadata(id_metadata),
        Field::new("curation_id", DataType::Utf8, false),
        Field::new("snapshot_id", DataType::Utf8, false),
        Field::new("text", DataType::Utf8, false),
        Field::new("search_text", DataType::Utf8, false),
        Field::new("vector", DataType::FixedSizeList(Arc::new(Field::new("item", DataType::Float32, true)), dimensions as i32), false),
        Field::new("references", DataType::List(Arc::new(Field::new("item", DataType::Utf8, true))), false),
        Field::new("created_at", DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())), false),
    ])
}
```

Ensure `format/src/lib.rs` still exports all public modules after later tasks add them.

- [ ] **Step 4: Run Rust tests**

Run:

```bash
cargo test -p muninn-format curation_snapshot_schema_has_expected_fields observation_schema_is_thin_index_row curation_memory_id_roundtrip
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add format/src/schema.rs format/src/memory_id.rs format/src/lib.rs
git commit -m "feat: add curation and observation schemas"
```

## Task 2: Rust Curation And Observation Tables

**Files:**
- Create: `format/src/curation.rs`
- Create: `format/src/observation.rs`
- Modify: `format/src/codec.rs`
- Modify: `format/src/maintenance.rs`
- Modify: `format/src/lib.rs`

- [ ] **Step 1: Write table tests**

Add tests in `format/src/curation.rs`:

```rust
#[tokio::test]
async fn curation_table_appends_snapshots_and_assigns_row_ids() {
    let _guard = crate::config::llm_test_env_guard();
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("muninn");
    std::fs::create_dir_all(&home).unwrap();
    unsafe { std::env::set_var("MUNINN_HOME", &home); }

    let table = CurationSnapshotTable::new(TableOptions::local(crate::config::data_root().unwrap()).unwrap());
    let now = chrono::Utc::now();
    let mut snapshots = vec![CurationSnapshot {
        snapshot_id: MemoryId::new(MemoryLayer::Curation, u64::MAX),
        curation_id: "entity:caroline".to_string(),
        snapshot_sequence: 0,
        created_at: now,
        updated_at: now,
        observer: "default-observer".to_string(),
        anchor: "Caroline".to_string(),
        title: "Entity Memory: Caroline".to_string(),
        summary: "Caroline summary".to_string(),
        content: "# Entity Memory: Caroline".to_string(),
        references: vec!["extraction:a".to_string()],
    }];

    table.insert(&mut snapshots).await.unwrap();
    assert_eq!(snapshots[0].snapshot_id.to_string(), "curation:0");

    let latest = table.latest("entity:caroline").await.unwrap().unwrap();
    assert_eq!(latest.snapshot_id.to_string(), "curation:0");
    assert_eq!(latest.references, vec!["extraction:a"]);
}
```

Add tests in `format/src/observation.rs`:

```rust
#[tokio::test]
async fn observation_table_replaces_rows_by_curation_id() {
    let _guard = crate::config::llm_test_env_guard();
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("muninn");
    std::fs::create_dir_all(&home).unwrap();
    unsafe { std::env::set_var("MUNINN_HOME", &home); }

    write_embedding_config(&dir, 4);
    let table = ObservationTable::new(TableOptions::local(crate::config::data_root().unwrap()).unwrap());
    let now = chrono::Utc::now();

    table.replace_for_curation("entity:caroline", vec![
        Observation {
            id: "one".to_string(),
            curation_id: "entity:caroline".to_string(),
            snapshot_id: "curation:0".to_string(),
            text: "first".to_string(),
            vector: vec![0.1, 0.2, 0.3, 0.4],
            references: vec!["extraction:a".to_string()],
            created_at: now,
        },
    ]).await.unwrap();

    table.replace_for_curation("entity:caroline", vec![
        Observation {
            id: "two".to_string(),
            curation_id: "entity:caroline".to_string(),
            snapshot_id: "curation:1".to_string(),
            text: "second".to_string(),
            vector: vec![0.4, 0.3, 0.2, 0.1],
            references: vec!["extraction:b".to_string()],
            created_at: now,
        },
    ]).await.unwrap();

    let rows = table.list_for_curation("entity:caroline").await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "two");
}
```

- [ ] **Step 2: Run failing Rust tests**

Run:

```bash
cargo test -p muninn-format curation_table_appends_snapshots_and_assigns_row_ids observation_table_replaces_rows_by_curation_id
```

Expected: fails because tables and codecs do not exist.

- [ ] **Step 3: Implement codecs**

In `format/src/codec.rs`, add curation snapshot and observation batch functions mirroring session/extraction codecs. Follow the existing `session_snapshots_to_reader()` and `extractions_to_reader()` patterns: build Arrow arrays in schema order, read `_rowid` for snapshot ids, and convert Lance errors with the existing helpers.

```rust
pub(crate) fn curation_snapshots_to_reader(rows: Vec<CurationSnapshot>) -> RecordBatchIterator<impl Iterator<Item = std::result::Result<RecordBatch, ArrowError>>>;
pub(crate) fn record_batch_to_curation_snapshots(batch: &RecordBatch) -> Result<Vec<CurationSnapshot>>;
pub(crate) fn observations_to_reader(rows: Vec<Observation>) -> Result<RecordBatchIterator<impl Iterator<Item = std::result::Result<RecordBatch, ArrowError>>>>;
pub(crate) fn record_batch_to_observations(batch: &RecordBatch) -> Result<Vec<Observation>>;
```

Use `curation_snapshot_schema()` and `observation_schema(dimensions)`. For `observation.search_text`, use `row.text.clone()`.

- [ ] **Step 4: Implement `CurationSnapshotTable`**

Create `format/src/curation.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CurationSnapshot {
    pub snapshot_id: MemoryId,
    pub curation_id: String,
    pub snapshot_sequence: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub observer: String,
    pub anchor: String,
    pub title: String,
    pub summary: String,
    pub content: String,
    pub references: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct CurationSnapshotTable {
    access: TableAccess,
}
```

Implement:

```rust
impl CurationSnapshotTable {
    pub fn new(options: TableOptions) -> Self;
    pub async fn try_open_dataset(&self) -> Result<Option<LanceDataset>>;
    pub async fn ensure_dataset(&self) -> Result<LanceDataset>;
    pub async fn describe(&self) -> Result<Option<TableDescription>>;
    pub async fn stats(&self) -> Result<Option<TableStats>>;
    pub async fn insert(&self, rows: &mut [CurationSnapshot]) -> Result<()>;
    pub async fn latest(&self, curation_id: &str) -> Result<Option<CurationSnapshot>>;
    pub async fn list(&self, curation_id: Option<&str>) -> Result<Vec<CurationSnapshot>>;
}
```

Table path: `Path::parse("curation_snapshot")`.

- [ ] **Step 5: Implement `ObservationTable`**

Create `format/src/observation.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub id: String,
    pub curation_id: String,
    pub snapshot_id: String,
    pub text: String,
    pub vector: Vec<f32>,
    pub references: Vec<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct ObservationTable {
    access: TableAccess,
}
```

Implement:

```rust
impl ObservationTable {
    pub fn new(options: TableOptions) -> Self;
    pub async fn try_open_dataset(&self) -> Result<Option<LanceDataset>>;
    pub async fn ensure_dataset(&self) -> Result<LanceDataset>;
    pub async fn describe(&self) -> Result<Option<TableDescription>>;
    pub async fn stats(&self) -> Result<Option<TableStats>>;
    pub async fn list_for_curation(&self, curation_id: &str) -> Result<Vec<Observation>>;
    pub async fn replace_for_curation(&self, curation_id: &str, rows: Vec<Observation>) -> Result<()>;
    pub async fn search(&self, query: &str, query_vector: &[f32], limit: usize, mode: RecallMode) -> Result<Vec<Observation>>;
}
```

For `replace_for_curation`, load existing rows by `curation_id`, delete their ids, then append/upsert new rows. Do not keep old rows.

- [ ] **Step 6: Export modules**

Update `format/src/lib.rs`:

```rust
mod curation;
mod observation;

pub use curation::{CurationSnapshot, CurationSnapshotTable};
pub use observation::{Observation, ObservationTable};
```

- [ ] **Step 7: Run Rust tests**

Run:

```bash
cargo test -p muninn-format curation_table_appends_snapshots_and_assigns_row_ids observation_table_replaces_rows_by_curation_id
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add format/src/curation.rs format/src/observation.rs format/src/codec.rs format/src/maintenance.rs format/src/lib.rs
git commit -m "feat: add curation and observation tables"
```

## Task 3: Native And TypeScript Table Bindings

**Files:**
- Modify: `packages/core/native/src/lib.rs`
- Modify: `packages/core/src/native.ts`
- Modify: `packages/core/test/client-internals.test.mjs`

- [ ] **Step 1: Write binding tests**

In `packages/core/test/client-internals.test.mjs`, add:

```js
test('native bindings expose curation and observation tables', async () => {
  const tables = await getNativeTables();
  assert.equal(typeof tables.extractionTable.list, 'function');
  assert.equal(typeof tables.curationTable.insert, 'function');
  assert.equal(typeof tables.curationTable.latest, 'function');
  assert.equal(typeof tables.curationTable.stats, 'function');
  assert.equal(typeof tables.observationTable.replaceForCuration, 'function');
  assert.equal(typeof tables.observationTable.search, 'function');
  assert.equal(typeof tables.observationTable.stats, 'function');
});
```

- [ ] **Step 2: Run failing Node test**

Run:

```bash
source ~/.zprofile && node --test packages/core/test/client-internals.test.mjs
```

Expected: fails because bindings are missing.

- [ ] **Step 3: Add Rust N-API resources and methods**

In `packages/core/native/src/lib.rs`, extend `CoreResources`:

```rust
curation_table: CurationSnapshotTable,
observation_table: ObservationTable,
```

Add params:

```rust
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtractionListParams {
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CurationInsertParams {
    snapshots: Vec<CurationSnapshot>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CurationLatestParams {
    curation_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ObservationReplaceParams {
    curation_id: String,
    rows: Vec<Observation>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ObservationSearchParams {
    query: String,
    vector: Vec<f32>,
    limit: usize,
    mode: String,
}
```

Expose these N-API methods. Each method should parse params with `parse_params`, read the matching table from `self.resources().await?`, call the Rust table method, and return with `into_napi_value` or `to_napi_value` following the existing extraction methods.

```rust
#[napi(js_name = "extractionList")]
pub async fn extraction_list(&self, params: Value) -> NapiResult<Value>;

#[napi(js_name = "curationInsert")]
pub async fn curation_insert(&self, params: Value) -> NapiResult<Value>;

#[napi(js_name = "curationLatest")]
pub async fn curation_latest(&self, params: Value) -> NapiResult<Value>;

#[napi(js_name = "curationList")]
pub async fn curation_list(&self, params: Value) -> NapiResult<Value>;

#[napi(js_name = "curationTableStats")]
pub async fn curation_table_stats(&self) -> NapiResult<Value>;

#[napi(js_name = "observationReplaceForCuration")]
pub async fn observation_replace_for_curation(&self, params: Value) -> NapiResult<()>;

#[napi(js_name = "observationSearch")]
pub async fn observation_search(&self, params: Value) -> NapiResult<Value>;

#[napi(js_name = "observationTableStats")]
pub async fn observation_table_stats(&self) -> NapiResult<Value>;
```

- [ ] **Step 4: Add TS binding interfaces**

In `packages/core/src/native.ts`, add:

```ts
export type CurationSnapshot = {
  snapshotId: string;
  curationId: string;
  snapshotSequence: number;
  createdAt: string;
  updatedAt: string;
  observer: string;
  anchor: string;
  title: string;
  summary: string;
  content: string;
  references: string[];
};

export type Observation = {
  id: string;
  curationId: string;
  snapshotId: string;
  text: string;
  vector: number[];
  references: string[];
  createdAt: string;
};
```

Add `extractionTable.list`, `curationTable`, and `observationTable` to `NativeTables` and `wrapBinding()`.

- [ ] **Step 5: Build native binding and run tests**

Run:

```bash
source ~/.zprofile && pnpm --filter @muninn/core build
source ~/.zprofile && node --test packages/core/test/client-internals.test.mjs
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/native/src/lib.rs packages/core/src/native.ts packages/core/test/client-internals.test.mjs
git commit -m "feat: expose curation native bindings"
```

## Task 4: Curation Config And Checkpoint Shape

**Files:**
- Modify: `packages/core/src/config.ts`
- Modify: `packages/core/src/checkpoint.ts`
- Modify: `packages/core/src/backend.ts`
- Modify: `packages/core/test/client-internals.test.mjs`

- [ ] **Step 1: Write config and checkpoint tests**

In `packages/core/test/client-internals.test.mjs`, add:

```js
test('curation anchor threshold defaults to five', () => {
  const config = parseMuninnConfigContent(JSON.stringify(baseConfig()));
  assert.equal(getCurationConfigFromConfigForTests(config).anchorThreshold, 5);
});

test('curation anchor threshold validates positive integer', () => {
  const config = baseConfig();
  config.curation = { anchorThreshold: 0 };
  assert.throws(
    () => validateMuninnConfigInput(JSON.stringify(config)),
    /curation\.anchorThreshold must be a positive integer/,
  );
});

test('checkpoint preserves curation runs', () => {
  const checkpoint = parseCheckpointFile(JSON.stringify({
    schemaVersion: 4,
    writtenAt: new Date(0).toISOString(),
    writerPid: 1,
    observer: {
      baseline: { turn: 0, session: 0, extraction: 0, curation: 0, observation: 0 },
      nextEpoch: 1,
      recentSessions: [],
      threads: [],
      runs: [],
      curationRuns: [{
        runId: 'run-1',
        curationId: 'entity:caroline',
        anchor: 'Caroline',
        stage: 'generatingCuration',
        pendingExtractionIds: ['abc'],
        errors: [],
      }],
    },
  }));
  assert.equal(checkpoint.observer.curationRuns[0].curationId, 'entity:caroline');
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
source ~/.zprofile && node --test packages/core/test/client-internals.test.mjs
```

Expected: fails because curation config and checkpoint fields are missing.

- [ ] **Step 3: Add config**

In `packages/core/src/config.ts`, add:

```ts
const DEFAULT_CURATION_ANCHOR_THRESHOLD = 5;

type CurationConfigRecord = {
  anchorThreshold?: number;
};

export type CurationConfig = {
  anchorThreshold: number;
};
```

Add `curation?: CurationConfigRecord` to `MuninnConfigRecord`.

Add:

```ts
export function getCurationConfig(): CurationConfig {
  return getCurationConfigFromConfig(loadMuninnConfig());
}

function getCurationConfigFromConfig(config: MuninnConfigRecord | null): CurationConfig {
  return {
    anchorThreshold: config?.curation?.anchorThreshold ?? DEFAULT_CURATION_ANCHOR_THRESHOLD,
  };
}
```

Validate with:

```ts
function validateCurationConfig(curation: unknown): void {
  if (curation === undefined) {
    return;
  }
  const config = expectRecord(curation, 'curation');
  validateOptionalPositiveInteger(config.anchorThreshold, 'curation.anchorThreshold');
}
```

Export `getCurationConfigFromConfigForTests` through the existing test export pattern if present, or add it to `__testing`.

- [ ] **Step 4: Add checkpoint curation runs**

In `packages/core/src/checkpoint.ts`, add:

```ts
export type CurationRunStage =
  | 'selectingExtractions'
  | 'generatingCuration'
  | 'committingSnapshot'
  | 'committingObservations'
  | 'completed'
  | 'failed';

export type CurationRun = {
  runId: string;
  curationId: string;
  anchor: string;
  stage: CurationRunStage;
  pendingExtractionIds: string[];
  generatedContent?: string;
  parsedObservationDrafts?: Array<{
    id: string;
    text: string;
    references: string[];
  }>;
  committedSnapshotId?: string;
  committedObservationIds?: string[];
  errors: Array<{
    message: string;
    stage: string;
  }>;
};
```

Add `curationRuns: CurationRun[]` to `ObserverCheckpoint`. Parser must require `curationRuns` for schemaVersion 4 checkpoints; update tests and checkpoint fixtures to include `curationRuns: []`.

- [ ] **Step 5: Include table baselines**

In `packages/core/src/backend.ts`, include `curation` and `observation` baseline versions:

```ts
const [turnStats, sessionStats, extractionStats, curationStats, observationStats] = await Promise.all([
  this.client.turnTable.stats(),
  this.client.sessionTable.stats(),
  this.client.extractionTable.stats(),
  this.client.curationTable.stats(),
  this.client.observationTable.stats(),
]);
```

And:

```ts
baseline: {
  turn: turnStats?.version ?? 0,
  session: sessionStats?.version ?? 0,
  extraction: extractionStats?.version ?? 0,
  curation: curationStats?.version ?? 0,
  observation: observationStats?.version ?? 0,
}
```

- [ ] **Step 6: Run tests**

Run:

```bash
source ~/.zprofile && node --test packages/core/test/client-internals.test.mjs
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/config.ts packages/core/src/checkpoint.ts packages/core/src/backend.ts packages/core/test/client-internals.test.mjs
git commit -m "feat: add curation config checkpoint"
```

## Task 5: Curated Markdown Parser

**Files:**
- Create: `packages/core/src/curation/types.ts`
- Create: `packages/core/src/curation/markdown.ts`
- Modify: `packages/core/test/client-internals.test.mjs`

- [ ] **Step 1: Write parser tests**

In `packages/core/test/client-internals.test.mjs`, add:

```js
test('curation markdown parser derives parent and child observations', () => {
  const parsed = parseCurationMarkdown(`# Entity Memory: Caroline

## Who is Caroline?
<refs: [extraction:a]>

Caroline is a student.

### What changed recently?
<refs: [extraction:b]>

Caroline joined a support group.
`, new Set(['extraction:a', 'extraction:b']));

  assert.equal(parsed.title, 'Entity Memory: Caroline');
  assert.equal(parsed.observations.length, 2);
  assert.equal(parsed.observations[0].text, 'Who is Caroline?\\n\\nCaroline is a student.');
  assert.deepEqual(parsed.observations[0].references, ['extraction:a']);
  assert.equal(parsed.observations[1].text, 'Who is Caroline?\\nWhat changed recently?\\n\\nCaroline joined a support group.');
  assert.deepEqual(parsed.observations[1].references, ['extraction:a', 'extraction:b']);
});

test('curation markdown parser rejects unknown refs', () => {
  assert.throws(
    () => parseCurationMarkdown(`# Entity Memory: Caroline

## Who is Caroline?
<refs: [extraction:missing]>

Caroline is a student.
`, new Set(['extraction:a'])),
    /unknown extraction ref: extraction:missing/,
  );
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
source ~/.zprofile && node --test packages/core/test/client-internals.test.mjs
```

Expected: fails because parser does not exist.

- [ ] **Step 3: Implement types**

Create `packages/core/src/curation/types.ts`:

```ts
export type ParsedCurationDocument = {
  title: string;
  summary: string;
  content: string;
  references: string[];
  observations: ParsedCurationObservation[];
};

export type ParsedCurationObservation = {
  id?: string;
  text: string;
  references: string[];
};
```

- [ ] **Step 4: Implement parser**

Create `packages/core/src/curation/markdown.ts` with:

```ts
export function parseCurationMarkdown(raw: string, allowlist: Set<string>): ParsedCurationDocument;
```

Rules:

- Strip optional Markdown fences.
- Reject JSON-looking output.
- Require exactly one `#` title.
- Require at least one `##`.
- Reject `###` before any `##`.
- Require `<refs: [...]>` immediately after every `##` and `###` heading, allowing blank lines only after refs.
- Require non-empty body for every section.
- Deduplicate refs preserving order.
- Validate every ref is in the allowlist and starts with `extraction:`.
- Derive one observation for each `##`.
- Derive one observation for each `###`, prefixing the nearest parent `##` heading.
- Summary can be the first `##` body truncated by caller later; for parser return the first `##` body as `summary`.

- [ ] **Step 5: Run tests**

Run:

```bash
source ~/.zprofile && node --test packages/core/test/client-internals.test.mjs
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/curation/types.ts packages/core/src/curation/markdown.ts packages/core/test/client-internals.test.mjs
git commit -m "feat: parse curated memory markdown"
```

## Task 6: Curator LLM Adapter

**Files:**
- Create: `packages/core/src/llm/curating.ts`
- Modify: `packages/core/test/prompt-loader.test.mjs`
- Modify: `packages/core/test/provider-tools.test.mjs` if prompt rendering helpers require exports.

- [ ] **Step 1: Write prompt test**

In `packages/core/test/prompt-loader.test.mjs`, add:

```js
test('thread curating prompt uses compact content and extractions inputs', async () => {
  const rendered = await renderThreadCuratingPromptForTests({
    anchor: 'Caroline',
    content: '# Entity Memory: Caroline',
    extractions: [{
      id: 'abc',
      text: 'Caroline attended a support group.',
      context: 'Caroline discussed support.',
      anchors: ['Entity: Caroline', 'Fact: support group'],
      references: ['session:1'],
    }],
  });
  assert.match(rendered.system, /memory curator/);
  assert.match(rendered.user, /Entity anchor:/);
  assert.match(rendered.user, /Current curated content:/);
  assert.match(rendered.user, /Extraction units:/);
  assert.doesNotMatch(rendered.user, /existingCurationContent/);
  assert.doesNotMatch(rendered.user, /newOrChangedExtractions/);
});
```

- [ ] **Step 2: Run failing prompt test**

Run:

```bash
source ~/.zprofile && node --test packages/core/test/prompt-loader.test.mjs
```

Expected: fails because renderer does not exist or prompt lacks `content`.

- [ ] **Step 3: Update `thread-curating.yaml` input template**

Use compact names:

```yaml
user_template: |
  Entity anchor:
  {{entity_anchor}}

  Current curated content:
  {{content}}

  Extraction units:
  {{extractions}}
```

- [ ] **Step 4: Implement `curateThread`**

Create `packages/core/src/llm/curating.ts`:

```ts
export type CurateRequest = {
  anchor: string;
  content: string;
  extractions: Array<{
    id: string;
    text: string;
    context?: string | null;
    anchors?: string[];
    references: string[];
  }>;
};

export async function curateThread(
  request: CurateRequest,
  signal?: AbortSignal,
): Promise<string> {
  const config = getObserverLlmConfig();
  if (!config) {
    throw new Error('observer is required.');
  }
  const prompt = renderCuratingPrompt(request);
  return generateText(config, prompt, signal);
}
```

Render extraction units as readable Markdown, not JSON:

```md
### extraction:<id>
Anchors: Entity: Caroline; Fact: support group
Context: Caroline described why the support group mattered.
Text: Caroline attended an LGBTQ support group.
References: session:1, session:2
```

- [ ] **Step 5: Run prompt tests**

Run:

```bash
source ~/.zprofile && node --test packages/core/test/prompt-loader.test.mjs
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/llm/curating.ts packages/core/prompts/thread-curating.yaml packages/core/test/prompt-loader.test.mjs
git commit -m "feat: add curation prompt adapter"
```

## Task 7: Curation Runner And Observation Replacement

**Files:**
- Create: `packages/core/src/curation/runner.ts`
- Modify: `packages/core/src/observer/observer.ts`
- Modify: `packages/core/test/client-internals.test.mjs`

- [ ] **Step 1: Write runner tests with mocked curator**

In `packages/core/test/client-internals.test.mjs`, add:

```js
test('curation runner creates first snapshot when entity anchor reaches threshold', async () => {
  const tables = createMockNativeTables({
    extractions: [
      extractionRow('a', ['Entity: Caroline'], 'one'),
      extractionRow('b', ['Entity: Caroline'], 'two'),
      extractionRow('c', ['Entity: Caroline'], 'three'),
      extractionRow('d', ['Entity: Caroline'], 'four'),
      extractionRow('e', ['Entity: Caroline'], 'five'),
    ],
  });
  const calls = [];
  await runCuration({
    client: tables,
    observerName: 'default-observer',
    anchorThreshold: 5,
    curate: async (request) => {
      calls.push(request);
      return `# Entity Memory: Caroline

## Who is Caroline?
<refs: [extraction:a, extraction:b, extraction:c, extraction:d, extraction:e]>

Caroline is remembered from five extraction units.`;
    },
    embed: async () => [0.1, 0.2, 0.3, 0.4],
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].content, '');
  assert.equal(calls[0].extractions.length, 5);
  assert.equal(tables.curationTable.inserted.length, 1);
  assert.equal(tables.observationTable.replacements.length, 1);
});
```

Add a second test:

```js
test('curation runner skips anchors below threshold', async () => {
  const tables = createMockNativeTables({
    extractions: [
      extractionRow('a', ['Entity: Caroline'], 'one'),
      extractionRow('b', ['Entity: Caroline'], 'two'),
    ],
  });
  await runCuration({
    client: tables,
    observerName: 'default-observer',
    anchorThreshold: 5,
    curate: async () => { throw new Error('should not curate'); },
    embed: async () => [0.1, 0.2, 0.3, 0.4],
  });
  assert.equal(tables.curationTable.inserted.length, 0);
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
source ~/.zprofile && node --test packages/core/test/client-internals.test.mjs
```

Expected: fails because `runCuration` does not exist.

- [ ] **Step 3: Implement anchor grouping**

In `packages/core/src/curation/runner.ts`, implement:

```ts
export function entityAnchorKey(anchor: string): string | null {
  const match = anchor.match(/^Entity:\s*(.+)$/i);
  const value = match?.[1]?.split(/\s+/).join(' ').trim();
  return value ? `entity:${value.toLowerCase()}` : null;
}
```

Group extraction rows by this key. Keep display anchor from the first matching row.

- [ ] **Step 4: Implement run selection**

Implement:

```ts
export async function runCuration(params: {
  client: NativeTables;
  observerName: string;
  anchorThreshold: number;
  curate?: typeof curateThread;
  embed?: typeof embedText;
  signal?: AbortSignal;
}): Promise<void>
```

For each Entity anchor:

- Load all extraction rows with `client.extractionTable.list({ limit: 10_000 })`.
- If no latest curation and count `< anchorThreshold`, skip.
- If latest curation exists, calculate pending ids: current ids not in latest references.
- If no pending ids, skip.
- Pass `content` as latest content or empty string.
- Pass `extractions` as pending rows.

- [ ] **Step 5: Implement commit order**

After curator returns Markdown:

- Parse with `parseCurationMarkdown(markdown, allowlist)`.
- Embed each parsed observation text.
- Build `Observation[]` rows with stable ids:

```ts
function observationId(value: {
  curationId: string;
  text: string;
  references: string[];
}): string {
  return createHash('sha256')
    .update(JSON.stringify({
      curationId: value.curationId,
      text: value.text,
      references: [...value.references].sort(),
    }))
    .digest('hex')
    .slice(0, 24);
}
```

- Append `curation_snapshot`.
- Replace observations by `curation_id`.

- [ ] **Step 6: Integrate after extraction indexing**

In `packages/core/src/observer/observer.ts`, after `buildCurrentEpochIndex(result.touchedIds)` succeeds, call:

```ts
await runCuration({
  client: this.client,
  observerName: this.name,
  anchorThreshold: getCurationConfig().anchorThreshold,
  signal: this.shutdownController.signal,
});
```

Do not wire curation into recall.

- [ ] **Step 7: Run tests**

Run:

```bash
source ~/.zprofile && node --test packages/core/test/client-internals.test.mjs
source ~/.zprofile && pnpm --filter @muninn/core build
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/curation/runner.ts packages/core/src/observer/observer.ts packages/core/test/client-internals.test.mjs
git commit -m "feat: run entity curation after extraction"
```

## Task 8: Curation Checkpoint Recovery

**Files:**
- Modify: `packages/core/src/curation/runner.ts`
- Modify: `packages/core/src/observer/observer.ts`
- Modify: `packages/core/src/checkpoint.ts`
- Modify: `packages/core/test/client-internals.test.mjs`

- [ ] **Step 1: Write recovery tests**

Add tests:

```js
test('curation runner resumes generated content without recalling llm', async () => {
  let curateCalls = 0;
  const run = {
    runId: 'run-1',
    curationId: 'entity:caroline',
    anchor: 'Caroline',
    stage: 'generatingCuration',
    pendingExtractionIds: ['a', 'b', 'c', 'd', 'e'],
    generatedContent: `# Entity Memory: Caroline

## Who is Caroline?
<refs: [extraction:a]>

Caroline is remembered.`,
    errors: [],
  };
  await resumeCurationRun({
    client: createMockNativeTables({ extractions: [extractionRow('a', ['Entity: Caroline'], 'one')] }),
    run,
    curate: async () => {
      curateCalls += 1;
      throw new Error('should not call llm');
    },
    embed: async () => [0.1, 0.2, 0.3, 0.4],
  });
  assert.equal(curateCalls, 0);
});
```

Add snapshot-committed recovery:

```js
test('curation runner resumes observation replacement after snapshot commit', async () => {
  const tables = createMockNativeTables({ extractions: [extractionRow('a', ['Entity: Caroline'], 'one')] });
  const run = {
    runId: 'run-1',
    curationId: 'entity:caroline',
    anchor: 'Caroline',
    stage: 'committingObservations',
    pendingExtractionIds: ['a'],
    generatedContent: `# Entity Memory: Caroline

## Who is Caroline?
<refs: [extraction:a]>

Caroline is remembered.`,
    committedSnapshotId: 'curation:0',
    errors: [],
  };
  await resumeCurationRun({
    client: tables,
    run,
    curate: async () => { throw new Error('should not call llm'); },
    embed: async () => [0.1, 0.2, 0.3, 0.4],
  });
  assert.equal(tables.observationTable.replacements.length, 1);
});
```

- [ ] **Step 2: Run failing recovery tests**

Run:

```bash
source ~/.zprofile && node --test packages/core/test/client-internals.test.mjs
```

Expected: fails because `resumeCurationRun` is missing.

- [ ] **Step 3: Implement run progress mutation**

In `packages/core/src/curation/runner.ts`, add:

```ts
export async function resumeCurationRun(params: {
  client: NativeTables;
  run: CurationRun;
  curate?: typeof curateThread;
  embed?: typeof embedText;
  signal?: AbortSignal;
}): Promise<CurationRun>
```

Rules:

- If `generatedContent` is missing, load pending extraction ids and call curator.
- After generated content exists, parse and embed.
- If `committedSnapshotId` is missing, append snapshot and store returned id.
- Replace observations.
- Set stage to `completed`.
- On parse/validation error, set `failed` and do not write rows for failed output.

- [ ] **Step 4: Export checkpointed runs from observer**

In `packages/core/src/observer/observer.ts`, keep `checkpointCurationRuns` beside `checkpointRuns`. During `run()`, before shifting epochs, retry any curation run whose stage is not `completed` or `failed`.

Use:

```ts
private hasPendingCuration(): boolean {
  return this.checkpointCurationRuns.some((run) => run.stage !== 'completed' && run.stage !== 'failed');
}
```

Do not include completed runs in exported checkpoint.

- [ ] **Step 5: Run tests**

Run:

```bash
source ~/.zprofile && node --test packages/core/test/client-internals.test.mjs
source ~/.zprofile && pnpm --filter @muninn/core build
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/curation/runner.ts packages/core/src/observer/observer.ts packages/core/src/checkpoint.ts packages/core/test/client-internals.test.mjs
git commit -m "feat: checkpoint curation runs"
```

## Task 9: Documentation And Full Verification

**Files:**
- Modify: `format/README.md`
- Modify: `docs/superpowers/specs/2026-05-13-curation-snapshot-observation-design.md` only if implementation discovers a necessary correction.

- [ ] **Step 1: Update Rust format docs**

In `format/README.md`, add the current table story:

```md
## Memory Tables

- `turn`: persisted conversation turns.
- `session_snapshot`: append-only session-level memory documents.
- `extraction`: session-level index rows derived from session snapshots.
- `curation_snapshot`: append-only curated documents grouped by Entity anchor.
- `observation`: latest thin searchable rows derived from curation snapshots.
```

- [ ] **Step 2: Run full verification**

Run:

```bash
cargo test
source ~/.zprofile && pnpm --filter @muninn/core build
source ~/.zprofile && node --test packages/core/test/prompt-loader.test.mjs packages/core/test/client-internals.test.mjs
```

Expected: all pass.

- [ ] **Step 3: Check worktree**

Run:

```bash
git status --short
git diff --check
```

Expected: only intended docs if any; no whitespace errors.

- [ ] **Step 4: Commit**

```bash
git add format/README.md docs/superpowers/specs/2026-05-13-curation-snapshot-observation-design.md
git commit -m "docs: document curation observation layers"
```

## Self-Review Checklist

- Spec coverage: data model, Entity threshold trigger, incremental curation, checkpoint recovery, Markdown parser, append-only curation snapshots, replace-by-`curation_id` observations, and no recall merge are covered.
- Placeholder scan: the plan intentionally contains concrete file paths, function names, tests, commands, and expected outcomes.
- Type consistency: `curationId` / `curation_id`, `content`, and `extractions` are the compact names used at the TS prompt boundary; Rust structs keep snake_case through serde camelCase.
- MVP boundary: no same-name entity disambiguation, no non-Entity curation, no recall merge, no old format compatibility.
