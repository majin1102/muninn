# Project Dreaming Signal Upsert Design

## Summary

Project dreaming should move from append-only full dream documents to one row per
current project signal. The goal is to support deterministic upsert, evidence
tracking, recency-aware ranking, and project-level signal
budgets without adding UUIDs, signal keys, status fields, or event logs.

The new model uses:

- Lance stable row ids as project signal identities.
- full `turnId` labels as user evidence identities.
- `support_turns` as the source of truth for evidence and ranking.
- dynamic score computed from `support_turns` for top-N ranking and budget
  eviction.
- Lance time travel for historical state.

This design supersedes the document-shaped `dreaming` table design from
`2026-06-17-project-dreaming-design.md` for new current-runtime code paths.

## Goals

- Store each current project signal as one `dreaming` table row.
- Use stable row ids as existing project signal labels in project dreaming
  prompts: `[signal:<stable_row_id>]`.
- Replace session signal weight markers with evidence labels:
  `[<turn_id> +<contribution>]`, where `<turn_id>` is the full persisted turn id
  such as `turn:256`.
- Compute signal score dynamically from evidence contribution and support time.
- Enforce project storage budgets in the service layer:
  - Memory Signals: 100 per project.
  - Skill Signals: 50 per project.
- Keep MCP and Web reads deterministic: query rows, compute score from
  `support_turns`, sort, and parse content.
- Avoid backward compatibility for the old dream-document schema. The active
  dataset must be reset after this schema change.

## Non-Goals

- Do not add UUID signal ids.
- Do not add `signal_key`.
- Do not add `status`, tombstones, or event-log rows.
- Do not expose a separate `weight` concept in storage, API, MCP, Web, or
  prompts.
- Do not store `score`; compute it from `support_turns`.
- Do not expose score decay or project signal budgets as config in this round.
- Do not let the LLM decide evidence contribution values.
- Do not keep `Open Questions` in snapshot, dream, API, MCP, or Web surfaces.

## Data Model

### `session_snapshot`

Session snapshots continue to store full snapshot state:

```text
memory_signals: List<Utf8>
skill_signals: List<Utf8>
skill_details: Utf8
```

The signal string format changes. Signal bullets no longer use `[N]` weight
markers. The marker position becomes an evidence label list. Each label uses the
full persisted turn id, such as `turn:256`; do not wrap it as
`turn:<turn_id>` when the id already contains the `turn:` layer prefix.

```md
- [<turn_id> +<contribution>, <turn_id> +<contribution>] <signal content>
```

Examples:

```md
## Memory Signals

- [turn:256 +1, turn:271 +1] Prefer subtractive prompt and memory-rule changes before adding new rules.

## Skill Signals

- [turn:300 +10, turn:400 +1, turn:412 +1] memory-clean-rerun: Validate memory prompt changes with a clean rerun.
```

Contribution rules:

- Normal supporting user prompt: `+1`.
- Explicit user request to remember or reuse in future sessions: `+10`.
- Assistant responses, command output, tool output, pasted documents, recalled
  memory, and dream injection cannot create evidence labels unless the user
  prompt explicitly confirms or restates the signal.
- The extractor may use only current batch turn ids and evidence labels already
  present in the current snapshot.
- The same turn id may appear at most once per signal.
- Each distinct current-batch turn whose user prompt supports the retained
  signal may add one evidence label; there is no per-signal batch cap beyond
  one label per turn id.
- Merging similar session signals uses the latest prompt-supported wording and
  scope, and merges evidence labels that still support the retained signal.
- If newer user prompt evidence narrows or contradicts earlier evidence, keep
  only evidence labels that still support the retained signal content.

### `dreaming`

The `dreaming` table becomes one row per current project signal.

```text
project: Utf8
created_at: Timestamp(Microsecond, UTC)
updated_at: Timestamp(Microsecond, UTC)
content: Utf8
support_turns: List<Struct<{
  turn_id: Utf8,
  created_at: Timestamp(Microsecond, UTC),
  contribution: Int32
}>>
```

The public project signal id is derived from the Lance stable row id:

```text
signal:<rowid>
```

`content` is the stored human-readable signal fragment. It does not include
`[signal:*]` labels or turn evidence labels.

Signal row timestamps:

- `created_at`: when the signal row was first inserted.
- `updated_at`: when the signal row content or `support_turns` was last
  changed.
- `support_turns.created_at`: when the supporting turn happened; this drives
  score decay and is not a row lifecycle timestamp.

Memory Signal content:

```md
## Memory Signal
Prefer subtractive prompt and memory-rule changes before adding new rules.
```

Skill Signal content:

```md
## Skill Signal
### memory-clean-rerun

Validate memory prompt changes with a clean rerun.

#### When to Use
Use after changing extractor or project dreamer prompt rules.

#### Procedure
- Clear the active dataset.
- Reimport project sessions.
- Run finalize until pending turns are zero.
- Trigger manual project dreaming.
- Inspect the full dream output.
```

The table does not store:

- `dreaming_id`
- `parent_id`
- `session_snapshot_version`
- `kind`
- `signal_key`
- `status`
- `weight`
- `score`

### `dreaming_project`

Add a project watermark table.

```text
project: Utf8
session_snapshot_version: UInt64
updated_at: Timestamp(Microsecond, UTC)
```

This table records the latest `session_snapshot` source version covered by
project dreaming for each project. It replaces the old
`DreamingIndex(project -> latest dreaming id)` checkpoint semantics.

`updated_at` records the last successful project dreaming upsert/trim/watermark
update for the project.

Cleanup floor for `session_snapshot` should use the minimum
`dreaming_project.session_snapshot_version` across projects that have a
watermark.

## Score

`score` is the current top-N ranking value. Ordinary evidence decays over time.
Pinned evidence from explicit remember/reuse requests does not decay:

```text
decay(age_days) = 0.5 ^ (age_days / 90)

normal_score = sum(contribution * decay(now - created_at)
                   for support_turns where contribution < 10)

pinned_score = sum(contribution
                   for support_turns where contribution >= 10)

score = normal_score + pinned_score
```

The 90-day half-life is fixed in this round.

The latest support time is derived from evidence:

```text
last_supported_at = max(support_turns.created_at)
```

`score` is not stored. It is computed from `support_turns` when the service
ranks rows for API/MCP/Web reads and when it enforces project storage budgets.

Top-N ordering:

```text
score desc
last_supported_at desc
stable_row_id asc
```

The LLM never outputs `score`. It only preserves or merges
`signal:*` and `turn:*` labels. The backend owns score calculation.

## Project Signal Budget

Each project has a service-enforced hard cap:

```text
Memory Signals: 100
Skill Signals: 50
```

The signal kind is parsed from `content`:

- `## Memory Signal`
- `## Skill Signal`

The service must not block a valid new signal because the project is already at
budget. After each project dreaming upsert, it inserts or updates all valid
output rows first, then trims current rows.

Budget eviction uses two deterministic retention passes per signal kind:

```text
Memory recent quota: 20
Memory total budget: 100

Skill recent quota: 10
Skill total budget: 50
```

For each kind:

1. Keep the recent quota by `last_supported_at desc`, then `score desc`, then
   stable row id ascending. This gives newly supported signals a chance to enter
   current state.
2. Fill the remaining budget by top-N ordering from rows not already kept.
3. Delete rows outside the combined keep set.

Deletion removes the row from current state. Historical versions are available
through Lance time travel.

Project dreamer prompts must not mention storage budgets. Budget enforcement
must be deterministic service logic.

## Project Dreaming Input

Project dreaming merges current project signal rows with incremental session
signals derived from `session_snapshot` changes after the project watermark.

`session_snapshot` rows store full snapshot state, not signal deltas. The
service uses the table delta only to find sessions whose snapshots changed. For
each selected session/cwd/agent, compare the latest snapshot at `sourceVersion`
with the latest baseline snapshot covered by the previous project watermark, or
an empty baseline on the first run. Render only signal content whose retained
evidence labels include at least one full turn id that was not present in the
baseline snapshot. If no new evidence labels remain for a project, skip the LLM
merge and keep current project signals unchanged.

Existing project signals use stable row labels:

```md
## Existing Project Signals

[signal:101]
## Memory Signal
Prefer focused, minimal fixes and tests.

[signal:102]
## Skill Signal
### memory-clean-rerun

Validate memory prompt changes with a clean rerun.

#### Procedure
- Clear the active dataset.
- Reimport project sessions.
- Run finalize.
- Trigger manual dreaming.
```

Incremental session signals use one or more full-turn-id evidence labels:

```md
## Incremental Session Signals

[turn:256 +1, turn:271 +1]
## Memory Signal
Prefer subtractive prompt and memory-rule changes before adding new rules.

[turn:300 +10]
## Skill Signal
### memory-clean-rerun

Validate memory prompt changes with a clean rerun.

#### Procedure
- Clear the active dataset.
- Reimport project sessions.
- Run finalize until pending turns are zero.
- Trigger manual project dreaming.
- Inspect the full dream output.
```

The service owns a side mapping from full turn id to evidence metadata:

```ts
turn:256 -> { created_at, contribution }
```

The LLM sees labels but does not decide timestamps or contribution values.

## Project Dreamer Output

The dreamer returns the complete current project signal set, not a patch:

```md
# Project Signals

[signal:101]
## Memory Signal
Prefer focused, minimal fixes and tests.

[signal:102, turn:300 +10]
## Skill Signal
### memory-clean-rerun

Validate memory prompt changes with a clean rerun.

#### Procedure
- Clear the active dataset.
- Reimport project sessions.
- Run finalize until pending turns are zero.
- Trigger manual project dreaming.
- Inspect the full dream output.

[turn:256 +1, turn:271 +1]
## Memory Signal
Prefer subtractive prompt and memory-rule changes before adding new rules.
```

Output label rules:

- Every output signal must start with one label list.
- Labels must be copied exactly from the input.
- Allowed labels are only `signal:*` row labels and full turn evidence labels
  present in the input.
- Preserve source-supported meaning, scope, constraints, and signal type.
- Merge or update semantically related signals using incremental wording as the
  latest state; include incremental turn labels only when they support the final
  wording and scope.
- Do not broaden, invent, or reclassify signals.
- Avoid duplicating the same reusable guidance as both a Memory Signal and a
  Skill Signal.
- Existing project signal support history is not shown to the LLM; service code
  preserves existing `support_turns` for retained and merged rows.
- For Skill Signals, merge details when source Skill Signal content supports the
  same reusable workflow.
- Sources are ordered older to newer; later evidence can replace earlier
  overlapping content.
- If merging multiple existing project signals, the first `signal:*` is the
  survivor row.
- Other `signal:*` rows are merged into the survivor and deleted.
- Turn evidence labels are appended to the survivor or inserted row as
  `support_turns`.
- Existing `support_turns` for retained survivor rows are preserved by service
  code; merged non-survivor rows transfer their existing `support_turns` to the
  survivor.
- A signal with no `signal:*` labels inserts a new row.
- An existing input `signal:*` omitted from output is deleted from current state.
- Stored row `content` excludes the label list.

Validation behavior:

Reject and retry if:

- Output does not start with `# Project Signals`.
- A signal has no label list.
- A signal has no valid labels left after unknown labels are ignored.
- A `signal:*` survivor appears in multiple output signals.
- The same turn evidence label appears more than once for the same output signal.
- Content does not start with `## Memory Signal` or `## Skill Signal`.
- A Skill Signal does not contain a `### <skill name>` heading.
- Output contains `## Open Questions`.
- Output contains provenance refs, session ids, or unsupported metadata comments
  outside the required label-list lines. Full turn ids are allowed only inside
  label lists.

Ignore without creating evidence or rows:

- Unknown labels in output.

## Upsert Semantics

For each project dreaming run:

1. Read current project signal rows from `dreaming`, including stable row ids.
2. Read the project watermark from `dreaming_project`.
3. Read `session_snapshot` delta after the watermark at one stable source
   version.
4. Select latest relevant session snapshots for the project, subtract the
   watermark-covered baseline snapshot labels for each session/cwd/agent, and
   render only Memory/Skill signals with new retained evidence labels.
5. Build the project dreamer input.
6. Run the LLM merge.
7. Validate output labels and content.
8. Apply output:
   - Update survivor rows.
   - Insert rows with only turn evidence labels.
   - Merge non-survivor `signal:*` rows into survivor rows.
   - Append turn evidence, deduping by `turn_id`.
   - Delete input rows not present in output.
9. Compute `score` and `last_supported_at` in memory for ranking.
10. Enforce project budgets with recent-quota plus score-quota retention.
11. Upsert `dreaming_project.session_snapshot_version = sourceVersion` and
    `dreaming_project.updated_at = now`.

The stored `sourceVersion` must be the source version used to read the
incremental snapshots. Do not read a later table version after the LLM call.

## API, MCP, And Web

`GET /api/v1/dreaming/project/signals`:

- Query `dreaming` rows for the project.
- Parse `content` to split Memory Signals and Skill Signals.
- Compute `score` from `support_turns`.
- Sort by top-N ordering.
- Return top N per category as structured rows. The response no longer has a
  single dream `memoryId` or dream-row `createdAt`, because project signals are
  no longer stored as one document row.
- Read-side top-N limits are independent from storage budgets: storage keeps up
  to 100 Memory Signals and 50 Skill Signals per project, while APIs, MCP, and
  Web may request smaller windows such as top 5 or top 20.

Suggested response shape:

```ts
{
  project: string;
  memorySignals: Array<{ score: number; text: string }>;
  skillSignals: Array<{
    score: number;
    name: string;
    summary: string;
    detail: string;
  }>;
}
```

`GET /app/api/dreaming/project`:

- Query current project signal rows.
- Build a `ProjectDreamView` from parsed row content.
- Memory rows populate the Memories tab.
- Skill rows populate the Skills tab with parsed details.
- App view rows may include `score`; UI sorting follows backend top-N ordering.

MCP `renderProjectSignals()`:

- Render Memory and Skill signals from row content.
- Do not expose row ids by default.
- Do not include `Open Questions`.
- Do not expose `score` unless the caller explicitly asks for ranking
  diagnostics.

`.dreaming` project tree:

- List projects from distinct projects in current `dreaming` rows.
- Project dreaming `latestUpdatedAt` comes from `dreaming_project.updated_at`.
- A project with no current signal rows does not appear under `.dreaming`.

## Parser And Validator Changes

Current code parses snapshot and dream signals as `[N]` weighted Markdown blocks.
This design replaces those parsers rather than preserving compatibility.

Snapshot parsing:

- `parseSnapshotContent()`, `parseSnapshotPatch()`, `renderSnapshotContent()`,
  `skillNamesFromSignals()`, and `validateSkillSignals()` must accept evidence
  label lists instead of `[N]` markers.
- Memory Signal bullets start with `- [<turn_id> +<contribution>, ...]`.
- Skill Signal bullets start with
  `- [<turn_id> +<contribution>, ...] Skill name: ...`.
- Skill names must be single-line values and must not contain `:`.
- `<turn_id>` is the full persisted id, for example `turn:102`.
- Contributions are limited to `+1` and `+10`.
- Validation rejects old `[N]` markers, unknown current-batch turn ids in
  extractor output, and repeated turn ids inside one signal. Already-stored
  evidence labels may be preserved from the current snapshot; unknown
  non-current labels should be ignored rather than creating evidence.

Project dream parsing:

- The old `# Project Dream: <project>` document parser is replaced for current
  runtime paths.
- Current project signal row content is parsed one row at a time and must start
  with `## Memory Signal` or `## Skill Signal`.
- Project dreamer output validation parses `# Project Signals` plus labeled
  signal blocks; it no longer expects `## Memory Signals`, `## Skill Signals`,
  or `## Skill Details` sections in one document.
- Skill row content must include a `### <skill name>` heading; the skill detail body remains
  inside that row content.
- Skill names are single-line headings and must not contain `:`.

## Prompt Changes

### Extractor

Replace signal weight instructions with evidence-label instructions:

```md
Signal evidence
- Signal bullets use evidence labels instead of weight markers:
  `- [<turn_id> +<contribution>, <turn_id> +<contribution>] <signal content>`.
- Use `+1` for ordinary supporting user prompts.
- Use `+10` when the user explicitly asks to remember or reuse the signal in future sessions.
- Use only current batch turn ids and evidence labels already present in the current snapshot.
- Add one evidence label for each distinct current-batch turn whose user prompt supports the retained signal.
- Do not invent turn ids or contribution values.
- Merge semantically related signals using the latest prompt-supported wording and scope, and merge their supporting evidence labels.
- Do not duplicate the same turn id within one signal.
```

Existing Memory/Skill definitions remain, but examples must use evidence labels
instead of `[N]`.

### Project Dreamer

Replace dream-document instructions with row-label merge instructions:

The complete project dreamer prompt wording, including lightweight Signal
types and Merge rules, is specified in
`2026-06-21-project-dreaming-signal-upsert-prompt-design.md`.

```md
Project signal labels
- Existing project signals use `[signal:<stable_row_id>]`.
- Incremental session signals use one or more `[<turn_id> +<contribution>]` labels.
- Output the complete current project signal set.
- Every output signal must start with labels copied exactly from the input.
- If merging existing project signals, put the surviving `[signal:*]` first.
- Use only labels that appear in the input.
- Do not include labels inside saved signal content.
```

Output format:

```md
# Project Signals

[signal:<id>, <turn_id> +<contribution>]
## Memory Signal
...

[signal:<id>]
## Skill Signal
### <skill name>
...
```

## Native Table Requirements

`DreamingTable` needs current-state mutation APIs:

- `list(project?: string)`
- `get(row_id)`
- `append(row)`
- `update(row_id, row)`
- `delete(row_id)`

Rows returned to TypeScript must include stable row ids as public
`signal:<rowid>` identities or equivalent row-id fields that the service can
render as `[signal:<rowid>]`.

`dreaming_project` needs:

- `get(project)`
- `upsert(project, session_snapshot_version, updated_at)`
- `list()`

`DreamingIndex` and its checkpoint section are removed. The latest project
watermark and cleanup floor come from `dreaming_project`, and `.dreaming`
project listing comes from current `dreaming` rows.

## Migration

No compatibility layer is required. The active dataset must be reset because:

- `dreaming` row semantics change completely.
- `session_snapshot` signal string format changes from `[N]` to evidence labels.
- `DreamingIndex` and its checkpoint state are removed.

Provider config and original Codex session files should be preserved.

## Test Plan

- Rust schema tests:
  - `dreaming` has `project`, `created_at`, `updated_at`, `content`, and `support_turns`.
  - `dreaming_project` has `project`, `session_snapshot_version`, and `updated_at`.
- Rust codec/table tests:
  - round-trip `support_turns`
  - round-trip `dreaming.created_at` and `dreaming.updated_at`
  - stable row id read
  - update by row id
  - delete by row id
  - project watermark upsert with `updated_at`
- Snapshot parser tests:
  - accepts `[turn:101 +1]` and `[turn:101 +10]` where `turn:101` is the full turn id
  - rejects `[N]`
  - rejects unknown current-batch turn ids in extractor output
  - rejects duplicate turn labels in one signal
- Extractor tests:
  - examples render evidence labels
  - explicit remember produces `+10`
  - normal support produces `+1`
  - merging signals merges labels
- Project dreamer tests:
  - prompt contains `[signal:*]` and full-turn-id evidence label rules
  - output validator ignores unknown labels and rejects signals with no valid labels left
  - output validator rejects duplicate survivor rows
  - output validator rejects `## Open Questions`
- Service tests:
  - `[signal:1, turn:101 +1]` updates row 1 and appends support turn `turn:101`
  - `[signal:1, signal:2]` keeps row 1, merges row 2 support turns, deletes row 2
  - `[turn:101 +1, turn:102 +1]` inserts a new row
  - omitted existing signal deletes current row
  - appending support turns dedupes against existing `support_turns` by `turn_id`
  - score uses 90-day half-life for ordinary evidence
  - score does not decay pinned `+10` evidence
  - Memory budget keeps 20 most recently supported rows, then fills to 100 by score ordering
  - Skill budget keeps 10 most recently supported rows, then fills to 50 by score ordering
  - valid new signals are inserted before budget eviction runs
  - watermark stores the source version used for the delta read and the project update time
- API/MCP/Web tests:
  - top-N sorts by computed `score`, then latest support
  - `score` is computed from `support_turns`
  - `.dreaming` project `latestUpdatedAt` comes from `dreaming_project.updated_at`
  - signals API no longer returns a single dream `memoryId`
  - Memory/Skill parse from `content`
  - Open Questions never appear
- Clean-run validation:
  - clear active dataset
  - reimport project sessions
  - finalize to no pending turns
  - run project dreaming
  - inspect `dreaming` rows and UI/MCP top-N output

## Open Design Decisions

None for this implementation round. The first version deliberately fixes:

- score half-life at 90 days
- project budgets at Memory 100 and Skill 50
- recent retention quotas at Memory 20 and Skill 10
- dynamic score calculation instead of stored score
- current-state deletion instead of status rows
