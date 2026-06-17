# Project Dreaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build project-level dreaming from session snapshot signals, storing append-only project dream documents and exposing latest top project signals through server and MCP reads.

**Architecture:** Rust owns persisted Lance table schemas and row-id assignment for `session_snapshot.signals` and the new `dreaming` table. TypeScript owns prompt execution, Markdown validation/parsing, `DreamingIndex`, server routes, maintenance checkpoint floors, and MCP forwarding. The dreamer reuses the extractor LLM provider; there is no separate `dreamer` config field.

**Tech Stack:** Rust `muninn-format`, NAPI `server/native`, TypeScript server runtime, Hono HTTP routes, MCP SDK, Markdown prompt files, Node test runner, Cargo tests.

---

## File Map

- Modify `format/src/schema.rs`: add `signals` to `session_schema()` and add `dreaming_schema()`.
- Modify `format/src/memory_id.rs`: add `MemoryLayer::Dreaming` for `dreaming:<rowid>`.
- Modify `format/src/session.rs`: add `signals` to `SessionSnapshot`; return source-versioned session reads for dreaming.
- Modify `format/src/codec.rs`: encode/decode `session_snapshot.signals`; encode/decode `Dreaming` rows.
- Create `format/src/dreaming.rs`: append-only `DreamingTable`.
- Modify `format/src/lib.rs`: export `Dreaming` and `DreamingTable`.
- Modify `server/native/src/lib.rs`: expose `dreaming*` NAPI functions and source-versioned session reads.
- Modify `server/src/native.ts`: add TS row types, source-versioned session reads, dreaming table binding, and mutation locks.
- Modify `server/src/pipeline/session.ts`: write and read `SessionSnapshot.signals` as the authoritative runtime field.
- Create `server/prompts/project-dreamer.yaml`: exact project dreamer prompt.
- Modify `server/src/llm/prompts.ts`: add `project_dreaming` prompt key.
- Create `server/src/dreaming/content.ts`: Markdown validation and top-signal parsing.
- Create `server/src/dreaming/project-dreamer.ts`: prompt rendering, mock dreamer, LLM retry loop.
- Create `server/src/dreaming/index.ts`: `DreamingIndex`.
- Create `server/src/dreaming/service.ts`: source selection, dream append, read APIs.
- Modify `server/src/checkpoint.ts`: add `DreamingIndexCheckpoint` and bump checkpoint schema to `11`.
- Modify `server/src/backend.ts`: instantiate/export dreaming service and expose `dreaming` API facade.
- Modify `server/src/watchdog.ts`: include latest-project dream `sessionSnapshotVersion` in the session cleanup floor.
- Modify `server/src/http.ts`: add `/api/v1/dreaming/project` routes.
- Modify `common/src/api.ts`: add response/request contracts for project dream reads.
- Modify `mcp/src/server-client.ts`: add `projectSignals()` request.
- Modify `mcp/src/index.ts`: add thin `project_signals` MCP tool.
- Add/update tests under `server/test/memory`, `server/test`, and Rust module tests listed in each task.

Before implementation, run `git status --short` and inspect existing dirty files. At plan creation time, `server/prompts/extractor.yaml` and `server/test/memory/prompt-loader.test.mjs` were already modified; do not overwrite their user-owned changes.

---

### Task 1: Persist Session Signals and Source-Versioned Reads

**Files:**
- Modify: `format/src/schema.rs`
- Modify: `format/src/session.rs`
- Modify: `format/src/codec.rs`
- Modify: `server/src/native.ts`
- Modify: `server/native/src/lib.rs`
- Modify: `server/src/pipeline/session.ts`
- Test: `format/src/schema.rs`
- Test: `format/src/session.rs`
- Test: `server/test/memory/client-internals.test.mjs`
- Test: `server/test/memory/session-index-runtime.test.mjs`

- [ ] **Step 1: Write failing Rust schema and session round-trip tests**

Add this schema test in `format/src/schema.rs`:

```rust
#[test]
fn session_schema_has_signals_field() {
    let schema = session_schema();
    assert!(schema.field_with_name("signals").is_ok());
    assert_eq!(schema.field_with_name("signals").unwrap().data_type(), &DataType::Utf8);
}
```

Add this session test in `format/src/session.rs`:

```rust
#[tokio::test]
async fn session_signals_roundtrip_and_delta_returns_source_version() {
    let dir = tempfile::tempdir().unwrap();
    let table = SessionTable::new(TableOptions::local(dir.path()).unwrap());
    let mut rows = vec![SessionSnapshot {
        snapshot_id: MemoryId::new(MemoryLayer::Session, u64::MAX),
        session_id: "session-a".to_string(),
        project: "muninn".to_string(),
        cwd: "/repo/muninn".to_string(),
        agent: "codex".to_string(),
        snapshot_sequence: 0,
        created_at: Utc::now(),
        updated_at: Utc::now(),
        extractor: "default-observer".to_string(),
        title: "Session Title".to_string(),
        summary: "Session summary".to_string(),
        signals: "- [2] Keep schemas minimal.".to_string(),
        content: "# Session Title\n\n## Summary\nSession summary\n\n## Signals\n- [2] Keep schemas minimal.".to_string(),
        references: vec!["turn:7".to_string()],
    }];

    table.insert(&mut rows).await.unwrap();
    let loaded = table.get(rows[0].snapshot_id.memory_point()).await.unwrap().unwrap();
    assert_eq!(loaded.signals, "- [2] Keep schemas minimal.");

    let delta = table.delta("default-observer", 0).await.unwrap();
    assert_eq!(delta.rows.len(), 1);
    assert_eq!(delta.rows[0].signals, "- [2] Keep schemas minimal.");
    assert!(delta.source_version > 0);

    let scanned = table.list_with_version(Some("default-observer")).await.unwrap();
    assert_eq!(scanned.rows.len(), 1);
    assert_eq!(scanned.source_version, delta.source_version);
}
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
cargo test --manifest-path format/Cargo.toml session_schema_has_signals_field session_signals_roundtrip_and_delta_returns_source_version
```

Expected: fails because `signals` is not in `SessionSnapshot`, `session_schema()`, or the session codec, and `SessionTable::delta()` still returns `Vec<SessionSnapshot>`.

- [ ] **Step 3: Implement Rust session storage changes**

In `format/src/schema.rs`, add the field immediately after `summary`:

```rust
Field::new("signals", DataType::Utf8, false),
```

In `format/src/session.rs`, add:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceRows<T> {
    pub source_version: u64,
    pub rows: Vec<T>,
}
```

Add `signals` to `SessionSnapshot`:

```rust
pub signals: String,
```

Change `SessionTable::list()` and `SessionTable::delta()` shapes:

```rust
pub async fn list_with_version(&self, extractor: Option<&str>) -> Result<SourceRows<SessionSnapshot>> {
    let Some(dataset) = self.access.try_open().await? else {
        return Ok(SourceRows { source_version: 0, rows: Vec::new() });
    };
    let source_version = dataset.version().version;
    let batch = dataset.scan().with_row_id().try_into_batch().await?;
    let mut rows = if batch.num_rows() == 0 {
        Vec::new()
    } else {
        record_batch_to_session_snapshots(&batch)?
    };
    if let Some(extractor) = extractor {
        rows.retain(|snapshot| snapshot.extractor == extractor);
    }
    Ok(SourceRows { source_version, rows })
}

pub async fn list(&self, extractor: Option<&str>) -> Result<Vec<SessionSnapshot>> {
    Ok(self.list_with_version(extractor).await?.rows)
}

pub async fn delta(
    &self,
    extractor: &str,
    baseline_version: u64,
) -> Result<SourceRows<SessionSnapshot>> {
    let Some(dataset) = self.access.try_open().await? else {
        return Ok(SourceRows { source_version: 0, rows: Vec::new() });
    };
    let source_version = dataset.version().version;
    if source_version <= baseline_version {
        return Ok(SourceRows { source_version, rows: Vec::new() });
    }
    let delta = dataset.delta().compared_against_version(baseline_version).build()?;
    let mut inserted = delta.get_inserted_rows().await?;
    let mut rows = Vec::new();
    while let Some(batch) = inserted.try_next().await? {
        if batch.num_rows() == 0 {
            continue;
        }
        rows.extend(
            record_batch_to_session_snapshots(&batch)?
                .into_iter()
                .filter(|row| row.extractor == extractor),
        );
    }
    rows.sort_by(|left, right| {
        left.snapshot_sequence
            .cmp(&right.snapshot_sequence)
            .then(left.created_at.cmp(&right.created_at))
            .then(left.updated_at.cmp(&right.updated_at))
            .then(left.snapshot_id.cmp(&right.snapshot_id))
    });
    Ok(SourceRows { source_version, rows })
}
```

In `format/src/codec.rs`, add `signals` arrays between `summary` and `content`, and shift decode column indexes accordingly:

```rust
let signals = StringArray::from_iter_values(
    session_snapshots.iter().map(|session_snapshot| session_snapshot.signals.as_str()),
);
```

The record batch column order must be:

```rust
session_id, project, cwd, agent, snapshot_sequence, created_at, updated_at,
extractor, title, summary, signals, content, references
```

When decoding, read:

```rust
let signals = batch.column(10).as_any().downcast_ref::<StringArray>().unwrap();
let content = batch.column(11).as_any().downcast_ref::<StringArray>().unwrap();
let references = batch.column(12).as_any().downcast_ref::<ListArray>().unwrap();
```

and populate:

```rust
signals: signals.value(index).to_string(),
content: content.value(index).to_string(),
```

- [ ] **Step 4: Update TypeScript native binding shape and consumers**

In `server/src/native.ts`, add:

```ts
export type SourceRows<T> = {
  sourceVersion: number;
  rows: T[];
};
```

Add `signals: string` to `SessionSnapshotRow`, and change session table methods:

```ts
sessionDelta(params: {
  observer: string;
  baselineVersion: number;
}): MaybePromise<SourceRows<SessionSnapshotRow>>;
sessionListSnapshotsWithVersion(params: {
  observer?: string;
}): MaybePromise<SourceRows<SessionSnapshotRow>>;
```

In `SessionTableBinding`, add:

```ts
listSnapshotsWithVersion(params: { observer?: string }): Promise<SourceRows<SessionSnapshotRow>>;
delta(params: { observer: string; baselineVersion: number }): Promise<SourceRows<SessionSnapshotRow>>;
```

Keep existing `listSnapshots()` returning rows:

```ts
listSnapshots: async (params) => resolveNativeResult(native.sessionListSnapshots(params)),
listSnapshotsWithVersion: async (params) => resolveNativeResult(native.sessionListSnapshotsWithVersion(params)),
delta: async (params) => resolveNativeResult(native.sessionDelta(params)),
```

Update existing consumers:

```ts
const sessionDelta = await client.sessionTable.delta({
  observer: this.extractorName,
  baselineVersion: this.baseline.session,
});
this.applySnapshots(sessionDelta.rows);
```

In `server/src/pipeline/extractor.ts`, wherever `sessionTable.delta()` is used, read `.rows`.

In `server/src/pipeline/session.ts`, add `signals: string` to `SessionSnapshot`, set `signals: snapshot.signals ?? ''` in `toSessionSnapshot()`, and in `deserializeSnapshot()` use the field as authoritative:

```ts
signals: row.signals,
```

- [ ] **Step 5: Expose source-versioned reads through NAPI**

In `server/native/src/lib.rs`, add:

```rust
#[napi(js_name = "sessionListSnapshotsWithVersion")]
pub async fn session_list_snapshots_with_version(&self, params: Value) -> NapiResult<Value> {
    let params = parse_params::<SessionListSnapshotsParams>(params)?;
    let resources = self.resources().await?;
    into_napi_value(resources.session_table.list_with_version(params.observer.as_deref()).await)
}
```

Update `session_delta()` to return the new `SourceRows<SessionSnapshot>` value from Rust.

- [ ] **Step 6: Run focused tests**

Run:

```bash
cargo test --manifest-path format/Cargo.toml session_schema_has_signals_field session_signals_roundtrip_and_delta_returns_source_version
pnpm --filter @muninn/server build
node --test server/test/memory/session-index-runtime.test.mjs server/test/memory/client-internals.test.mjs
```

Expected: all listed tests pass.

- [ ] **Step 7: Commit**

```bash
git add format/src/schema.rs format/src/session.rs format/src/codec.rs server/native/src/lib.rs server/src/native.ts server/src/pipeline/session.ts server/src/pipeline/extractor.ts server/test/memory/session-index-runtime.test.mjs server/test/memory/client-internals.test.mjs
git commit -m "feat: persist session snapshot signals"
```

---

### Task 2: Add Dreaming Storage Table and `dreaming:<rowid>` IDs

**Files:**
- Modify: `format/src/schema.rs`
- Modify: `format/src/memory_id.rs`
- Modify: `format/src/codec.rs`
- Create: `format/src/dreaming.rs`
- Modify: `format/src/lib.rs`
- Modify: `server/native/src/lib.rs`
- Modify: `server/src/native.ts`
- Test: `format/src/memory_id.rs`
- Test: `format/src/dreaming.rs`
- Test: `server/test/memory/client.test.mjs`

- [ ] **Step 1: Write failing Rust tests**

In `format/src/memory_id.rs`, add:

```rust
#[test]
fn dreaming_memory_id_roundtrip() {
    let parsed = MemoryId::from_str("dreaming:7").unwrap();
    assert_eq!(parsed.memory_layer(), MemoryLayer::Dreaming);
    assert_eq!(parsed.memory_point(), 7);
    assert_eq!(parsed.to_string(), "dreaming:7");
}
```

Create `format/src/dreaming.rs` with this test module at the bottom after implementation targets are declared:

```rust
#[cfg(test)]
mod tests {
    use chrono::Utc;
    use tempfile::tempdir;

    use super::{Dreaming, DreamingTable};
    use crate::{MemoryId, MemoryLayer, TableOptions};

    #[tokio::test]
    async fn append_assigns_dreaming_id_and_roundtrips() {
        let dir = tempdir().unwrap();
        let table = DreamingTable::new(TableOptions::local(dir.path()).unwrap());
        let mut row = Dreaming {
            dreaming_id: MemoryId::new(MemoryLayer::Dreaming, u64::MAX),
            project: "/repo/muninn".to_string(),
            parent_id: None,
            created_at: Utc::now(),
            session_snapshot_version: 5,
            content: "# Project Dream\n\n## Signals\n\n### Guidance\n- [2] Keep schemas minimal.\n\n### Skills\n\n### Open Questions".to_string(),
        };

        table.append(&mut row).await.unwrap();
        assert_ne!(row.dreaming_id.memory_point(), u64::MAX);

        let loaded = table.get(row.dreaming_id.memory_point()).await.unwrap().unwrap();
        assert_eq!(loaded.project, "/repo/muninn");
        assert_eq!(loaded.parent_id, None);
        assert_eq!(loaded.session_snapshot_version, 5);
        assert!(loaded.content.contains("Keep schemas minimal"));
    }
}
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
cargo test --manifest-path format/Cargo.toml dreaming_memory_id_roundtrip append_assigns_dreaming_id_and_roundtrips
```

Expected: fails because `MemoryLayer::Dreaming`, `Dreaming`, `DreamingTable`, and `dreaming_schema()` do not exist.

- [ ] **Step 3: Implement Rust memory id and schema**

In `format/src/memory_id.rs`, add enum variant and string mappings:

```rust
Dreaming,
```

```rust
Self::Dreaming => "dreaming",
```

```rust
"dreaming" => Ok(Self::Dreaming),
```

In `format/src/schema.rs`, add:

```rust
pub fn dreaming_schema() -> Schema {
    Schema::new(vec![
        Field::new("project", DataType::Utf8, false),
        Field::new("parent_id", DataType::UInt64, true),
        Field::new(
            "created_at",
            DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())),
            false,
        ),
        Field::new("session_snapshot_version", DataType::UInt64, false),
        Field::new("content", DataType::Utf8, false),
    ])
}
```

- [ ] **Step 4: Implement dreaming codec**

In `format/src/codec.rs`, add encode/decode helpers with this column order:

```rust
project, parent_id, created_at, session_snapshot_version, content
```

The row id is not a schema column. Decode it as:

```rust
dreaming_id: MemoryId::new(MemoryLayer::Dreaming, row_ids[index]),
```

- [ ] **Step 5: Implement `DreamingTable`**

Create `format/src/dreaming.rs`:

```rust
use chrono::{DateTime, Utc};
use futures_util::TryStreamExt;
use lance::{Error, Result};
use object_store::path::Path;
use serde::{Deserialize, Serialize};

use super::access::{LanceDataset, TableAccess, TableDescription, TableOptions, describe_dataset};
use super::codec::{dreamings_to_reader, record_batch_to_dreamings, record_batch_to_dreamings_with_row_ids};
use super::memory_id::{MemoryId, MemoryLayer, deserialize_memory_id, serialize_memory_id};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Dreaming {
    #[serde(serialize_with = "serialize_memory_id", deserialize_with = "deserialize_memory_id")]
    pub dreaming_id: MemoryId,
    pub project: String,
    pub parent_id: Option<u64>,
    pub created_at: DateTime<Utc>,
    pub session_snapshot_version: u64,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct DreamingTable {
    access: TableAccess,
}
```

Implement methods:

```rust
pub fn new(options: TableOptions) -> Self
pub async fn try_open_dataset(&self) -> Result<Option<LanceDataset>>
pub async fn stats(&self) -> Result<Option<TableStats>>
pub async fn describe(&self) -> Result<Option<TableDescription>>
pub async fn list(&self) -> Result<Vec<Dreaming>>
pub async fn get(&self, row_id: u64) -> Result<Option<Dreaming>>
pub async fn append(&self, row: &mut Dreaming) -> Result<()>
pub async fn delta(&self, baseline_version: u64) -> Result<SourceRows<Dreaming>>
```

`append()` must require `dreaming_id.memory_point() == u64::MAX`, write one row, and assign the stable row id from Lance delta or scan, mirroring `SessionTable::insert()`.

- [ ] **Step 6: Export Rust and native bindings**

In `format/src/lib.rs`, add:

```rust
pub mod dreaming;
pub use dreaming::{Dreaming, DreamingTable};
```

In `server/native/src/lib.rs`, add `dreaming_table: DreamingTable` to `CoreResources`, initialize it, and add NAPI methods:

```rust
dreamingGet
dreamingList
dreamingDelta
dreamingAppend
dreamingTableStats
describeDreamingTable
```

In `server/src/native.ts`, add:

```ts
export type DreamingRow = {
  dreamingId: string;
  project: string;
  parentId?: number | null;
  createdAt: string;
  sessionSnapshotVersion: number;
  content: string;
};
```

Add `DreamingTableBinding` with `get`, `list`, `delta`, `append`, `stats`, and `describe`. Add `dreamingTable` to `NativeTables` and to `lockNativeTables()` with table name `'dreaming'`.

- [ ] **Step 7: Run focused tests**

Run:

```bash
cargo test --manifest-path format/Cargo.toml dreaming
cargo check --manifest-path server/native/Cargo.toml
pnpm --filter @muninn/server build
node --test server/test/memory/client.test.mjs
```

Expected: all listed tests pass, and `client.test.mjs` confirms `binding.dreamingTable.describe` exists.

- [ ] **Step 8: Commit**

```bash
git add format/src/schema.rs format/src/memory_id.rs format/src/codec.rs format/src/dreaming.rs format/src/lib.rs server/native/src/lib.rs server/src/native.ts server/test/memory/client.test.mjs
git commit -m "feat: add dreaming storage table"
```

---

### Task 3: Add Project Dream Prompt and Markdown Contract Helpers

**Files:**
- Create: `server/prompts/project-dreamer.yaml`
- Modify: `server/src/llm/prompts.ts`
- Create: `server/src/dreaming/content.ts`
- Test: `server/test/memory/prompt-loader.test.mjs`
- Test: `server/test/memory/project-dream-content.test.mjs`

- [ ] **Step 1: Write failing prompt and Markdown tests**

Add to `server/test/memory/prompt-loader.test.mjs`:

```js
test('project dreamer prompt merges incremental project signals without session refs', () => {
  const template = loadPromptTemplate('project_dreaming');
  const system = template.system;
  assert.match(system, /project dreaming agent/i);
  assert.match(system, /Merge the parent dream with incremental project signals/);
  assert.match(system, /Merge only signals that express the same underlying guidance/);
  assert.match(system, /add their numeric weights/);
  assert.match(system, /Do not cap weights at a fixed maximum/);
  assert.doesNotMatch(system, /session:<rowid>/);
  assert.doesNotMatch(system, /\(refs:/);
  assert.match(template.userTemplate, /## Parent Dream/);
  assert.match(template.userTemplate, /## Incremental Signals/);
  assert.doesNotMatch(template.userTemplate, /### session:/);
});
```

Create `server/test/memory/project-dream-content.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseProjectDreamSignals,
  validateProjectDreamContent,
} from '../../dist/dreaming/content.js';

test('project dream content parser returns top weighted signals per category', () => {
  const content = [
    '# Project Dream',
    '',
    '## Signals',
    '',
    '### Guidance',
    '- [2] Use minimal schemas.',
    '- [9] Preserve project identifiers exactly.',
    '',
    '### Skills',
    '- [4] Prompt review:',
    '  - Check exact prompt diffs.',
    '',
    '### Open Questions',
    '- [1] Decide whether dreams participate in recall.',
  ].join('\n');

  validateProjectDreamContent(content);
  assert.deepEqual(parseProjectDreamSignals(content, 1), {
    guidance: ['- [9] Preserve project identifiers exactly.'],
    skills: ['- [4] Prompt review:\n  - Check exact prompt diffs.'],
    openQuestions: ['- [1] Decide whether dreams participate in recall.'],
  });
});

test('project dream content rejects refs and session ids', () => {
  assert.throws(
    () => validateProjectDreamContent('# Project Dream\n\n## Signals\n\n### Guidance\n- [1] Keep refs. (refs: session:1)\n\n### Skills\n\n### Open Questions'),
    /must not include session refs/i,
  );
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm --filter @muninn/server build
node --test server/test/memory/prompt-loader.test.mjs server/test/memory/project-dream-content.test.mjs
```

Expected: fails because the prompt key, prompt file, and content helpers do not exist.

- [ ] **Step 3: Add exact prompt file**

Create `server/prompts/project-dreamer.yaml`:

```yaml
system: |
  You are Muninn's project dreaming agent.

  Your job
  - Maintain one compact project-level dream document for future agents working in this project.
  - Merge the parent dream with incremental project signals.
  - Return a full Markdown project dream document, not a patch.
  - Return Markdown only; do not wrap the response in a code fence or add prose outside the document.

  Inputs
  - Parent dream content, if one exists.
  - Incremental project signals selected for this merge.

  Signal definition
  - A signal is reusable project guidance extracted from prior work: preferences, corrections, conventions, decisions, workflow patterns, recurring environment facts, or unresolved questions that can affect future agent behavior.
  - Each output signal must be understandable and actionable without the original conversation context.

  Merge rules
  - Merge only signals that express the same underlying guidance into one clear project-level signal; add their numeric weights.
  - Do not increase a parent-only signal's weight unless incremental signals support it.
  - When incremental signals correct or supersede a parent signal, do not add the contradicted parent weight; rewrite or remove the parent signal.
  - Write in the conversation's primary language; preserve code, command, file, API, schema, and project identifiers exactly.
  - Do not invent facts, user preferences, decisions, or open questions.

  Signal types
  - Guidance: future behavior guidance, including preferences, corrections, repo conventions, decision standards, review style, and recurring environment quirks.
  - Skills: reusable workflow candidates, not installed skills.
  - Open Questions: unresolved decisions, blockers, or user confirmations that affect future work; remove once resolved.

  Signal weights
  - Use weight marker format `[N]`, where `N` is a positive integer.
  - Do not cap weights at a fixed maximum.
  - Treat weight as accumulated support, not as a bounded category label.
  - Output each merged signal's accumulated support score after semantic normalization.
  - If an input signal is useful but has no readable weight marker, treat it as `[1]`.
  - Sort top-level bullets by weight descending within each category.

  Budget
  - Keep at most 20 top-level bullets under each signal category.
  - These are upper bounds, not targets to fill.
  - Do not add filler bullets.
  - Guidance and Open Questions should use concise top-level bullets.
  - Skills may use nested bullets for workflow steps, checks, and expected output, but nested bullets do not count as extra top-level signals.

  Output format
  - Output exactly one Markdown document.
  - Start with `# Project Dream`.
  - Include `## Signals`.
  - Include `### Guidance`, `### Skills`, and `### Open Questions` in that order.
  - Each top-level signal bullet must start with a weight marker like `- [4]`.

user_template: |
  # Project Dreaming Input

  ## Project
  {{project}}

  ## Parent Dream
  {{parent_dream}}

  ## Incremental Signals
  {{incremental_signals}}
```

Add to `PROMPT_FILE_NAMES`:

```ts
project_dreaming: 'project-dreamer',
```

- [ ] **Step 4: Implement content helpers**

Create `server/src/dreaming/content.ts` with:

```ts
export type ProjectDreamSignals = {
  guidance: string[];
  skills: string[];
  openQuestions: string[];
};

export function validateProjectDreamContent(content: string): void {
  const text = stripFence(content).trim();
  if (!text.startsWith('# Project Dream')) {
    throw new Error('project dream content must start with # Project Dream');
  }
  if (!/^## Signals$/m.test(text)) {
    throw new Error('project dream content must include ## Signals');
  }
  for (const heading of ['### Guidance', '### Skills', '### Open Questions']) {
    if (!text.includes(heading)) {
      throw new Error(`project dream content must include ${heading}`);
    }
  }
  if (/\(refs:\s*session:\d+/i.test(text) || /session:<rowid>/i.test(text)) {
    throw new Error('project dream content must not include session refs');
  }
}

export function normalizeProjectDreamContent(content: string): string {
  const text = stripFence(content).trim();
  validateProjectDreamContent(text);
  return text;
}

export function parseProjectDreamSignals(content: string, limit = 5): ProjectDreamSignals {
  const text = normalizeProjectDreamContent(content);
  return {
    guidance: parseCategory(text, '### Guidance', limit),
    skills: parseCategory(text, '### Skills', limit),
    openQuestions: parseCategory(text, '### Open Questions', limit),
  };
}

function stripFence(content: string): string {
  const trimmed = content.trim();
  const match = /^```(?:markdown|md)?\n([\s\S]*?)\n```$/i.exec(trimmed);
  return match ? match[1] : trimmed;
}

function parseCategory(content: string, heading: string, limit: number): string[] {
  const start = content.indexOf(heading);
  if (start < 0) {
    return [];
  }
  const afterHeading = content.slice(start + heading.length).split('\n');
  const blocks: Array<{ weight: number; index: number; text: string }> = [];
  let current: string[] | null = null;

  for (const line of afterHeading) {
    if (line.startsWith('### ')) {
      break;
    }
    if (/^- \[\d+\]\s+/.test(line)) {
      if (current) {
        blocks.push(block(current, blocks.length));
      }
      current = [line];
      continue;
    }
    if (current && (line.startsWith('  ') || line.trim() === '')) {
      current.push(line);
    }
  }
  if (current) {
    blocks.push(block(current, blocks.length));
  }

  return blocks
    .sort((left, right) => right.weight - left.weight || left.index - right.index)
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.text);
}

function block(lines: string[], index: number): { weight: number; index: number; text: string } {
  const text = lines.join('\n').trimEnd();
  const weight = Number(/^- \[(\d+)\]/.exec(lines[0])?.[1] ?? '1');
  return { weight, index, text };
}
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm --filter @muninn/server build
node --test server/test/memory/prompt-loader.test.mjs server/test/memory/project-dream-content.test.mjs
```

Expected: both test files pass.

- [ ] **Step 6: Commit**

```bash
git add server/prompts/project-dreamer.yaml server/src/llm/prompts.ts server/src/dreaming/content.ts server/test/memory/prompt-loader.test.mjs server/test/memory/project-dream-content.test.mjs
git commit -m "feat: add project dreamer prompt"
```

---

### Task 4: Add DreamingIndex and Checkpoint State

**Files:**
- Create: `server/src/dreaming/index.ts`
- Modify: `server/src/checkpoint.ts`
- Modify: `server/src/backend.ts`
- Test: `server/test/memory/dreaming-index.test.mjs`
- Test: `server/test/memory/session-index-checkpoint.test.mjs`

- [ ] **Step 1: Write failing DreamingIndex tests**

Create `server/test/memory/dreaming-index.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { DreamingIndex } from '../../dist/dreaming/index.js';

function client({ rows = [], deltaRows = [], version = 10 } = {}) {
  const calls = { list: 0, delta: 0 };
  return {
    calls,
    tables: {
      dreamingTable: {
        list: async () => {
          calls.list += 1;
          return rows;
        },
        delta: async () => {
          calls.delta += 1;
          return { sourceVersion: version, rows: deltaRows };
        },
        stats: async () => ({ version, rowCount: rows.length, fragmentCount: 1 }),
      },
    },
  };
}

test('DreamingIndex rebuild selects latest dream per project by row id', async () => {
  const fake = client({
    rows: [
      { dreamingId: 'dreaming:2', project: '/repo/a', parentId: null, createdAt: '2026-06-18T00:00:00Z', sessionSnapshotVersion: 4, content: '# Project Dream' },
      { dreamingId: 'dreaming:5', project: '/repo/a', parentId: 2, createdAt: '2026-06-18T01:00:00Z', sessionSnapshotVersion: 8, content: '# Project Dream' },
      { dreamingId: 'dreaming:3', project: '/repo/b', parentId: null, createdAt: '2026-06-18T00:30:00Z', sessionSnapshotVersion: 7, content: '# Project Dream' },
    ],
    version: 9,
  });
  const index = new DreamingIndex(null);
  assert.deepEqual(await index.list(fake.tables), [
    { project: '/repo/a', dreamingId: 'dreaming:5', parentId: 'dreaming:2', createdAt: '2026-06-18T01:00:00Z', sessionSnapshotVersion: 8 },
    { project: '/repo/b', dreamingId: 'dreaming:3', createdAt: '2026-06-18T00:30:00Z', sessionSnapshotVersion: 7 },
  ]);
  assert.equal(fake.calls.list, 1);
});

test('DreamingIndex cleanup floor is min latest-project session snapshot version', async () => {
  const index = new DreamingIndex({
    baseline: { dreaming: 4 },
    entries: [
      { project: '/repo/a', dreamingId: 'dreaming:5', createdAt: '2026-06-18T01:00:00Z', sessionSnapshotVersion: 8 },
      { project: '/repo/b', dreamingId: 'dreaming:6', createdAt: '2026-06-18T02:00:00Z', sessionSnapshotVersion: 3 },
    ],
  });
  assert.equal(index.sessionSnapshotFloor(), 3);
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
pnpm --filter @muninn/server build
node --test server/test/memory/dreaming-index.test.mjs
```

Expected: fails because `server/src/dreaming/index.ts` does not exist.

- [ ] **Step 3: Implement DreamingIndex**

Create `server/src/dreaming/index.ts`:

```ts
import type { DreamingRow, NativeTables } from '../native.js';
import type { DreamingIndexCheckpoint, DreamingIndexEntry } from '../checkpoint.js';

export class DreamingIndex {
  private entries = new Map<string, DreamingIndexEntry>();
  private baseline: DreamingIndexCheckpoint['baseline'];
  private dirty = false;

  constructor(checkpoint: DreamingIndexCheckpoint | null) {
    this.baseline = checkpoint?.baseline ?? { dreaming: 0 };
    for (const entry of checkpoint?.entries ?? []) {
      this.entries.set(entry.project, { ...entry });
    }
  }

  markDirty(): void {
    this.dirty = true;
  }

  async list(client: NativeTables): Promise<DreamingIndexEntry[]> {
    await this.ensureFresh(client);
    return [...this.entries.values()].map((entry) => ({ ...entry }))
      .sort((left, right) => left.project.localeCompare(right.project));
  }

  async latest(client: NativeTables, project: string): Promise<DreamingIndexEntry | null> {
    await this.ensureFresh(client);
    return this.entries.get(project) ?? null;
  }

  async exportCheckpoint(client: NativeTables): Promise<DreamingIndexCheckpoint> {
    await this.ensureFresh(client);
    return {
      baseline: { ...this.baseline },
      entries: this.sortedEntries(),
    };
  }

  sessionSnapshotFloor(): number | null {
    const versions = [...this.entries.values()].map((entry) => entry.sessionSnapshotVersion);
    return versions.length === 0 ? null : Math.min(...versions);
  }

  private async ensureFresh(client: NativeTables): Promise<void> {
    if (this.dirty || this.baseline.dreaming === 0) {
      await this.rebuild(client);
      return;
    }

    const delta = await client.dreamingTable.delta({ baselineVersion: this.baseline.dreaming });
    this.applyRows(delta.rows);
    this.baseline = { dreaming: delta.sourceVersion };
  }

  private async rebuild(client: NativeTables): Promise<void> {
    const rows = await client.dreamingTable.list();
    this.entries.clear();
    this.applyRows(rows);
    const stats = await client.dreamingTable.stats();
    this.baseline = { dreaming: stats.version };
    this.dirty = false;
  }

  private applyRows(rows: DreamingRow[]): void {
    for (const row of rows) {
      const next = this.entry(row);
      const current = this.entries.get(row.project);
      if (!current || rowId(next.dreamingId) > rowId(current.dreamingId)) {
        this.entries.set(row.project, next);
      }
    }
  }

  private entry(row: DreamingRow): DreamingIndexEntry {
    return {
      project: row.project,
      dreamingId: row.dreamingId,
      parentId: row.parentId == null ? undefined : `dreaming:${row.parentId}`,
      createdAt: row.createdAt,
      sessionSnapshotVersion: row.sessionSnapshotVersion,
    };
  }

  private sortedEntries(): DreamingIndexEntry[] {
    return [...this.entries.values()]
      .map((entry) => ({ ...entry }))
      .sort((left, right) => left.project.localeCompare(right.project));
  }
}

function rowId(dreamingId: string): number {
  const match = /^dreaming:(\d+)$/.exec(dreamingId);
  if (!match) {
    throw new Error(`invalid dreaming id: ${dreamingId}`);
  }
  return Number(match[1]);
}
```

- [ ] **Step 4: Add checkpoint section**

In `server/src/checkpoint.ts`, add:

```ts
export type DreamingIndexEntry = {
  project: string;
  dreamingId: string;
  parentId?: string;
  createdAt: string;
  sessionSnapshotVersion: number;
};

export type DreamingIndexCheckpoint = {
  baseline: { dreaming: number };
  entries: DreamingIndexEntry[];
};
```

Change `CheckpointContent` to:

```ts
schemaVersion: 11;
dreamingIndex: DreamingIndexCheckpoint;
```

Change `parseCheckpointFile()` to require `schemaVersion === 11` and parse `dreamingIndex`. This repository does not keep backward compatibility for old checkpoint shapes.

- [ ] **Step 5: Wire backend checkpoint export**

In `server/src/backend.ts`, import `DreamingIndex`, instantiate it in `MuninnBackend`, and include:

```ts
dreamingIndex: await this.dreamingIndex.exportCheckpoint(this.client),
```

in `exportCheckpoint()`.

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm --filter @muninn/server build
node --test server/test/memory/dreaming-index.test.mjs server/test/memory/session-index-checkpoint.test.mjs
```

Expected: both tests pass after updating checkpoint fixtures to schema version `11` with a `dreamingIndex` section.

- [ ] **Step 7: Commit**

```bash
git add server/src/dreaming/index.ts server/src/checkpoint.ts server/src/backend.ts server/test/memory/dreaming-index.test.mjs server/test/memory/session-index-checkpoint.test.mjs
git commit -m "feat: add dreaming index checkpoint"
```

---

### Task 5: Add Project Dreamer Runtime

**Files:**
- Create: `server/src/dreaming/project-dreamer.ts`
- Test: `server/test/memory/project-dreamer.test.mjs`

- [ ] **Step 1: Write failing project dreamer tests**

Create `server/test/memory/project-dreamer.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildProjectDreamPrompt, mergeProjectDream } from '../../dist/dreaming/project-dreamer.js';

test('buildProjectDreamPrompt omits session ids and includes parent plus incremental signals', () => {
  const prompt = buildProjectDreamPrompt({
    project: '/repo/muninn',
    parentDream: '# Project Dream\n\n## Signals\n\n### Guidance\n- [2] Keep schemas minimal.\n\n### Skills\n\n### Open Questions',
    incrementalSignals: '- [1] Keep schemas small.',
  });
  assert.match(prompt, /## Parent Dream/);
  assert.match(prompt, /Keep schemas minimal/);
  assert.match(prompt, /## Incremental Signals/);
  assert.match(prompt, /Keep schemas small/);
  assert.doesNotMatch(prompt, /session:<rowid>/);
  assert.doesNotMatch(prompt, /### session:/);
});

test('mergeProjectDream validates LLM Markdown output', async () => {
  const result = await mergeProjectDream({
    project: '/repo/muninn',
    parentDream: '(none)',
    incrementalSignals: '- [1] Keep schemas minimal.',
    model: async () => '# Project Dream\n\n## Signals\n\n### Guidance\n- [1] Keep schemas minimal.\n\n### Skills\n\n### Open Questions',
  });
  assert.match(result, /# Project Dream/);
  assert.match(result, /Keep schemas minimal/);
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
pnpm --filter @muninn/server build
node --test server/test/memory/project-dreamer.test.mjs
```

Expected: fails because `project-dreamer.ts` does not exist.

- [ ] **Step 3: Implement project dreamer**

Create `server/src/dreaming/project-dreamer.ts`:

```ts
import { getExtractorLlmConfig } from '../config.js';
import { generateText } from '../llm/provider.js';
import { loadPromptTemplate, renderPromptTemplate } from '../llm/prompts.js';
import { validateProjectDreamContent } from './content.js';

export type ProjectDreamInput = {
  project: string;
  parentDream: string;
  incrementalSignals: string;
};

export type ProjectDreamModel = (request: { system: string; prompt: string; signal?: AbortSignal }) => Promise<string | null>;

export function buildProjectDreamPrompt(input: ProjectDreamInput): string {
  const template = loadPromptTemplate('project_dreaming');
  return renderPromptTemplate(template.userTemplate, {
    project: input.project,
    parent_dream: input.parentDream || '(none)',
    incremental_signals: input.incrementalSignals,
  });
}
```

Implement `mergeProjectDream(input & { signal?: AbortSignal; model?: ProjectDreamModel })`:

- Load `project_dreaming`.
- Use `getExtractorLlmConfig()` for `maxAttempts`.
- If provider is `mock`, return a valid Markdown dream that places `incrementalSignals` under `### Guidance` when parent is `(none)`.
- Otherwise call `model ?? ((request) => generateText('extractor', request))`.
- Validate each output with `validateProjectDreamContent()`.
- Retry up to `maxAttempts`, appending `Previous output was invalid. Validation error: ... Return only a valid project dream Markdown document.` after the first attempt.
- Throw the last validation error when all attempts fail.

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm --filter @muninn/server build
node --test server/test/memory/project-dreamer.test.mjs server/test/memory/project-dream-content.test.mjs
```

Expected: tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/dreaming/project-dreamer.ts server/test/memory/project-dreamer.test.mjs
git commit -m "feat: add project dreamer runtime"
```

---

### Task 6: Add Dreaming Service Source Selection and Append Flow

**Files:**
- Create: `server/src/dreaming/service.ts`
- Modify: `server/src/backend.ts`
- Test: `server/test/memory/project-dreaming-service.test.mjs`

- [ ] **Step 1: Write failing service tests**

Create `server/test/memory/project-dreaming-service.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { ProjectDreamingService } from '../../dist/dreaming/service.js';
import { DreamingIndex } from '../../dist/dreaming/index.js';

function snapshot(overrides) {
  return {
    snapshotId: overrides.snapshotId,
    sessionId: overrides.sessionId,
    project: overrides.project ?? '/repo/muninn',
    cwd: '/repo/muninn',
    agent: 'codex',
    snapshotSequence: overrides.snapshotSequence ?? 0,
    createdAt: overrides.createdAt ?? '2026-06-18T00:00:00Z',
    updatedAt: overrides.updatedAt ?? '2026-06-18T00:00:00Z',
    extractor: 'default-observer',
    title: 'Session',
    summary: 'Session summary',
    signals: overrides.signals,
    content: '# Session\n\n## Summary\nSession summary\n\n## Signals\n' + overrides.signals,
    references: [],
  };
}

test('first dream scans current session snapshots and stores scan sourceVersion', async () => {
  const appended = [];
  const client = {
    sessionTable: {
      listSnapshotsWithVersion: async () => ({
        sourceVersion: 12,
        rows: [
          snapshot({ snapshotId: 'session:1', sessionId: 's1', signals: '- [1] Keep schemas minimal.' }),
          snapshot({ snapshotId: 'session:2', sessionId: 's2', signals: '' }),
        ],
      }),
    },
    dreamingTable: {
      append: async ({ row }) => {
        appended.push(row);
        return { ...row, dreamingId: 'dreaming:1' };
      },
      get: async () => null,
      list: async () => [],
      delta: async () => ({ sourceVersion: 0, rows: [] }),
      stats: async () => ({ version: 0, rowCount: 0, fragmentCount: 0 }),
    },
  };
  const service = new ProjectDreamingService(client, new DreamingIndex(null), 'default-observer', {
    merge: async () => '# Project Dream\n\n## Signals\n\n### Guidance\n- [1] Keep schemas minimal.\n\n### Skills\n\n### Open Questions',
  });
  const result = await service.create('/repo/muninn');
  assert.equal(result.created, true);
  assert.equal(appended[0].sessionSnapshotVersion, 12);
});

test('incremental dream reads delta from parent sessionSnapshotVersion and stores delta sourceVersion', async () => {
  const appended = [];
  const parent = {
    dreamingId: 'dreaming:1',
    project: '/repo/muninn',
    parentId: null,
    createdAt: '2026-06-18T00:00:00Z',
    sessionSnapshotVersion: 12,
    content: '# Project Dream\n\n## Signals\n\n### Guidance\n- [1] Keep schemas minimal.\n\n### Skills\n\n### Open Questions',
  };
  const client = {
    sessionTable: {
      delta: async ({ baselineVersion }) => {
        assert.equal(baselineVersion, 12);
        return {
          sourceVersion: 15,
          rows: [
            snapshot({ snapshotId: 'session:3', sessionId: 's1', snapshotSequence: 2, signals: '- [2] Prefer Lance version checkpoints.' }),
          ],
        };
      },
    },
    dreamingTable: {
      append: async ({ row }) => {
        appended.push(row);
        return { ...row, dreamingId: 'dreaming:2' };
      },
      get: async ({ dreamingId }) => dreamingId === 'dreaming:1' ? parent : null,
      list: async () => [parent],
      delta: async () => ({ sourceVersion: 1, rows: [] }),
      stats: async () => ({ version: 1, rowCount: 1, fragmentCount: 1 }),
    },
  };
  const service = new ProjectDreamingService(client, new DreamingIndex({
    baseline: { dreaming: 1 },
    entries: [{ project: '/repo/muninn', dreamingId: 'dreaming:1', createdAt: parent.createdAt, sessionSnapshotVersion: 12 }],
  }), 'default-observer', {
    merge: async ({ parentDream, incrementalSignals }) => {
      assert.match(parentDream, /Keep schemas minimal/);
      assert.match(incrementalSignals, /Prefer Lance version checkpoints/);
      return '# Project Dream\n\n## Signals\n\n### Guidance\n- [2] Prefer Lance version checkpoints.\n- [1] Keep schemas minimal.\n\n### Skills\n\n### Open Questions';
    },
  });
  const result = await service.create('/repo/muninn');
  assert.equal(result.created, true);
  assert.equal(appended[0].parentId, 1);
  assert.equal(appended[0].sessionSnapshotVersion, 15);
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
pnpm --filter @muninn/server build
node --test server/test/memory/project-dreaming-service.test.mjs
```

Expected: fails because `ProjectDreamingService` does not exist.

- [ ] **Step 3: Implement service**

Create `server/src/dreaming/service.ts` with:

```ts
export type ProjectDreamCreateResult = {
  created: boolean;
  dream: DreamingRow | null;
};
```

Implement class:

```ts
export class ProjectDreamingService {
  constructor(
    private readonly client: NativeTables,
    private readonly index: DreamingIndex,
    private readonly extractorName: string | null,
    private readonly deps: { merge?: typeof mergeProjectDream } = {},
  ) {}
}
```

Methods:

- `latest(project): Promise<DreamingRow | null>`: use `index.latest()` then `dreamingTable.get()`.
- `signals(project, limit = 5)`: load latest and parse `content` with `parseProjectDreamSignals`.
- `create(project): Promise<ProjectDreamCreateResult>`:
  - Fail if `extractorName` is missing.
  - Read parent entry from `DreamingIndex`.
  - If parent exists, read parent row and `sessionTable.delta({ observer: extractorName, baselineVersion: parent.sessionSnapshotVersion })`.
  - If parent does not exist, read `sessionTable.listSnapshotsWithVersion({ observer: extractorName })`.
  - Filter rows to `row.project === project`.
  - Group by session identity using `sessionIdentityKey({ sessionId, agent, project, cwd })`.
  - Keep latest changed snapshot per session by `snapshotSequence`, then `updatedAt`, then numeric `snapshotId`.
  - Keep only `signals.trim().length > 0`.
  - If no selected signals and no parent row, return `{ created: false, dream: null }`.
  - If no selected signals and parent row exists, return `{ created: false, dream: parentRow }`.
  - Build incremental signal text by joining selected `signals` with blank lines.
  - Merge parent content and incremental signals.
  - Append `DreamingRow` with pending `dreamingId: 'dreaming:18446744073709551615'`, `parentId` as the parent numeric row id or `null`, `createdAt: new Date().toISOString()`, `sessionSnapshotVersion: source.sourceVersion`, and `content`.
  - Mark index dirty after append.

- [ ] **Step 4: Wire backend facade**

In `server/src/backend.ts`, instantiate:

```ts
private readonly dreamingIndex: DreamingIndex;
private readonly projectDreaming: ProjectDreamingService;
```

Initialize after `sessionIndex`:

```ts
this.dreamingIndex = new DreamingIndex(checkpoint?.dreamingIndex ?? null);
this.projectDreaming = new ProjectDreamingService(client, this.dreamingIndex, extractorName ?? null);
```

Add methods:

```ts
async latestProjectDream(project: string): Promise<DreamingRow | null> {
  return this.checkpointLock.shared(async () => this.projectDreaming.latest(project));
}

async latestProjectSignals(project: string): Promise<ProjectDreamSignals | null> {
  return this.checkpointLock.shared(async () => this.projectDreaming.signals(project, 5));
}

async createProjectDream(project: string): Promise<ProjectDreamCreateResult> {
  return this.checkpointLock.exclusive(async () => this.projectDreaming.create(project));
}
```

Export:

```ts
export const dreaming = {
  async getProject(project: string, database?: string | null): Promise<DreamingRow | null> {
    const databaseName = resolveDatabaseName(database);
    await writeMuninnLog(databaseName, 'info', 'detail', 'project_dream_get', { project });
    return (await getBackend(databaseName)).latestProjectDream(project);
  },

  async getProjectSignals(project: string, database?: string | null): Promise<ProjectDreamSignals | null> {
    const databaseName = resolveDatabaseName(database);
    await writeMuninnLog(databaseName, 'info', 'detail', 'project_dream_signals', { project });
    return (await getBackend(databaseName)).latestProjectSignals(project);
  },

  async createProject(project: string, database?: string | null): Promise<ProjectDreamCreateResult> {
    const databaseName = resolveDatabaseName(database);
    await writeMuninnLog(databaseName, 'info', 'dreaming', 'project_dream_create', { project });
    return (await getBackend(databaseName)).createProjectDream(project);
  },
};
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm --filter @muninn/server build
node --test server/test/memory/project-dreaming-service.test.mjs server/test/memory/dreaming-index.test.mjs
```

Expected: tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/dreaming/service.ts server/src/backend.ts server/test/memory/project-dreaming-service.test.mjs
git commit -m "feat: add project dreaming service"
```

---

### Task 7: Add HTTP and Common Contracts

**Files:**
- Modify: `common/src/api.ts`
- Modify: `server/src/http.ts`
- Test: `server/test/project-dreaming-routes.test.mjs`

- [ ] **Step 1: Write failing route tests**

Create `server/test/project-dreaming-routes.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { app } from '../dist/http.js';

test('GET /api/v1/dreaming/project requires project', async () => {
  const response = await app.request('/api/v1/dreaming/project');
  assert.equal(response.status, 400);
});

test('GET /api/v1/dreaming/project/signals requires project', async () => {
  const response = await app.request('/api/v1/dreaming/project/signals');
  assert.equal(response.status, 400);
});

test('POST /api/v1/dreaming/project requires project', async () => {
  const response = await app.request('/api/v1/dreaming/project', { method: 'POST' });
  assert.equal(response.status, 400);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm --filter @muninn/server build
node --test server/test/project-dreaming-routes.test.mjs
```

Expected: fails because the routes do not exist.

- [ ] **Step 3: Add common contracts**

In `common/src/api.ts`, add:

```ts
export interface ProjectDreamDocument {
  memoryId: string;
  project: string;
  parentId?: string | null;
  createdAt: string;
  sessionSnapshotVersion: number;
  content: string;
}

export interface ProjectDreamResponse {
  dream: ProjectDreamDocument;
  created?: boolean;
  requestId: string;
}

export interface ProjectDreamSignals {
  memoryId: string;
  project: string;
  createdAt: string;
  guidance: string[];
  skills: string[];
  openQuestions: string[];
}

export interface ProjectDreamSignalsResponse extends ProjectDreamSignals {
  requestId: string;
}

export interface ProjectDreamRequest {
  database?: string;
  project: string;
}
```

- [ ] **Step 4: Add HTTP routes**

In `server/src/http.ts`, import `dreaming` from `backend.js`, import the new common response types, and add helpers:

```ts
function projectDreamDocument(dream: DreamingRow): ProjectDreamDocument {
  return {
    memoryId: dream.dreamingId,
    project: dream.project,
    parentId: dream.parentId == null ? null : `dreaming:${dream.parentId}`,
    createdAt: dream.createdAt,
    sessionSnapshotVersion: dream.sessionSnapshotVersion,
    content: dream.content,
  };
}

function projectDreamResponse(dream: DreamingRow, created?: boolean): ProjectDreamResponse {
  return {
    dream: projectDreamDocument(dream),
    created,
    requestId: generateRequestId(),
  };
}

function projectDreamSignalsResponse(signals: ProjectDreamSignals): ProjectDreamSignalsResponse {
  return {
    ...signals,
    requestId: generateRequestId(),
  };
}
```

Add these routes:

```ts
app.get('/api/v1/dreaming/project', async (c) => {
  const project = c.req.query('project')?.trim();
  const database = c.req.query('database');
  if (!project) {
    return c.json(errorResponse('invalidRequest', 'project is required'), 400);
  }
  const dream = await dreaming.getProject(project, database);
  if (!dream) {
    return c.json(errorResponse('notFound', 'project dream not found'), 404);
  }
  return c.json(projectDreamResponse(dream));
});

app.get('/api/v1/dreaming/project/signals', async (c) => {
  const project = c.req.query('project')?.trim();
  const database = c.req.query('database');
  if (!project) {
    return c.json(errorResponse('invalidRequest', 'project is required'), 400);
  }
  const signals = await dreaming.getProjectSignals(project, database);
  if (!signals) {
    return c.json(errorResponse('notFound', 'project dream not found'), 404);
  }
  return c.json(projectDreamSignalsResponse(signals));
});

app.post('/api/v1/dreaming/project', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { database?: unknown; project?: unknown };
  const project = (c.req.query('project') ?? (typeof body.project === 'string' ? body.project : '')).trim();
  const database = c.req.query('database') ?? (typeof body.database === 'string' ? body.database : undefined);
  if (!project) {
    return c.json(errorResponse('invalidRequest', 'project is required'), 400);
  }
  const result = await dreaming.createProject(project, database);
  if (!result.dream) {
    return c.json(errorResponse('notFound', 'no project signals available'), 404);
  }
  return c.json(projectDreamResponse(result.dream, result.created));
});
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm --filter @muninn/server build
node --test server/test/project-dreaming-routes.test.mjs
```

Expected: route validation tests pass.

- [ ] **Step 6: Commit**

```bash
git add common/src/api.ts server/src/http.ts server/test/project-dreaming-routes.test.mjs
git commit -m "feat: add project dreaming routes"
```

---

### Task 8: Add Thin MCP Project Signals Tool

**Files:**
- Modify: `mcp/src/server-client.ts`
- Modify: `mcp/src/index.ts`
- Test: add MCP build verification through `pnpm --filter @muninn/mcp build`

- [ ] **Step 1: Add server client method**

In `mcp/src/server-client.ts`, import `ProjectDreamRequest` and add:

```ts
async projectSignals(request: ProjectDreamRequest): Promise<ProjectDreamSignalsResponse> {
  return this.fetchJson('/api/v1/dreaming/project/signals', request) as Promise<ProjectDreamSignalsResponse>;
}
```

Widen `fetchJson` return type:

```ts
private async fetchJson<TResponse, TParams extends object>(path: string, params: TParams): Promise<TResponse>
```

Update existing methods to call `fetchJson<MemoryResponse, RecallRequest>()`.

- [ ] **Step 2: Add MCP tool**

In `mcp/src/index.ts`, add:

```ts
function renderProjectSignals(result: {
  project: string;
  memoryId: string;
  guidance: string[];
  skills: string[];
  openQuestions: string[];
}): string {
  return [
    `# Project Signals`,
    '',
    `Project: ${result.project}`,
    `Memory ID: ${result.memoryId}`,
    '',
    '## Guidance',
    ...result.guidance,
    '',
    '## Skills',
    ...result.skills,
    '',
    '## Open Questions',
    ...result.openQuestions,
  ].join('\n').trimEnd();
}
```

Register:

```ts
registerTool(
  'project_signals',
  {
    description: 'Get top project dreaming signals for a project',
    inputSchema: z.object({
      project: z.string().describe('Project key/path'),
      database: z.string().optional().describe('Muninn database name; defaults to main'),
    }),
  },
  async (args: any) => {
    const result = await serverClient.projectSignals(args);
    return { content: [{ type: 'text', text: renderProjectSignals(result) }] };
  }
);
```

- [ ] **Step 3: Run build**

Run:

```bash
pnpm --filter @muninn/mcp build
```

Expected: build passes.

- [ ] **Step 4: Commit**

```bash
git add mcp/src/server-client.ts mcp/src/index.ts
git commit -m "feat: expose project signals over mcp"
```

---

### Task 9: Include Dreaming in Session Cleanup Floor

**Files:**
- Modify: `server/src/watchdog.ts`
- Modify: `server/src/backend.ts`
- Test: `server/test/memory/client-internals.test.mjs` or a new `server/test/memory/watchdog-cleanup-floor.test.mjs`

- [ ] **Step 1: Write failing cleanup floor test**

Create `server/test/memory/watchdog-cleanup-floor.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { __testing as watchdogTesting } from '../../dist/watchdog.js';

test('checkpointFloors uses min dreaming sessionSnapshotVersion for session cleanup', () => {
  const floors = watchdogTesting.checkpointFloors({
    schemaVersion: 11,
    extractor: { baseline: { turn: 30, session: 20, extraction: 10, observation: 9 }, committedEpoch: 1, nextEpoch: 2, recentSessions: [], threads: [], runs: [], pendingExtractionChanges: [] },
    observer: { baseline: { observationContext: 8, observation: 9 }, observeQueue: { cwdBuckets: [] } },
    sessionIndex: { baseline: { turn: 30, session: 20 }, entries: [] },
    dreamingIndex: {
      baseline: { dreaming: 7 },
      entries: [
        { project: '/repo/a', dreamingId: 'dreaming:1', createdAt: '2026-06-18T00:00:00Z', sessionSnapshotVersion: 15 },
        { project: '/repo/b', dreamingId: 'dreaming:2', createdAt: '2026-06-18T00:00:00Z', sessionSnapshotVersion: 12 },
      ],
    },
  });
  assert.equal(floors.session, 12);
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
pnpm --filter @muninn/server build
node --test server/test/memory/watchdog-cleanup-floor.test.mjs
```

Expected: fails because `checkpointFloors` does not consider `dreamingIndex`.

- [ ] **Step 3: Implement floor calculation**

In `server/src/watchdog.ts`, compute:

```ts
function minNumber(values: Array<number | null | undefined>): number | null {
  const present = values.filter((value): value is number => typeof value === 'number');
  return present.length === 0 ? null : Math.min(...present);
}
```

Use:

```ts
const dreamingSessionFloor = minNumber(checkpoint.dreamingIndex.entries.map((entry) => entry.sessionSnapshotVersion));
const sessionFloor = minNumber([
  checkpoint.extractor.baseline.session,
  checkpoint.sessionIndex.baseline.session,
  dreamingSessionFloor,
]);
```

Return `session: sessionFloor`.

Export for tests:

```ts
export const __testing = { checkpointFloors };
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm --filter @muninn/server build
node --test server/test/memory/watchdog-cleanup-floor.test.mjs
```

Expected: test passes.

- [ ] **Step 5: Commit**

```bash
git add server/src/watchdog.ts server/test/memory/watchdog-cleanup-floor.test.mjs
git commit -m "feat: preserve dreaming session baselines"
```

---

### Task 10: Final Cross-Layer Verification

**Files:**
- No new files.

- [ ] **Step 1: Run Rust checks**

Run:

```bash
cargo test --manifest-path format/Cargo.toml
cargo check --manifest-path server/native/Cargo.toml
```

Expected: both commands exit `0`.

- [ ] **Step 2: Run TypeScript builds**

Run:

```bash
pnpm --filter @muninn/common build
pnpm --filter @muninn/server build
pnpm --filter @muninn/mcp build
```

Expected: all commands exit `0`.

- [ ] **Step 3: Run targeted server tests**

Run:

```bash
node --test server/test/memory/project-dream-content.test.mjs server/test/memory/project-dreamer.test.mjs server/test/memory/project-dreaming-service.test.mjs server/test/memory/dreaming-index.test.mjs server/test/memory/watchdog-cleanup-floor.test.mjs server/test/memory/prompt-loader.test.mjs server/test/memory/session-index-runtime.test.mjs
```

Expected: all listed tests pass.

- [ ] **Step 4: Run package tests when time permits**

Run:

```bash
pnpm --filter @muninn/server test
```

Expected: exits `0`. If this fails because `openclaw/plugin` build dependencies are missing, capture the exact failure and keep the targeted verification output in the final implementation report.

- [ ] **Step 5: Final status check**

Run:

```bash
git status --short
```

Expected: only intentional implementation files are modified or the worktree is clean after the final commit.
