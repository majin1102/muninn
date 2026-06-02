# Turn Events JSON Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace flat `toolCalls` storage with ordered turn `events`, so one turn still stores one interaction row while UI can render user messages, assistant messages, tool calls, and tool outputs in their true order.

**Architecture:** The Lance turn row remains one row per interaction. `tool_calls_json` is replaced by `events_json` as a `Utf8` JSON column; `prompt`, `response`, and `summary` remain projections for title/search/extractor input. Extractor/observer continue to ignore raw tool output and use `summary` plus the existing projections, while Board chat renders from `events`.

**Tech Stack:** Rust `format/` Lance/Arrow schema and serde JSON codecs, TypeScript `@muninn/types`, `@muninn/core`, sidecar HTTP validation, Board React UI, Codex import JSONL parser, Node/Rust test suites.

---

## File Structure

- Modify: `format/src/schema.rs`
  - Replace `tool_calls_json` with `events_json` in the turn Lance schema.
- Modify: `format/src/turn.rs`
  - Replace `ToolCall` as persisted turn metadata with `TurnEvent`.
  - Change `Turn.tool_calls` to `Turn.events`.
- Modify: `format/src/codec.rs`
  - Serialize/deserialize `events_json`.
  - Keep `artifacts_json`, `prompt`, `response`, and `summary` unchanged.
- Modify: `format/src/lib.rs`
  - Export `TurnEvent` instead of `ToolCall`.
- Modify: `format/src/maintenance.rs`
  - Update test fixtures that construct `Turn`.
- Modify: `packages/types/src/api.ts`
  - Replace public `ToolCall` with `TurnEvent`.
  - Replace `toolCalls?: ToolCall[]` with `events: TurnEvent[]` on capture/document/preview types.
- Modify: `packages/sidecar/src/memory_writer.ts`
  - Validate `turn.events`.
  - Remove `turn.toolCalls` validation.
- Modify: `packages/core/src/backend.ts`
  - Replace `toolCalls` with `events` in `Turn`.
- Modify: `packages/core/src/turn/session.ts`
  - Build `Turn.events`.
  - Keep summary generation based on `prompt` and `response`.
  - Dedup still uses `prompt/response`.
- Modify: `packages/core/src/turn/types.ts`
  - Read/serialize `events`.
- Modify: `packages/core/src/memories/rendered.ts`
  - Render tool event names from `events`, not `toolCalls`.
- Modify: `packages/board/src/server/app.ts`
  - Return `events` in `TurnPreview` and `MemoryDocument`.
- Modify: `packages/board/src/server/codex_import.ts`
  - Parse Codex JSONL into ordered events.
  - Derive `prompt`, `response`, `summary`, and artifacts from events.
- Modify: `packages/board/src/components/ChatView.tsx`
  - Render ordered event timeline.
  - Remove grouped `ToolCallList` below assistant bubble.
- Modify: `openclaw/plugin/src/payloads.ts`
  - Send `events` instead of `toolCalls`.
- Modify: `openclaw/plugin/src/hooks.ts`
  - Convert cached tool calls to `toolCall` / `toolOutput` events.
- Modify docs:
  - `docs/spec/muninn-format-schema.md`
  - `docs/architecture/sidecar-http-api.md`
  - `packages/mcp/DEMO.md`
- Test files to update:
  - `packages/sidecar/test/session_flow.test.mjs`
  - `packages/board/test/codex-import-artifacts.test.mjs`
  - `openclaw/plugin/test/payloads.test.mjs`
  - `openclaw/plugin/test/hooks.test.mjs`
  - `packages/core/test/client.test.mjs`

---

### Task 1: Define TurnEvent In Public Types

**Files:**
- Modify: `packages/types/src/api.ts`
- Test: TypeScript build via `pnpm --filter @muninn/types build`

- [ ] **Step 1: Replace `ToolCall` with `TurnEvent`**

In `packages/types/src/api.ts`, replace:

```ts
export interface ToolCall {
  id?: string;
  name: string;
  input?: string;
  output?: string;
}
```

with:

```ts
export type TurnEvent =
  | {
      type: 'userMessage';
      text: string;
      timestamp?: string;
      artifacts?: Artifact[];
    }
  | {
      type: 'assistantMessage';
      text: string;
      timestamp?: string;
      artifacts?: Artifact[];
    }
  | {
      type: 'toolCall';
      id?: string;
      name: string;
      input?: string;
      timestamp?: string;
    }
  | {
      type: 'toolOutput';
      id?: string;
      output?: string;
      timestamp?: string;
      artifacts?: Artifact[];
    };
```

- [ ] **Step 2: Replace `toolCalls` properties with `events`**

In `TurnContent`, replace:

```ts
toolCalls?: ToolCall[];
```

with:

```ts
events: TurnEvent[];
```

In `TurnPreview` and `MemoryDocument`, replace:

```ts
toolCalls?: ToolCall[];
```

with:

```ts
events?: TurnEvent[];
```

- [ ] **Step 3: Run types build**

Run:

```bash
pnpm --filter @muninn/types build
```

Expected: TypeScript errors in downstream packages are allowed at this stage; `@muninn/types` itself should compile.

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/api.ts
git commit -m "feat: define turn events API"
```

---

### Task 2: Replace Lance `tool_calls_json` With `events_json`

**Files:**
- Modify: `format/src/schema.rs`
- Modify: `format/src/turn.rs`
- Modify: `format/src/codec.rs`
- Modify: `format/src/lib.rs`
- Modify: `format/src/maintenance.rs`
- Test: Rust tests via `cargo test --manifest-path format/Cargo.toml`

- [ ] **Step 1: Add a schema test for `events_json`**

In `format/src/schema.rs`, inside the existing `#[cfg(test)] mod tests`, add:

```rust
#[test]
fn turn_schema_uses_events_json_not_tool_calls_json() {
    let schema = turn_schema();
    assert!(schema.field_with_name("events_json").is_ok());
    assert!(schema.field_with_name("tool_calls_json").is_err());
    assert!(schema.field_with_name("artifacts_json").is_ok());
    assert!(schema.field_with_name("prompt").is_ok());
    assert!(schema.field_with_name("response").is_ok());
    assert!(schema.field_with_name("summary").is_ok());
}
```

- [ ] **Step 2: Run Rust test and verify failure**

Run:

```bash
cargo test --manifest-path format/Cargo.toml turn_schema_uses_events_json_not_tool_calls_json
```

Expected: FAIL because `events_json` does not exist and `tool_calls_json` still exists.

- [ ] **Step 3: Modify `turn_schema`**

In `format/src/schema.rs`, replace:

```rust
Field::new("tool_calls_json", DataType::Utf8, true),
```

with:

```rust
Field::new("events_json", DataType::Utf8, false),
```

Keep the rest of the turn schema order as:

```rust
Field::new("title", DataType::Utf8, true),
Field::new("summary", DataType::Utf8, true),
Field::new("events_json", DataType::Utf8, false),
Field::new("artifacts_json", DataType::Utf8, true),
Field::new("prompt", DataType::Utf8, true),
Field::new("response", DataType::Utf8, true),
Field::new("observing_epoch", DataType::UInt64, true),
```

- [ ] **Step 4: Replace Rust persisted types**

In `format/src/turn.rs`, remove `ToolCall` and add:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum TurnEvent {
    UserMessage {
        text: String,
        timestamp: Option<DateTime<Utc>>,
        artifacts: Option<Vec<Artifact>>,
    },
    AssistantMessage {
        text: String,
        timestamp: Option<DateTime<Utc>>,
        artifacts: Option<Vec<Artifact>>,
    },
    ToolCall {
        id: Option<String>,
        name: String,
        input: Option<String>,
        timestamp: Option<DateTime<Utc>>,
    },
    ToolOutput {
        id: Option<String>,
        output: Option<String>,
        timestamp: Option<DateTime<Utc>>,
        artifacts: Option<Vec<Artifact>>,
    },
}
```

In `Turn`, replace:

```rust
pub tool_calls: Option<Vec<ToolCall>>,
```

with:

```rust
pub events: Vec<TurnEvent>,
```

- [ ] **Step 5: Update codec imports**

In `format/src/codec.rs`, replace:

```rust
use crate::turn::{Artifact, Turn, ToolCall};
```

with:

```rust
use crate::turn::{Artifact, Turn, TurnEvent};
```

- [ ] **Step 6: Serialize events**

In `turns_to_record_batch`, replace the `tool_calls_json` array creation with:

```rust
let events_json = StringArray::from_iter_values(
    turns.iter().map(|turn| events_to_json(&turn.events)),
);
```

In the `RecordBatch::try_new` vector, replace:

```rust
Arc::new(tool_calls_json),
```

with:

```rust
Arc::new(events_json),
```

- [ ] **Step 7: Deserialize events**

In `record_batch_to_turns_with_row_ids`, rename the column binding:

```rust
let events_json = batch
    .column(7)
    .as_any()
    .downcast_ref::<StringArray>()
    .unwrap();
```

In the `Turn` construction, replace:

```rust
tool_calls: optional_json(tool_calls_json, index),
```

with:

```rust
events: serde_json::from_str(events_json.value(index)).unwrap_or_default(),
```

- [ ] **Step 8: Add events JSON helper**

In `format/src/codec.rs`, replace:

```rust
pub(crate) fn tool_calls_to_json(tool_calls: &[ToolCall]) -> String {
    serde_json::to_string(tool_calls).expect("tool calls should serialize")
}
```

with:

```rust
pub(crate) fn events_to_json(events: &[TurnEvent]) -> String {
    serde_json::to_string(events).expect("turn events should serialize")
}
```

- [ ] **Step 9: Update exports**

In `format/src/lib.rs`, replace:

```rust
pub use turn::{Artifact, ToolCall, Turn, TurnTable};
```

with:

```rust
pub use turn::{Artifact, Turn, TurnEvent, TurnTable};
```

- [ ] **Step 10: Update maintenance test fixtures**

In `format/src/maintenance.rs`, replace fixture fields like:

```rust
tool_calls: None,
```

with:

```rust
events: vec![],
```

- [ ] **Step 11: Run Rust tests**

Run:

```bash
cargo test --manifest-path format/Cargo.toml
```

Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add format/src/schema.rs format/src/turn.rs format/src/codec.rs format/src/lib.rs format/src/maintenance.rs
git commit -m "feat: store ordered turn events in Lance"
```

---

### Task 3: Update Core Turn Model And Session Write Path

**Files:**
- Modify: `packages/core/src/backend.ts`
- Modify: `packages/core/src/turn/session.ts`
- Modify: `packages/core/src/turn/types.ts`
- Modify: `packages/core/src/memories/rendered.ts`
- Test: `packages/core/test/client.test.mjs`

- [ ] **Step 1: Update core `Turn` interface**

In `packages/core/src/backend.ts`, replace:

```ts
import type { Artifact, ToolCall, TurnContent } from '@muninn/types';
```

with:

```ts
import type { Artifact, TurnContent, TurnEvent } from '@muninn/types';
```

Then replace:

```ts
toolCalls?: ToolCall[] | null;
```

with:

```ts
events: TurnEvent[];
```

- [ ] **Step 2: Update `buildTurn`**

In `packages/core/src/turn/session.ts`, replace:

```ts
toolCalls: content.toolCalls?.map((toolCall) => ({ ...toolCall })) ?? null,
```

with:

```ts
events: content.events.map((event) => ({ ...event })),
```

Keep:

```ts
prompt: content.prompt,
response: content.response,
```

because those remain the projections used by title, summary, dedup, and extractor.

- [ ] **Step 3: Validate events**

In `validateTurnContent`, after timestamp validation, add:

```ts
if (!Array.isArray(content.events) || content.events.length === 0) {
  throw new Error('turn.events must be a non-empty array');
}
```

- [ ] **Step 4: Update serialization**

In `packages/core/src/turn/types.ts`, replace:

```ts
toolCalls: turn.toolCalls,
```

with:

```ts
events: turn.events,
```

and replace:

```ts
toolCalls: turn.toolCalls ?? null,
```

with:

```ts
events: turn.events,
```

- [ ] **Step 5: Update rendered detail**

In `packages/core/src/memories/rendered.ts`, replace:

```ts
if (turn.toolCalls && turn.toolCalls.length > 0) {
  lines.push(`Tools: ${turn.toolCalls.map((toolCall) => toolCall.name).join(', ')}`);
}
```

with:

```ts
const toolNames = turn.events
  .filter((event) => event.type === 'toolCall')
  .map((event) => event.name);
if (toolNames.length > 0) {
  lines.push(`Tools: ${toolNames.join(', ')}`);
}
```

- [ ] **Step 6: Update core tests**

In `packages/core/test/client.test.mjs`, update test turn helper defaults from:

```js
toolCalls = null,
```

to:

```js
events = [
  { type: 'userMessage', text: prompt },
  { type: 'assistantMessage', text: response },
],
```

and pass `events` in returned turn content:

```js
events,
```

For tests that currently pass `toolCalls: [{ name: 'tool-a' }]`, replace with:

```js
events: [
  { type: 'userMessage', text: 'alpha prompt' },
  { type: 'toolCall', name: 'tool-a' },
  { type: 'assistantMessage', text: 'alpha response' },
],
```

- [ ] **Step 7: Run core tests**

Run:

```bash
pnpm --filter @muninn/core build
pnpm --filter @muninn/core test:node
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/backend.ts packages/core/src/turn/session.ts packages/core/src/turn/types.ts packages/core/src/memories/rendered.ts packages/core/test/client.test.mjs
git commit -m "feat: write ordered turn events from core"
```

---

### Task 4: Update Sidecar Capture Validation

**Files:**
- Modify: `packages/sidecar/src/memory_writer.ts`
- Test: `packages/sidecar/test/session_flow.test.mjs`

- [ ] **Step 1: Write failing sidecar validation test**

In `packages/sidecar/test/session_flow.test.mjs`, replace the invalid `toolCalls` cases with an invalid events case:

```js
test('turn/capture validates ordered turn events', async (t) => {
  const { dir, homeDir, configPath } = await makeDatasetUri();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  process.env.MUNINN_HOME = homeDir;
  await writeMuninnConfig(configPath, { turnProvider: 'mock' });

  const missingEvents = await captureTurn(makeTurnContent({ events: undefined }));
  assert.equal(missingEvents.status, 400);
  assert.match((await json(missingEvents)).errorMessage, /turn\.events must be a non-empty array/i);

  const badEvent = await captureTurn(makeTurnContent({ events: [{ type: 'toolCall' }] }));
  assert.equal(badEvent.status, 400);
  assert.match((await json(badEvent)).errorMessage, /toolCall.name must be a non-empty string/i);
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
node --test packages/sidecar/test/session_flow.test.mjs
```

Expected: FAIL because `turn.events` is not validated yet.

- [ ] **Step 3: Replace allowed fields**

In `packages/sidecar/src/memory_writer.ts`, replace `toolCalls` in `TURN_FIELDS`:

```ts
'toolCalls',
```

with:

```ts
'events',
```

- [ ] **Step 4: Replace ToolCall validation**

Remove `isToolCall`. Add:

```ts
function isTurnEvent(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  if (value.timestamp !== undefined && !isTimestamp(value.timestamp)) {
    return false;
  }
  if (value.artifacts !== undefined && (!Array.isArray(value.artifacts) || !value.artifacts.every(isArtifact))) {
    return false;
  }
  if (value.type === 'userMessage' || value.type === 'assistantMessage') {
    return typeof value.text === 'string' && hasTextContent(value.text);
  }
  if (value.type === 'toolCall') {
    return typeof value.name === 'string' && hasTextContent(value.name)
      && (value.id === undefined || typeof value.id === 'string')
      && (value.input === undefined || typeof value.input === 'string');
  }
  if (value.type === 'toolOutput') {
    return (value.id === undefined || typeof value.id === 'string')
      && (value.output === undefined || typeof value.output === 'string');
  }
  return false;
}
```

- [ ] **Step 5: Validate events**

Replace:

```ts
if (turn.toolCalls !== undefined && !Array.isArray(turn.toolCalls)) {
  return 'turn.toolCalls must be an array';
}

if (turn.toolCalls && !turn.toolCalls.every(isToolCall)) {
  return 'turn.toolCalls must be an array of tool call objects';
}
```

with:

```ts
if (!Array.isArray(turn.events) || turn.events.length === 0) {
  return 'turn.events must be a non-empty array';
}

const invalidEvent = turn.events.find((event) => !isTurnEvent(event));
if (invalidEvent) {
  if (isRecord(invalidEvent) && invalidEvent.type === 'toolCall') {
    return 'toolCall.name must be a non-empty string';
  }
  return 'turn.events must be an array of valid event objects';
}
```

- [ ] **Step 6: Update `makeTurnContent` helper**

In `packages/sidecar/test/session_flow.test.mjs`, change:

```js
return {
  sessionId: 'group-a',
  agent: 'agent-a',
  prompt: 'alpha prompt',
  response: 'alpha response',
  ...overrides,
};
```

to:

```js
const prompt = overrides.prompt ?? 'alpha prompt';
const response = overrides.response ?? 'alpha response';
return {
  sessionId: 'group-a',
  agent: 'agent-a',
  prompt,
  response,
  events: [
    { type: 'userMessage', text: prompt },
    { type: 'assistantMessage', text: response },
  ],
  ...overrides,
};
```

- [ ] **Step 7: Run sidecar tests**

Run:

```bash
pnpm --filter @muninn/sidecar build
node --test packages/sidecar/test/session_flow.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/sidecar/src/memory_writer.ts packages/sidecar/test/session_flow.test.mjs
git commit -m "feat: validate turn event capture payloads"
```

---

### Task 5: Update Codex Import To Produce Ordered Events

**Files:**
- Modify: `packages/board/src/server/codex_import.ts`
- Test: `packages/board/test/codex-import-artifacts.test.mjs`

- [ ] **Step 1: Write failing import test for interleaved events**

In `packages/board/test/codex-import-artifacts.test.mjs`, add:

```js
test('parses codex interleaved assistant and tool events in order', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'muninn-codex-events-'));
  try {
    const entries = [
      {
        timestamp: '2026-06-02T01:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'session-events',
          cwd: '/Users/Nathan/workspace/muninn',
          timestamp: '2026-06-02T01:00:00.000Z',
        },
      },
      {
        timestamp: '2026-06-02T01:01:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '查一下 schema' }],
        },
      },
      {
        timestamp: '2026-06-02T01:01:10.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '我先看 schema。' }],
        },
      },
      {
        timestamp: '2026-06-02T01:01:20.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'call-1',
          name: 'exec_command',
          arguments: '{"cmd":"sed -n 1,40p format/src/schema.rs"}',
        },
      },
      {
        timestamp: '2026-06-02T01:01:30.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-1',
          output: 'Field::new("tool_calls_json", DataType::Utf8, true)',
        },
      },
      {
        timestamp: '2026-06-02T01:01:40.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '结论是要改成 events_json。' }],
        },
      },
    ];
    const sessionPath = path.join(tempDir, 'session-events.jsonl');
    await writeFile(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

    const session = await __testing.readCodexSession(sessionPath, {
      artifactStore: path.join(tempDir, 'artifacts'),
    });

    assert.equal(session.turns.length, 1);
    assert.deepEqual(session.turns[0].events.map((event) => event.type), [
      'userMessage',
      'assistantMessage',
      'toolCall',
      'toolOutput',
      'assistantMessage',
    ]);
    assert.equal(session.turns[0].prompt, '查一下 schema');
    assert.equal(session.turns[0].response, '我先看 schema。\n\n结论是要改成 events_json。');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
pnpm --filter @muninn/board build
node --test packages/board/test/codex-import-artifacts.test.mjs
```

Expected: FAIL because `session.turns[0].events` does not exist.

- [ ] **Step 3: Update local Codex turn type**

In `packages/board/src/server/codex_import.ts`, replace:

```ts
type CodexTurn = {
  prompt: string;
  response: string;
  timestamp: string;
  toolCalls: ToolCall[];
  artifacts: Artifact[];
};
```

with:

```ts
type CodexTurn = {
  prompt: string;
  response: string;
  timestamp: string;
  events: TurnEvent[];
  artifacts: Artifact[];
};
```

Import `TurnEvent` from `@muninn/types`.

- [ ] **Step 4: Generate events while parsing**

In `readCodexSession`, replace the pending tool-call-only state with:

```ts
let pendingEvents: TurnEvent[] = [];
let pendingArtifacts: Artifact[] = [];
let pendingToolCallsById = new Map<string, TurnEvent & { type: 'toolCall' }>();
let promptParts: string[] = [];
let assistantParts: string[] = [];
```

When reading a user message, append:

```ts
pendingEvents.push({
  type: 'userMessage',
  text: message.text,
  timestamp: message.timestamp,
  ...(message.artifacts.length > 0 ? { artifacts: message.artifacts } : {}),
});
promptParts.push(message.text);
pendingArtifacts.push(...message.artifacts);
```

When reading an assistant message, append:

```ts
pendingEvents.push({
  type: 'assistantMessage',
  text: message.text,
  timestamp: message.timestamp,
  ...(message.artifacts.length > 0 ? { artifacts: message.artifacts } : {}),
});
assistantParts.push(message.text);
```

When reading a tool call, append:

```ts
const event: TurnEvent & { type: 'toolCall' } = {
  type: 'toolCall',
  ...(toolCall.id ? { id: toolCall.id } : {}),
  name: toolCall.name,
  ...(toolCall.input ? { input: toolCall.input } : {}),
  timestamp: stringValue(entry.timestamp) ?? new Date().toISOString(),
};
pendingEvents.push(event);
if (event.id) {
  pendingToolCallsById.set(event.id, event);
}
```

When reading a tool output, append:

```ts
pendingEvents.push({
  type: 'toolOutput',
  id: output.id,
  output: output.output,
  timestamp: output.timestamp,
});
```

- [ ] **Step 5: Finalize a Codex turn**

When an assistant message is read and `promptParts.length > 0`, create the turn:

```ts
sessionTurns.push({
  prompt: promptParts.join('\n\n---\n\n'),
  response: assistantParts.join('\n\n'),
  timestamp: message.timestamp,
  events: [...pendingEvents],
  artifacts: [...pendingArtifacts, ...message.artifacts],
});
```

After pushing, reset:

```ts
promptParts = [];
assistantParts = [];
pendingEvents = [];
pendingArtifacts = [];
pendingToolCallsById = new Map();
```

- [ ] **Step 6: Write `events` in captured turn**

In `toTurnContent`, replace:

```ts
toolCalls: turn.toolCalls.length > 0 ? turn.toolCalls : undefined,
```

with:

```ts
events: turn.events,
```

- [ ] **Step 7: Run board import tests**

Run:

```bash
pnpm --filter @muninn/board build
node --test packages/board/test/codex-import-artifacts.test.mjs packages/board/test/*.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/board/src/server/codex_import.ts packages/board/test/codex-import-artifacts.test.mjs
git commit -m "feat: import codex sessions as ordered events"
```

---

### Task 6: Render Chat From Events

**Files:**
- Modify: `packages/board/src/server/app.ts`
- Modify: `packages/board/src/components/ChatView.tsx`
- Modify: `packages/board/src/styles.css`
- Test: Board build and manual URL check

- [ ] **Step 1: Return events from board server**

In `packages/board/src/server/app.ts`, replace:

```ts
toolCalls: normalizeToolCalls(turn.toolCalls),
```

with:

```ts
events: turn.events,
```

Remove `normalizeToolCalls`.

- [ ] **Step 2: Change ChatMessage into ChatTimeline events**

In `packages/board/src/components/ChatView.tsx`, stop importing `ToolCall`:

```ts
import type { Artifact, MemoryDocument, TurnEvent } from '@muninn/types';
```

Replace `toolCalls?: ToolCall[]` with:

```ts
event?: TurnEvent;
```

- [ ] **Step 3: Convert turn events into UI messages**

Add:

```ts
function messagesFromEvents(
  events: TurnEvent[],
  meta: { memoryId?: string; agent?: string },
): ChatMessage[] {
  return events.flatMap((event) => {
    if (event.type === 'userMessage') {
      return [{
        role: 'user' as const,
        label: 'User',
        body: event.text,
        memoryId: meta.memoryId,
        agent: meta.agent,
        timestamp: event.timestamp,
        artifacts: event.artifacts,
        event,
      }];
    }
    if (event.type === 'assistantMessage') {
      return [{
        role: 'agent' as const,
        label: 'Agent',
        body: event.text,
        memoryId: meta.memoryId,
        agent: meta.agent,
        timestamp: event.timestamp,
        artifacts: event.artifacts,
        event,
      }];
    }
    if (event.type === 'toolCall') {
      return [{
        role: 'agent' as const,
        label: 'Tool',
        body: '',
        memoryId: meta.memoryId,
        agent: meta.agent,
        timestamp: event.timestamp,
        event,
      }];
    }
    return [{
      role: 'agent' as const,
      label: 'Tool Output',
      body: '',
      memoryId: meta.memoryId,
      agent: meta.agent,
      timestamp: event.timestamp,
      artifacts: event.artifacts,
      event,
    }];
  });
}
```

- [ ] **Step 4: Use events in `messagesFromTurns`**

Replace per-turn prompt/response assembly with:

```ts
return turns.flatMap((turn) => messagesFromEvents(turn.events ?? [], {
  memoryId: turn.memoryId,
  agent: turn.agent,
}));
```

- [ ] **Step 5: Use events in `messagesFromDocument`**

Before the prompt/response fallback, add:

```ts
if (document.events && document.events.length > 0) {
  return messagesFromEvents(document.events, {
    memoryId: document.memoryId,
    agent: document.agent ?? document.observer,
  });
}
```

- [ ] **Step 6: Render tool event cards**

In the message rendering loop, before rendering a normal bubble, add:

```tsx
{message.event?.type === 'toolCall' ? (
  <ToolEventCard event={message.event} />
) : message.event?.type === 'toolOutput' ? (
  <ToolEventCard event={message.event} />
) : (
  <div className="chat-bubble">
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.body}</ReactMarkdown>
    {message.artifacts && message.artifacts.length > 0 ? (
      <ArtifactList artifacts={message.artifacts} />
    ) : null}
  </div>
)}
```

Add:

```tsx
function ToolEventCard({ event }: { event: Extract<TurnEvent, { type: 'toolCall' | 'toolOutput' }> }) {
  if (event.type === 'toolCall') {
    return (
      <details className="chat-tool-call">
        <summary>
          <span>{event.name}</span>
          {event.input ? <span className="chat-tool-call-summary">{compactText(event.input)}</span> : null}
        </summary>
        {event.input ? (
          <div className="chat-tool-call-section">
            <div className="chat-tool-call-label">Input</div>
            <pre>{event.input}</pre>
          </div>
        ) : null}
      </details>
    );
  }
  return (
    <details className="chat-tool-call">
      <summary>
        <span>Tool output</span>
        {event.output ? <span className="chat-tool-call-summary">{compactText(event.output)}</span> : null}
      </summary>
      {event.output ? (
        <div className="chat-tool-call-section">
          <div className="chat-tool-call-label">Output</div>
          <pre>{event.output}</pre>
        </div>
      ) : null}
      {event.artifacts && event.artifacts.length > 0 ? <ArtifactList artifacts={event.artifacts} /> : null}
    </details>
  );
}
```

- [ ] **Step 7: Run board build**

Run:

```bash
pnpm --filter @muninn/board build
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/board/src/server/app.ts packages/board/src/components/ChatView.tsx packages/board/src/styles.css
git commit -m "feat: render board chat from turn events"
```

---

### Task 7: Update OpenClaw Plugin Payloads

**Files:**
- Modify: `openclaw/plugin/src/payloads.ts`
- Modify: `openclaw/plugin/src/hooks.ts`
- Test: `openclaw/plugin/test/payloads.test.mjs`
- Test: `openclaw/plugin/test/hooks.test.mjs`

- [ ] **Step 1: Update payload types**

In `openclaw/plugin/src/payloads.ts`, replace `ToolCall` with:

```ts
export type TurnEvent =
  | { type: "userMessage"; text: string; timestamp?: string; artifacts?: Artifact[] }
  | { type: "assistantMessage"; text: string; timestamp?: string; artifacts?: Artifact[] }
  | { type: "toolCall"; id?: string; name: string; input?: string; timestamp?: string }
  | { type: "toolOutput"; id?: string; output?: string; timestamp?: string; artifacts?: Artifact[] };
```

Replace payload params:

```ts
toolCalls?: ToolCall[];
```

with:

```ts
events?: TurnEvent[];
```

- [ ] **Step 2: Generate fallback events in payload builder**

In `buildCapturePayload`, add:

```ts
const events = normalizeEvents(params.events) ?? [
  { type: "userMessage", text: params.prompt },
  { type: "assistantMessage", text: params.response },
];
```

Include:

```ts
events,
```

in the `turn` payload.

- [ ] **Step 3: Convert hook tool calls to events**

In `openclaw/plugin/src/hooks.ts`, replace cached state:

```ts
toolCalls: ToolCall[];
```

with:

```ts
events: TurnEvent[];
```

When `after_tool_call` fires, append:

```ts
state.events.push({
  type: "toolCall",
  id: event.toolCallId,
  name: event.toolName,
  input: stringifyToolInput(event.input),
});
state.events.push({
  type: "toolOutput",
  id: event.toolCallId,
  output: stringifyToolOutput(event.output),
});
```

When building final payload, ensure user/assistant events bracket the cached tool events:

```ts
events: [
  { type: "userMessage", text: prompt },
  ...state.events,
  { type: "assistantMessage", text: response },
],
```

- [ ] **Step 4: Update plugin tests**

In `openclaw/plugin/test/payloads.test.mjs`, replace assertions like:

```js
assert.deepEqual(payload.turn.toolCalls, [{ name: "read", input: "{\"path\":\"a.ts\"}" }]);
```

with:

```js
assert.deepEqual(payload.turn.events, [
  { type: 'userMessage', text: 'alpha prompt' },
  { type: 'toolCall', name: 'read', input: '{"path":"a.ts"}' },
  { type: 'assistantMessage', text: 'alpha response' },
]);
```

- [ ] **Step 5: Run plugin tests**

Run:

```bash
pnpm --dir openclaw/plugin build
node --test openclaw/plugin/test/payloads.test.mjs openclaw/plugin/test/hooks.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add openclaw/plugin/src/payloads.ts openclaw/plugin/src/hooks.ts openclaw/plugin/test/payloads.test.mjs openclaw/plugin/test/hooks.test.mjs
git commit -m "feat: send ordered turn events from openclaw"
```

---

### Task 8: Update Docs And Demo Contracts

**Files:**
- Modify: `docs/spec/muninn-format-schema.md`
- Modify: `docs/architecture/sidecar-http-api.md`
- Modify: `packages/mcp/DEMO.md`
- Modify: `docs/product/mvp1.md`
- Modify: `docs/workstreams/brief-openclaw-integration.md`
- Modify: `docs/workstreams/progress-openclaw-integration.md`

- [ ] **Step 1: Update format schema doc**

In `docs/spec/muninn-format-schema.md`, replace the turn row snippet:

```ts
tool_calls_json?: string | null;
```

with:

```ts
events_json: string;
```

Add:

```ts
export type TurnEvent =
  | { type: "userMessage"; text: string; timestamp?: string; artifacts?: Artifact[] }
  | { type: "assistantMessage"; text: string; timestamp?: string; artifacts?: Artifact[] }
  | { type: "toolCall"; id?: string; name: string; input?: string; timestamp?: string }
  | { type: "toolOutput"; id?: string; output?: string; timestamp?: string; artifacts?: Artifact[] };
```

- [ ] **Step 2: Update HTTP API doc**

In `docs/architecture/sidecar-http-api.md`, replace:

```ts
toolCalls?: ToolCall[];
```

with:

```ts
events: TurnEvent[];
```

Add:

```md
`events` preserves raw UI/debug chronology. The extractor and observer use `summary` and the text projections, not full tool output.
```

- [ ] **Step 3: Update MCP demo**

In `packages/mcp/DEMO.md`, replace the capture example turn with:

```ts
{
  sessionId: "demo-session",
  agent: "demo-agent",
  prompt: "What changed?",
  response: "The turn schema now stores ordered events.",
  summary: "User asked what changed; assistant explained ordered events.",
  events: [
    { type: "userMessage", text: "What changed?" },
    { type: "assistantMessage", text: "The turn schema now stores ordered events." }
  ]
}
```

- [ ] **Step 4: Update OpenClaw docs**

In docs that mention `toolCalls / artifacts`, replace that phrase with:

```md
`events` / `artifacts`
```

and add:

```md
Tool calls are represented as ordered `toolCall` and `toolOutput` events inside a single turn row.
```

- [ ] **Step 5: Commit**

```bash
git add docs/spec/muninn-format-schema.md docs/architecture/sidecar-http-api.md packages/mcp/DEMO.md docs/product/mvp1.md docs/workstreams/brief-openclaw-integration.md docs/workstreams/progress-openclaw-integration.md
git commit -m "docs: document ordered turn events"
```

---

### Task 9: Full Verification And Reimport

**Files:**
- No source edits unless verification exposes a failure.

- [ ] **Step 1: Run full build**

Run:

```bash
pnpm build
```

Expected: PASS.

- [ ] **Step 2: Run focused tests**

Run:

```bash
cargo test --manifest-path format/Cargo.toml
pnpm --filter @muninn/core test:node
node --test packages/sidecar/test/session_flow.test.mjs
node --test packages/board/test/codex-import-artifacts.test.mjs packages/board/test/*.test.mjs
node --test openclaw/plugin/test/payloads.test.mjs openclaw/plugin/test/hooks.test.mjs
```

Expected: all PASS.

- [ ] **Step 3: Restart sidecar**

Run:

```bash
node packages/sidecar/dist/index.js
```

Expected:

```text
Muninn Sidecar running on http://localhost:8080
```

- [ ] **Step 4: Reimport Codex sessions**

Run:

```bash
curl -sS -X POST 'http://127.0.0.1:8080/api/v1/ui/import/codex' \
  -H 'Content-Type: application/json' \
  --data '{"projectKeys":["muninn","lance"],"projectLimit":5}'
```

Expected JSON:

```json
{
  "importedSessions": 10,
  "failedSessions": []
}
```

`deletedTurns`, `importedTurns`, and `artifactCount` may vary with current local Codex history.

- [ ] **Step 5: Verify event data through API**

Run:

```bash
node - <<'NODE'
const http = require('http');
function get(path) {
  return new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: 8080, path }, (res) => {
    let body = '';
    res.on('data', (d) => body += d);
    res.on('end', () => resolve(JSON.parse(body)));
  }).on('error', reject));
}
(async () => {
  const sessions = await get('/api/v1/ui/session/agents/codex/sessions');
  for (const session of sessions.sessions) {
    const turns = await get('/api/v1/ui/session/agents/codex/sessions/' + encodeURIComponent(session.sessionKey) + '/turns?offset=0&limit=100');
    const hit = turns.turns.find((turn) => turn.events?.some((event) => event.type === 'toolCall'));
    if (hit) {
      console.log(JSON.stringify({
        memoryId: hit.memoryId,
        eventTypes: hit.events.map((event) => event.type).slice(0, 8),
      }, null, 2));
      return;
    }
  }
  throw new Error('no imported turn with toolCall event');
})();
NODE
```

Expected: JSON containing `eventTypes` with `toolCall` and `toolOutput`.

- [ ] **Step 6: Manual UI verification**

Open:

```text
http://localhost:8080/board/?time=all#/session
```

Expected:

- User bubbles render from `userMessage`.
- Assistant bubbles render from `assistantMessage`.
- Tool call cards appear between the assistant messages where the call actually occurred.
- Tool output cards appear after their corresponding tool call.
- Extractor/observer behavior remains based on `summary` and does not include full tool output by default.

- [ ] **Step 7: Commit verification fixes if needed**

If any verification-only fix was required:

```bash
git add <changed-files>
git commit -m "fix: complete ordered turn event migration"
```

If no source changes were made in this task, do not create an empty commit.

---

## Self-Review

**Spec coverage:**
- Minimal schema change is covered by Task 2: `tool_calls_json` becomes `events_json`.
- Public API and capture validation are covered by Tasks 1 and 4.
- Codex import true chronology is covered by Task 5.
- Board UI chronological rendering is covered by Task 6.
- OpenClaw integration is covered by Task 7.
- Docs and full verification are covered by Tasks 8 and 9.
- Extractor/observer not consuming raw tool output is preserved because `prompt`, `response`, and `summary` stay as projections and `events_json` is only for UI/debug chronology.

**Placeholder scan:**
- No `TBD`, `TODO`, or unspecified "add tests" steps are used.
- Each code-changing task includes concrete snippets and exact commands.

**Type consistency:**
- Public type name is `TurnEvent`.
- Storage column name is `events_json`.
- Runtime/API property name is `events`.
- Event type strings are `userMessage`, `assistantMessage`, `toolCall`, and `toolOutput`.
