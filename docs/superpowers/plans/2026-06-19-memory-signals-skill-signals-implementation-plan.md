# Memory Signals and Skill Signals Implementation Plan

> **For Majin Nathan:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan.

**Goal:** Replace the single `session_snapshot.signals` blob with structured full-snapshot `memorySignals`, `skillSignals`, `openQuestions`, and hidden `skillDetails`; update extractor and project dreaming prompts/tool loops to use progressive `get_skill`; reset the active dataset and rerun extraction/dreaming for validation.

**Architecture:** Rust `format` owns the persisted Lance schema and Arrow conversion. TypeScript `server/src/pipeline` owns Markdown snapshot parsing/rendering and snapshot state. Extractor and project dreamer each use internal LLM tool loops. Dream rows still store one Markdown `content` document. MCP behavior is not expanded in this round.

**Constraints:** Do not add old-schema compatibility or migration logic. Remove the current `signals` path from current code shapes. Do not add external MCP `get_skill` yet. Preserve unrelated dirty worktree changes.

---

### Task 1: Update Rust session snapshot schema and codec

**Files:**
- `format/src/schema.rs`
- `format/src/session.rs`
- `format/src/codec.rs`

**Step 1: Replace the Lance session schema field.**

In `format/src/schema.rs`, replace:

```rust
Field::new("signals", DataType::Utf8, false),
```

with:

```rust
Field::new(
    "memory_signals",
    DataType::List(Arc::new(Field::new("item", DataType::Utf8, true))),
    false,
),
Field::new(
    "skill_signals",
    DataType::List(Arc::new(Field::new("item", DataType::Utf8, true))),
    false,
),
Field::new(
    "open_questions",
    DataType::List(Arc::new(Field::new("item", DataType::Utf8, true))),
    false,
),
Field::new("skill_details", DataType::Utf8, false),
```

Keep `content` and `references` after these fields.

**Step 2: Replace `SessionSnapshot.signals`.**

In `format/src/session.rs`, replace:

```rust
pub signals: String,
```

with:

```rust
pub memory_signals: Vec<String>,
pub skill_signals: Vec<String>,
pub open_questions: Vec<String>,
pub skill_details: String,
```

`skill_details` is JSON text. Use `"{}"` as the empty value in tests and inserted rows.

**Step 3: Update Arrow write conversion.**

In `format/src/codec.rs`, replace the `signals` `StringArray` with three `ListArray`s and one `StringArray`:

```rust
let memory_signals = build_string_list_array(
    session_snapshots
        .iter()
        .map(|session_snapshot| Some(&session_snapshot.memory_signals)),
);
let skill_signals = build_string_list_array(
    session_snapshots
        .iter()
        .map(|session_snapshot| Some(&session_snapshot.skill_signals)),
);
let open_questions = build_string_list_array(
    session_snapshots
        .iter()
        .map(|session_snapshot| Some(&session_snapshot.open_questions)),
);
let skill_details = StringArray::from_iter_values(
    session_snapshots
        .iter()
        .map(|session_snapshot| session_snapshot.skill_details.as_str()),
);
```

Update the `RecordBatch::try_new` array order to match the schema:

```rust
Arc::new(memory_signals),
Arc::new(skill_signals),
Arc::new(open_questions),
Arc::new(skill_details),
Arc::new(content),
Arc::new(references),
```

**Step 4: Update Arrow read conversion.**

In `record_batch_to_session_snapshots_with_row_ids`, update column indexes:

```rust
let memory_signals = batch.column(10).as_any().downcast_ref::<ListArray>().unwrap();
let skill_signals = batch.column(11).as_any().downcast_ref::<ListArray>().unwrap();
let open_questions = batch.column(12).as_any().downcast_ref::<ListArray>().unwrap();
let skill_details = batch.column(13).as_any().downcast_ref::<StringArray>().unwrap();
let content = batch.column(14).as_any().downcast_ref::<StringArray>().unwrap();
let references = batch.column(15).as_any().downcast_ref::<ListArray>().unwrap();
```

Populate the new struct fields:

```rust
memory_signals: optional_string_list(memory_signals, index).unwrap_or_default(),
skill_signals: optional_string_list(skill_signals, index).unwrap_or_default(),
open_questions: optional_string_list(open_questions, index).unwrap_or_default(),
skill_details: skill_details.value(index).to_string(),
```

**Step 5: Update Rust tests.**

Replace `session_schema_has_signals_field` with assertions that:

```rust
assert!(schema.field_with_name("memory_signals").is_ok());
assert!(schema.field_with_name("skill_signals").is_ok());
assert!(schema.field_with_name("open_questions").is_ok());
assert!(schema.field_with_name("skill_details").is_ok());
assert!(schema.field_with_name("signals").is_err());
```

Rename `session_signals_roundtrip_and_delta_returns_source_version` to `session_signal_fields_roundtrip_and_delta_returns_source_version` and assert all four fields round-trip.

**Verify:**

```bash
cargo test --manifest-path format/Cargo.toml session_schema
cargo test --manifest-path format/Cargo.toml session_signal_fields_roundtrip_and_delta_returns_source_version
```

Expected: both commands pass.

---

### Task 2: Update TypeScript native contracts and session snapshot state

**Files:**
- `server/src/native.ts`
- `server/src/pipeline/snapshot.ts`
- `server/src/pipeline/session.ts`
- Any compile-reported server file still reading or writing `.signals`

**Step 1: Replace `SessionSnapshotRow.signals`.**

In `server/src/native.ts`, replace:

```ts
signals: string;
```

with:

```ts
memorySignals: string[];
skillSignals: string[];
openQuestions: string[];
skillDetails: string;
```

The native napi layer uses serde camelCase, so Rust `memory_signals` maps to JS `memorySignals`.

**Step 2: Add shared signal state types.**

In `server/src/pipeline/snapshot.ts`, add:

```ts
export type SkillDetails = Record<string, string>;

export type SnapshotSignals = {
  memorySignals: string[];
  skillSignals: string[];
  openQuestions: string[];
  skillDetails: SkillDetails;
};
```

Replace `signals?: string` and `signals: string` properties in snapshot parse/result types with the new fields.

**Step 3: Implement skill-name helpers.**

Add:

```ts
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

export function isValidSkillName(value: string): boolean {
  return SKILL_NAME_RE.test(value);
}

export function skillNamesFromSignals(skillSignals: string[]): Set<string> {
  const names = new Set<string>();
  for (const signal of skillSignals) {
    const match = /^- \[\d+\]\s+`([^`]+)`:/.exec(signal.trim());
    if (match && isValidSkillName(match[1]!)) {
      names.add(match[1]!);
    }
  }
  return names;
}
```

Reject invalid Skill Signal cards during validation.

**Step 4: Replace snapshot document parsing.**

`parseSnapshotContent` should parse sections in this order when present:

```md
## Summary
## Memory Signals
## Skill Signals
## Open Questions
## Skill Details
## Extractions
```

Rules:
- `## Summary` remains required for full snapshot content.
- Signal sections are optional in old patch input, but full rendered snapshots should always include the three lightweight signal sections.
- `## Skill Details` is optional.
- `## Extractions` remains optional.
- Each lightweight section returns an array of top-level signal blocks.
- `## Skill Details` returns a map keyed by heading `### `skill-name``.
- The parser validates every skill detail key with `isValidSkillName`.
- Final full snapshot validation requires every `skillDetails` key to exist in `skillNamesFromSignals(skillSignals)`.

**Step 5: Replace snapshot patch parsing.**

`parseSnapshotPatch` should return:

```ts
export type ParsedSnapshotPatch = {
  title?: string;
  summary?: string;
  memorySignals?: string[];
  skillSignals?: string[];
  openQuestions?: string[];
  skillDetails?: SkillDetails;
  skillDetailsDeletes?: string[];
  updates: Array<{
    sequence: number;
    refs: string[];
    title: string;
    summary: string;
    content?: string | null;
  }>;
  additions: Array<{
    refs: string[];
    title: string;
    summary: string;
    content?: string | null;
  }>;
};
```

Patch semantics:
- Omitted `## Memory Signals`, `## Skill Signals`, or `## Open Questions` means unchanged.
- Present but empty lightweight signal section clears only that category.
- Present lightweight signal section is the complete replacement list for that category.
- Omitted `## Skill Details` means unchanged details.
- Present `## Skill Details` contains only changed or new details.
- A detail heading with an empty body deletes that skill detail.
- After applying patch state, delete any stale detail whose skill name is no longer present in `skillSignals`.

**Step 6: Replace snapshot rendering.**

Replace `renderSnapshotContent(title, summary, signals, extractions)` with:

```ts
renderSnapshotContent(
  title: string,
  summary: string,
  signals: SnapshotSignals,
  extractions: ExtractionUnit[],
): string
```

Render:

```md
# Session memory snapshot

## Summary
This session tracks reusable Muninn memory work and the durable extraction state.

## Memory Signals
- [10] 清理数据后重新导入并跑完整 extraction/dreaming 验证，是 Muninn signal prompt 变更后的默认验证方式。

## Skill Signals
- [1] `signal-noise-triage`: Debug Muninn signal and dreaming noise by tracing bad signals, tightening rules, and clean-run validating known noisy sessions.

## Open Questions
- [1] 是否在后续 MCP 中暴露 project-level skill detail 仍未决定。

## Skill Details
### `signal-noise-triage`
# signal-noise-triage

## When to Use
Use when Muninn signal extraction or project dreaming produces noisy, task-local, or wrong-language signals.

## Procedure
- Trace the bad signal back to source prompt, source snapshot, and dream merge input.
- Tighten the minimal prompt rule that allowed the bad signal.
- Reset the active dataset, reimport known noisy sessions, finalize extraction, and run manual project dreaming.

## Pitfalls
- Do not turn prompt/spec drafts or task execution checklists into Memory Signals.

## Verification
- Inspect the full project dream and confirm top signals are reusable, in the supporting prompt language, and free of response-only evidence.

## Extractions
<!-- refs: [turn:1] -->
### Title
Signal prompt design

### Summary
The session refined Muninn signal prompt rules and validation expectations.
```

For empty arrays, render the heading with no bullets under it. For empty `skillDetails`, render `## Skill Details` with no entries.

**Step 7: Update session state flow.**

In `server/src/pipeline/session.ts`:
- Replace `SessionSnapshot.signals` with the four new fields.
- Replace `SessionMemory.signals?: string` with `memorySignals`, `skillSignals`, `openQuestions`, `skillDetails`.
- Replace `SessionExtractionResult.signals` similarly.
- Update `cloneSessionThread`, `currentSessionMemory`, `applyExtraction`, `toSessionSnapshot`, `deserializeSnapshot`, and `emptySnapshot`.
- `toSessionSnapshot` writes `skillDetails: JSON.stringify(snapshot.skillDetails ?? {})`.
- `deserializeSnapshot` reads `row.skillDetails` with a small safe JSON parser that returns `{}` for empty string and throws for non-object JSON in current code paths.

**Verify:**

```bash
pnpm --filter @muninn/server build
```

Expected: initial failures point only to remaining `.signals` references; fix them in current-code paths until build proceeds to later planned test updates.

---

### Task 3: Update extractor prompt, renderer, validation, and internal `get_skill`

**Files:**
- `server/prompts/extractor.yaml`
- `server/src/llm/extractor.ts`
- `server/test/memory/prompt-loader.test.mjs`
- `server/test/memory/client-internals.test.mjs`

**Step 1: Replace extractor prompt input/tool sections.**

In `server/prompts/extractor.yaml`, replace the existing `Inputs` and `Tool use` bullets with:

```md
Inputs
- Current snapshot title, summary, existing lightweight signal sections, and existing extraction titles/summaries.
- Existing extractions are marked by `<!-- sequence: N -->`.
- Skill Details are hidden from the default snapshot view.
- Current batch turns in the Input Markdown.
- The `get_extraction` tool for reading full extraction details by sequence.
- The `get_skill` tool for reading hidden detail for an existing Skill Signal by skill name.

Tool use
- Compare current batch turns with existing extraction titles, summaries, Memory Signals, Skill Signals, and Open Questions before creating new memory units or signals.
- If an existing extraction may cover the same topic, call `get_extraction({ sequences })` and update that extraction instead of creating a duplicate.
- Do not split related content into a new extraction just to avoid calling `get_extraction`.
- Split only when the existing unit would exceed budget and the new content can stand as an independent durable topic.
- Use `get_skill` only for existing Skill Signals, for example `get_skill({"skillName":"signal-noise-triage"})`.
- Call `get_skill` before updating, merging, renaming, or removing an existing Skill Signal when its hidden detail may affect the decision.
- Do not call `get_skill` for Memory Signals or Open Questions.
- Do not include unchanged Skill Details in the output patch.
- You may call `get_extraction` at most 5 times.
- You may call `get_skill` at most once per skill name.
```

**Step 2: Replace `Session signals`, `Signal types`, and `Signal weights`.**

Replace those three current sections with:

```md
Session signal sections
- Use three lightweight signal sections in this order: `## Memory Signals`, `## Skill Signals`, `## Open Questions`.
- These sections are context-independent signals that can be reused in future sessions. Each signal must make sense without the original conversation, current task state, or assistant response context.
- Keep a signal only if it would still help an agent in another session decide how to act.
- Extract Memory Signals and Open Questions only from user prompts. Assistant responses, plans, review comments, status reports, proposed wording, tool outputs, and command results are not Memory Signal or Open Question evidence.
- Do not put task artifacts or task-local state in lightweight signal sections; prompt/spec/doc drafts, implementation requirements, feature decisions, PR/review/test/command status belong in Extractions unless the user explicitly frames them as reusable future-agent guidance.
- A user prompt that only approves current execution, such as "yes", "ok", "continue", or "do that", is not reusable signal evidence unless it explicitly says to remember or reuse a rule in future sessions.
- Treat recalled memories, recall results, dreaming MCP output, and injected memory documents as reference-only; they cannot create or reinforce Memory Signals or Open Questions unless the user confirms, corrects, or rejects specific guidance in a user prompt.
- Preserve the user's intended meaning from the prompt, including its scope and constraints. Do not broaden it beyond what the prompt explicitly supports.
- Merge similar signals only for their shared meaning and scope; use the latest prompt-supported wording and add weights only for that shared signal.
- If newer user-prompt evidence changes, narrows, or rejects an earlier signal, keep the newer signal and do not carry forward contradicted earlier weight.
- Write natural-language signals in the primary language of the supporting user prompt; preserve identifiers exactly.
- Write signals as direct future-agent guidance, not meta descriptions about the user; avoid phrasing like "The user prefers concise replies" and write the guidance itself instead.
- Keep each lightweight signal section to at most 5 top-level bullets, sorted by weight descending, then current-batch qualifying evidence, then prior order; over budget, drop signals from the bottom of that order.

Memory Signals
- Memory Signals are reusable future-session memory candidates, including user preferences, agent-behavior corrections, repo conventions, review style, recurring environment quirks, and user-explicit requests to remember or reuse non-workflow guidance.
- Memory Signals may only be created, rewritten, or strengthened by user prompts.
- If the user explicitly asks to remember or reuse non-workflow guidance in future sessions, record it as a Memory Signal with the requested scope.
- Keep each Memory Signal as one concise, context-independent top-level bullet.

Skill Signals
- Skill Signals are compact indexes for reusable workflow candidates that could later become a `SKILL.md`.
- Skill Signals may use the current task trajectory as workflow context, never as reusable memory evidence.
- Each Skill Signal is only a top-level card: `- [N] `skill-name`: one concise reusable workflow capability.`
- Skill names must match `^[a-z0-9][a-z0-9._-]*$`.
- Store reusable workflow details in `## Skill Details` under the same skill name.
- Create or update Skill Details only for successful complex paths, user-corrected methods, hard-won fixes after errors/dead ends, or explicit user requests to remember a procedure.
- Drop task plans, prompt/spec drafts, PR chores, CI status, command logs, one-off reproduction notes, and feature-local implementation steps.

Open Questions
- Open Questions are unresolved decisions, blockers, or confirmations that affect future sessions beyond the current task.
- Open Questions may only be created, rewritten, or strengthened by user prompts.
- Remove an Open Question once it is resolved.

Signal weights
- Use `[1]` to `[10]`; cap at `[10]`.
- Memory Signals and Open Questions: only user-prompt evidence may create, rewrite, or increase weight.
- Skill Signals: qualifying reusable workflow evidence may create, rewrite, or increase weight only when it passes the Skill Signal rules above.
- If the user explicitly asks to remember or reuse a Memory Signal or Skill Signal in future sessions, preserve the requested scope and set its weight to `[10]`.
- Count evidence events conservatively. Repeated task steps, command sequences, or feature-local instructions do not increase weight.
- A new signal starts with weight equal to its current-batch evidence count, capped at `[3]`, unless the explicit-remember rule applies.
- An existing signal gains `+1` per current-batch evidence event, capped at `+3` per batch, unless the explicit-remember rule applies.
- Assistant responses and agent application must not create Memory Signals or Open Questions, rewrite them, broaden their scope, or increase numeric weight.
- Do not invent historical counts; use existing weight plus current-batch evidence.
```

**Step 3: Replace budget and output rules.**

In `Budget`, replace the current top-level signal bullet with:

```md
- Each top-level lightweight signal is one concise, context-independent sentence, usually under 40 words.
- Skill Details are procedure detail space, not a transcript; keep reusable `When to Use`, `Procedure`, `Pitfalls`, and `Verification` sections concise.
```

In `Output format`, replace old `## Signals` rules with:

```md
- Include `## Memory Signals` only when Memory Signals change; omit when unchanged; an empty `## Memory Signals` clears existing Memory Signals.
- Include `## Skill Signals` only when Skill Signals change; omit when unchanged; an empty `## Skill Signals` clears existing Skill Signals.
- Include `## Open Questions` only when Open Questions change; omit when unchanged; an empty `## Open Questions` clears existing Open Questions.
- Include `## Skill Details` only when any Skill Detail changes or should be removed; omit unchanged Skill Details.
- In `## Skill Details`, each changed detail starts with `### `skill-name``.
- An empty Skill Detail body removes that skill detail.
- Every changed Skill Detail must have a matching Skill Signal after the patch is applied.
```

**Step 4: Replace example labels and sections.**

Change renderer/example labels:

```diff
- Prompt (signal evidence):
+ Prompt (memory signal evidence):

- Response (not signal evidence):
+ Response (workflow context, not memory signal evidence):
```

Replace example `## Signals`/`### Guidance`/`### Skills`/`### Open Questions` with `## Memory Signals`, `## Skill Signals`, `## Open Questions`, and add `## Skill Details` only where the example changes skill detail.

Use this Skill Signal example shape:

```md
## Skill Signals

- [1] `report-export-triage`: Triage report export failures by checking job logs before object storage permissions.

## Skill Details

### `report-export-triage`
# report-export-triage

## When to Use
Use when report export jobs fail.

## Procedure
- Check job logs before object storage permissions.

## Pitfalls
- Do not preserve temporary project names as reusable rules.

## Verification
- Keep the final root cause and fix, not every inspection step.
```

**Step 5: Add extractor `get_skill` tool.**

In `server/src/llm/extractor.ts`:
- Add `MAX_GET_SKILL_CALLS_PER_NAME = 1`.
- Add `getSkillSpec(): LlmTool`.
- Add `createGetSkillTool(input)` returning `{ skillName, content }` or `{ skillName, error }`.
- Track `readSkillNames` in validation trace for observability.
- Pass tools `[getExtractionSpec(), getSkillSpec()]`.
- Add handler:

```ts
get_skill: (args) => {
  const skillName = normalizeSkillNameArg(args.skillName);
  if (!skillName) {
    return { error: 'skillName is required' };
  }
  if (readSkillNames.has(skillName)) {
    return { skillName, error: 'skill already read' };
  }
  readSkillNames.add(skillName);
  return createGetSkillTool(input)(args);
},
```

Do not count `get_skill` calls against `MAX_GET_EXTRACTION_CALLS`; set `maxSteps` to `MAX_GET_EXTRACTION_CALLS + input.sessionMemory.skillSignals.length + 2`.

**Step 6: Update extractor validation merge.**

`validateSessionExtractionResult` should:
- Parse patch with the new sections.
- Apply omitted/empty/replacement section semantics.
- Apply Skill Detail changes.
- Drop stale details after Skill Signal replacement.
- Render full snapshot content with the new section layout.
- Return new arrays/map in `SessionExtractionResult`.

**Verify:**

```bash
node server/test/memory/prompt-loader.test.mjs
node server/test/memory/client-internals.test.mjs
```

Expected: prompt tests pass; extractor internal tests cover new renderer labels, hidden Skill Details, `get_skill`, clear/preserve/replace semantics, stale detail deletion, and invalid skill-name rejection.

---

### Task 4: Update project dream content parser and API signal shape

**Files:**
- `server/src/dreaming/content.ts`
- `common/src/api.ts`
- `server/src/http.ts`
- `mcp/src/index.ts`
- `mcp/src/server-client.ts`
- `server/test/memory/project-dream-content.test.mjs`

**Step 1: Replace project signal response types.**

In `common/src/api.ts`, replace:

```ts
guidance: string[];
skills: string[];
openQuestions: string[];
```

with:

```ts
memorySignals: string[];
skillSignals: string[];
openQuestions: string[];
```

Keep `memoryId`, `project`, `createdAt`, and `requestId` unchanged.

**Step 2: Update project dream content validation.**

In `server/src/dreaming/content.ts`, replace required headings with:

```ts
[
  '## Memory Signals',
  '## Skill Signals',
  '## Open Questions',
  '## Skill Details',
]
```

Rules:
- Content must start with `# Project Dream: <project>`.
- Project title must exactly match requested project when provided.
- Each top-level signal under the first three sections must start `- [N]`.
- Every Skill Signal must use `- [N] `skill-name`: one concise reusable workflow capability.` with a valid skill name.
- Every `## Skill Details` entry must start with `### `skill-name`` and match an existing Skill Signal.
- Existing provenance-ref rejection remains.

**Step 3: Add parser helpers.**

Add:

```ts
export type ProjectDreamSignals = {
  memorySignals: string[];
  skillSignals: string[];
  openQuestions: string[];
};

export function parseProjectDreamSkillDetails(content: string, project?: string): Record<string, string>;

export function stripProjectDreamSkillDetails(content: string, project?: string): string;
```

`parseProjectDreamSignals(content, limit, project)` returns top weighted blocks from:
- `## Memory Signals`
- `## Skill Signals`
- `## Open Questions`

It must ignore `## Skill Details`.

**Step 4: Keep MCP thin with mechanical rename only.**

Do not add MCP `get_skill`. If TypeScript compilation reaches `mcp`, update only the existing `project_signals` renderer field names from `guidance`/`skills` to `memorySignals`/`skillSignals`.

**Verify:**

```bash
node server/test/memory/project-dream-content.test.mjs
pnpm --filter @muninn/server build
```

Expected: parser tests pass; server build has no stale `guidance`/`skills` API response errors.

---

### Task 5: Update project dreamer prompt and add internal `get_skill`

**Files:**
- `server/prompts/project-dreamer.yaml`
- `server/src/dreaming/project-dreamer.ts`
- `server/test/memory/prompt-loader.test.mjs`
- `server/test/memory/project-dreamer.test.mjs`

**Step 1: Replace project dreamer prompt input/tool text.**

In `server/prompts/project-dreamer.yaml`, replace `Inputs` with:

```md
Inputs
- Parent dream content without `## Skill Details`, if one exists.
- Incremental Memory Signals, Skill Signals, and Open Questions selected for this merge.
- Skill Details are hidden from the default input.
- The `get_skill` tool for reading parent and incremental Skill Details by skill name.
```

Add `Tool use` after `Inputs`:

```md
Tool use
- Use `get_skill` only for Skill Signals, for example `get_skill({"skillName":"signal-noise-triage"})`.
- Call `get_skill` before preserving, merging, rewriting, or dropping a Skill Signal when the card alone is not enough to safely judge the reusable workflow.
- Do not call `get_skill` for Memory Signals or Open Questions.
- Call `get_skill` at most once per skill name per merge.
```

**Step 2: Replace signal definition, merge rules, signal types, budget, and output.**

Use:

```md
Signal definition
- Memory Signals, Skill Signals, and Open Questions are context-independent project memory candidates that future sessions can reuse without the original session context.
- Each output signal must be understandable and actionable without the original conversation, current task state, or source session context.
- Keep only signals that remain reusable at project scope.

Merge rules
- Preserve the intended meaning of source signals, including scope and constraints. Do not broaden it beyond what source signals explicitly support.
- Merge similar Memory Signals and Open Questions only for their shared meaning and scope; use the latest source-supported wording and add weights only for that shared signal.
- Merge Skill Signals by skill name and reusable workflow meaning; use loaded Skill Details to merge reusable procedure, pitfalls, and verification.
- Treat `[10]` source signals as explicit user-pinned signals; preserve them unless newer source signals explicitly change, narrow, reject, or supersede them.
- If newer source signals change, narrow, or reject an earlier signal, keep the newer signal and do not carry forward contradicted earlier weight.
- Drop task-local, feature-specific, PR-specific, CI/result-specific, command/checklist, prompt/spec draft, and implementation-plan content instead of rewriting it into project-level signals.
- Do not increase a parent-only signal's weight unless incremental signals support it.
- When incremental signals correct or supersede a parent signal, do not add the contradicted parent weight; rewrite or remove the parent signal.
- Write natural-language output signals in the primary language already used by the source signals; preserve identifiers exactly.
- Write output signals as direct future-agent guidance, not meta descriptions about the user; avoid phrasing like "The user prefers concise replies" and write the guidance itself instead.
- Do not invent facts, user preferences, decisions, workflows, or open questions.

Signal types
- Memory Signals: reusable future-session memory candidates, including user preferences, agent-behavior corrections, repo conventions, review style, recurring environment quirks, and user-explicit requests to remember or reuse non-workflow guidance.
- Skill Signals: compact indexes for reusable workflow candidates that could later become a `SKILL.md`.
  - Each Skill Signal is only a top-level card: `- [N] `skill-name`: one concise reusable workflow capability.`
  - Skill names must match `^[a-z0-9][a-z0-9._-]*$`.
  - Store reusable workflow details in `## Skill Details` under the same skill name.
  - Drop the Skill Signal if its reusable workflow cannot be described without the original task context.
- Open Questions: unresolved decisions, blockers, or confirmations that affect future sessions beyond the current task; remove once resolved.

Budget
- Keep at most 20 top-level bullets under each lightweight signal section.
- These are upper bounds, not targets to fill.
- Do not add filler bullets.
- Memory Signals and Open Questions should use concise top-level bullets.
- Skill Signals should use compact top-level cards; put reusable workflow detail under `## Skill Details`.

Output format
- Output exactly one Markdown document.
- Start with `# Project Dream: {{project}}`.
- Include `## Memory Signals`, `## Skill Signals`, `## Open Questions`, and `## Skill Details` in that order.
- Each top-level signal bullet must start with a weight marker like `- [4]`.
- Every Skill Signal must use a valid skill name in backticks.
- Every `## Skill Details` entry must start with `### `skill-name`` and must have a matching Skill Signal.
```

Keep existing `Signal weights` except section names are now lightweight categories; project dream weights remain unbounded.

**Step 3: Update user template.**

Replace:

```md
## Incremental Signals
{{incremental_signals}}
```

with:

```md
## Incremental Lightweight Signals
{{incremental_signals}}
```

The parent dream value passed to the template must already have `## Skill Details` stripped.

**Step 4: Add dreamer tool loop.**

In `server/src/dreaming/project-dreamer.ts`:
- Import `generateWithTools`, `LlmTool`, `LlmToolCall`, `LlmToolMessage`, and related types.
- Add:

```ts
export type ProjectDreamSkillContext = {
  parent: Record<string, string>;
  incremental: Array<{
    source: string;
    skillDetails: Record<string, string>;
  }>;
};
```

- Extend `ProjectDreamInput`:

```ts
skillContext?: ProjectDreamSkillContext;
```

- Add `getSkillSpec()` and `createGetSkillTool(input)`.
- Add a dreamer `runToolLoop` or extract the extractor loop into a shared local helper if that is smaller. Keep it server-local; do not introduce a cross-package abstraction unless build pressure justifies it.
- Use task `'extractor'` when calling `generateWithTools`, matching existing dreamer use of extractor config.
- Cap max steps at `uniqueSkillNames(input) + 2`.
- Retry validation like current `mergeProjectDream`.

**Step 5: Define dreamer `get_skill` result.**

Return:

```md
# Skill Detail: <skillName>

## Parent Project Detail
<parent detail or (none)>

## Incremental Session Details
### Source 1
<detail>
### Source 2
<detail>
```

Use synthetic source labels like `Source 1`, not raw session ids.

**Step 6: Update mock dreamer.**

Mock output for no parent:

```md
# Project Dream: <project>

## Memory Signals
<incremental memory signals>

## Skill Signals
<incremental skill signals>

## Open Questions
<incremental open questions>

## Skill Details
<included details when provided by input/mock path>
```

For parent append behavior, append incremental memory signals under `## Memory Signals`; keep sections valid.

**Verify:**

```bash
node server/test/memory/prompt-loader.test.mjs
node server/test/memory/project-dreamer.test.mjs
```

Expected: dreamer prompt tests see new headings and `get_skill` rules; dreamer tests cover retry, project-title validation, hidden details in default prompt, and tool result shape.

---

### Task 6: Update project dreaming service selection and skill detail context

**Files:**
- `server/src/dreaming/service.ts`
- `server/test/memory/project-dreaming-service.test.mjs`

**Step 1: Replace signal presence logic.**

Replace:

```ts
function hasSignals(row: SessionSnapshotRow): boolean {
  return typeof row.signals === 'string' && row.signals.trim().length > 0;
}
```

with:

```ts
function hasSignalState(row: SessionSnapshotRow): boolean {
  return row.memorySignals.length > 0
    || row.skillSignals.length > 0
    || row.openQuestions.length > 0
    || Object.keys(parseSkillDetailsJson(row.skillDetails)).length > 0;
}
```

Use `hasSignalState` in `projectsWithSignals` and `selectedSignals`.

**Step 2: Build lightweight incremental input.**

Replace `selected.map((row) => row.signals.trim()).join('\n\n')` with a renderer:

```ts
function renderIncrementalSignals(rows: SessionSnapshotRow[]): string {
  return rows.map((row, index) => [
    `### Source ${index + 1}`,
    '',
    '## Memory Signals',
    renderLines(row.memorySignals),
    '',
    '## Skill Signals',
    renderLines(row.skillSignals),
    '',
    '## Open Questions',
    renderLines(row.openQuestions),
  ].join('\n').trim()).join('\n\n');
}
```

Do not include raw session ids.

**Step 3: Strip parent Skill Details from prompt input.**

Before calling `mergeProjectDream`, pass:

```ts
parentDream: parentRow?.content ? stripProjectDreamSkillDetails(parentRow.content, parentRow.project) : '',
```

**Step 4: Build skill context.**

Pass:

```ts
skillContext: {
  parent: parentRow ? parseProjectDreamSkillDetails(parentRow.content, parentRow.project) : {},
  incremental: selected.map((row, index) => ({
    source: `Source ${index + 1}`,
    skillDetails: parseSkillDetailsJson(row.skillDetails),
  })),
}
```

Only include details for selected current rows.

**Step 5: Keep per-project queue.**

Do not change `creates`. Manual API and scheduled global dreaming continue sharing `ProjectDreamingService.create(project)`.

**Verify:**

```bash
node server/test/memory/project-dreaming-service.test.mjs
```

Expected: selected rows use new fields, no raw session ids in incremental input, no merge when no changed signal state, and skill context includes parent plus selected incremental details.

---

### Task 7: Update server-facing session views and remaining call sites

**Files to inspect and update based on compile/test failures:**
- `server/src/backend.ts`
- `server/src/api/memory.ts`
- `server/src/web/sessions.ts`
- `server/test/memory/session-index-runtime.test.mjs`
- Any remaining `rg "\.signals|signals:" server/src server/test/memory common/src mcp/src`

**Step 1: Replace timeline signals item rendering.**

Where session timelines currently render one `signals` Markdown blob, render:

```md
## Memory Signals
- [10] 清理数据后重新导入并跑完整 extraction/dreaming 验证，是 Muninn signal prompt 变更后的默认验证方式。

## Skill Signals
- [1] `signal-noise-triage`: Debug Muninn signal and dreaming noise by tracing bad signals, tightening rules, and clean-run validating known noisy sessions.

## Open Questions
- [1] 是否在后续 MCP 中暴露 project-level skill detail 仍未决定。
```

Keep timeline item kind `'signals'` unchanged unless a type error forces a narrower internal rename. This avoids expanding public UI contract more than needed.

**Step 2: Update mock/test snapshot factories.**

Every test fixture that currently has:

```ts
signals: '',
```

becomes:

```ts
memorySignals: [],
skillSignals: [],
openQuestions: [],
skillDetails: '{}',
```

For in-memory `SnapshotContent` and `SessionMemory`, use `skillDetails: {}` instead of JSON text.

**Step 3: Remove stale old section names in tests.**

Update expectations from:

```md
## Signals
### Guidance
### Skills
### Open Questions
```

to:

```md
## Memory Signals
## Skill Signals
## Open Questions
## Skill Details
```

**Verify:**

```bash
rg "\.signals|signals:" server/src server/test/memory common/src mcp/src
pnpm --filter @muninn/server build
```

Expected: no current-code `.signals` references remain for session snapshots; build passes or reports only tests/docs not covered by this task.

---

### Task 8: Run full targeted verification

Run:

```bash
node server/test/memory/prompt-loader.test.mjs
node server/test/memory/client-internals.test.mjs
node server/test/memory/project-dreamer.test.mjs
node server/test/memory/project-dream-content.test.mjs
node server/test/memory/project-dreaming-service.test.mjs
pnpm --filter @muninn/server build
cargo test --manifest-path format/Cargo.toml
cargo check --manifest-path server/native/Cargo.toml
```

Expected:
- All listed Node tests pass.
- Server build passes.
- Format tests pass.
- Native Rust check passes.

If a failure is from an unrelated dirty change already present in the worktree, record it in the final handoff instead of reverting the unrelated file.

---

### Task 9: Reset active dataset and rerun import/dreaming validation

**Do this only after Task 8 passes.**

**Step 1: Stop current Muninn server.**

Use the repo's CLI or stop only the Muninn process listening on `127.0.0.1:8080`. Do not kill unrelated Node processes.

**Step 2: Clear active dataset and runtime checkpoint/cache.**

Clear the active dataset at:

```text
/home/majin.nathan/.muninn/main
```

Also clear runtime checkpoint/cache state that can restore old `sessionIndex` or `dreamingIndex`.

Keep:
- `~/.muninn/muninn.json`
- original Codex session files

**Step 3: Restart server.**

Start with:

```bash
NODE_USE_ENV_PROXY=1 pnpm muninn run
```

Use an available port if `8080` is already occupied by a non-Muninn process.

**Step 4: Validate empty active dataset.**

Confirm these tables are empty or not created:

```text
turn
session_snapshot
extraction
dreaming
observation
observation_context
```

**Step 5: Import latest Muninn sessions and finalize.**

Import the known current Muninn Codex sessions:

```text
019ed12d-fa36-7af2-b502-d7c3639ce117
019edc18-dab0-7d41-acbe-29b3f78d5a30
019ece5d-05f6-7091-9901-20e594d62387
019ecabb-f1e6-7840-b0a7-21f83ad58a5c
019ec532-dc1d-7030-be20-691f226b7e88
```

Project:

```text
github.com/majin1102/muninn
```

Call finalize and wait until:

```text
pendingTurns = 0
extractor phase = idle
```

**Step 6: Run manual project dreaming.**

Call:

```http
POST /api/v1/dreaming/project
project=github.com/majin1102/muninn
```

Then fetch:

```http
GET /api/v1/dreaming/project/signals
project=github.com/majin1102/muninn
```

**Step 7: Inspect full dream content.**

Confirm:
- The title is exactly `# Project Dream: github.com/majin1102/muninn`.
- The document has `## Memory Signals`, `## Skill Signals`, `## Open Questions`, and `## Skill Details`.
- The current-session signal “修改 prompt 后先清理数据、重新导入、finalize、manual dreaming、检查完整 dream” is represented as a reusable workflow only if it survives the Skill Signal rules, with full procedure under `## Skill Details`.
- Direct reusable guidance is in Chinese when supported by Chinese user prompts.
- Identifiers such as `session_snapshot`, `ProjectDreamingService.create(project)`, and `POST /api/v1/dreaming/project` are preserved exactly.
- No response-only signal, task-local prompt/spec draft, CI/result detail, PR chore, command checklist, or compressed one-off task step appears as a top Memory Signal or Skill Signal.
- Explicit remember/reuse signals, if present, use `[10]`.

---

### Task 10: Final report

Report:
- Files changed by category.
- Verification commands and pass/fail results.
- Reset/import/finalize/dreaming results.
- Full dream content or the relevant complete `# Project Dream: github.com/majin1102/muninn` Markdown, depending on user preference in the live turn.
- Any unrelated dirty worktree changes that were not touched.
