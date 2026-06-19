# Memory Signals and Skill Signals Design

## Summary

Muninn should replace the single session `signals` Markdown blob with typed
snapshot state for memory signals, skill signals, open questions, and hidden
skill details.

The goal is to keep future-session signal injection lightweight while preserving
procedural detail for skill merge. `Memory Signals`, `Skill Signals`, and
`Open Questions` are top-level lightweight categories. `Skill Details` is hidden
from the default snapshot view and is loaded on demand by internal LLM tools.

MCP is out of scope for this design. This round does not add an external MCP
`get_skill` tool.

## Data Model

Replace `session_snapshot.signals` with four fields:

```ts
memorySignals: string[];
skillSignals: string[];
openQuestions: string[];
skillDetails: Record<string, string>;
```

The Lance schema should use:

```text
memory_signals: List<Utf8>
skill_signals: List<Utf8>
open_questions: List<Utf8>
skill_details: Utf8
```

`skill_details` stores a JSON object. Its keys are skill names and its values are
complete Markdown skill detail drafts.

All four fields are full snapshot state, not deltas. Dreaming still selects
changed snapshot rows by `session_snapshot_version`; each selected row contains
the full current state for that session snapshot.

Remove the old `signals` field from current code paths. Do not add a migration
or compatibility layer for old `session_snapshot` tables; this is an MVP schema
change and the active dataset must be reset.

## Skill Names

Use the term `skill name`, not `slug`.

Skill names follow the Hermes-style identifier shape:

```text
^[a-z0-9][a-z0-9._-]*$
```

The skill name in a Skill Signal must match the key in `skillDetails`.

Example:

```md
- [1] `signal-noise-triage`: Debug Muninn signal and dreaming noise by tracing bad signals, tightening rules, and clean-run validating known noisy sessions.
```

## Snapshot Rendering

The default snapshot view shown to the extractor should render only lightweight
state:

```md
## Memory Signals
- [10] ...

## Skill Signals
- [1] `signal-noise-triage`: ...

## Open Questions
- [1] ...
```

Do not render `Skill Details` in the default snapshot view. Skill details are
available only through the extractor's internal `get_skill` tool.

Full snapshot content may render all four sections for UI/debugging:

```md
## Memory Signals

## Skill Signals

## Open Questions

## Skill Details
### `signal-noise-triage`
# signal-noise-triage

## When to Use

## Procedure

## Pitfalls

## Verification
```

`Skill Details` is a rendered form of the `skillDetails` map; the map remains
the storage source of truth for session snapshots.

## Extractor Design

The extractor keeps `get_extraction` and adds an internal `get_skill` tool:

```ts
get_extraction({ sequences })
get_skill({ skillName })
```

`get_skill` reads `sessionMemory.skillDetails[skillName]` from the current
session snapshot. It is not an MCP tool.

Extractor tool rules:

```md
Tool use
- Compare current batch turns with existing extraction titles, summaries, Memory Signals, Skill Signals, and Open Questions before creating new memory units or signals.
- If an existing extraction may cover the same topic, call `get_extraction({ sequences })` and update that extraction instead of creating a duplicate.
- Use `get_skill({"skillName":"..."})` only for existing Skill Signals.
- Call `get_skill` before updating, merging, renaming, or removing an existing Skill Signal when its hidden detail may affect the decision.
- Do not call `get_skill` for Memory Signals or Open Questions.
- Do not include unchanged Skill Details in the output patch.
- You may call `get_extraction` at most 5 times.
- You may call `get_skill` at most once per skill name.
```

Session signal prompt structure should be split by category:

```md
Session signal sections
- Use three lightweight signal sections in this order: `## Memory Signals`, `## Skill Signals`, `## Open Questions`.
- These sections are context-independent signals that can be reused in future sessions.
- Keep a signal only if it would still help an agent in another session decide how to act.
- Keep each signal section to at most 5 top-level bullets, sorted by weight descending, then current-batch qualifying evidence, then prior order.

Memory Signals
- Memory Signals are reusable future-session memory candidates, including user preferences, agent-behavior corrections, repo conventions, review style, recurring environment quirks, and user-explicit requests to remember or reuse non-workflow guidance.
- Memory Signals may only be created, rewritten, or strengthened by user prompts.
- Do not use assistant responses, plans, review comments, status reports, proposed wording, tool outputs, or command results as Memory Signal evidence.
- Preserve the user's intended meaning from the prompt, including its scope and constraints. Do not broaden it beyond what the prompt explicitly supports.
- Write Memory Signals as direct future-agent guidance, not meta descriptions about the user; avoid phrasing like "The user prefers..." and write the guidance itself instead.

Skill Signals
- Skill Signals are compact indexes for reusable workflow candidates that could later become a `SKILL.md`.
- Skill Signals may use the current task trajectory as workflow context, never as reusable memory evidence.
- Each Skill Signal is only a top-level card: `- [N] `skill-name`: one concise reusable workflow capability.`
- Store reusable workflow details in `## Skill Details` under the same skill name.
- Create or update Skill Details only for successful complex paths, user-corrected methods, hard-won fixes after errors/dead ends, or explicit user requests to remember a procedure.
- Drop task plans, prompt/spec drafts, PR chores, CI status, command logs, one-off reproduction notes, and feature-local implementation steps.

Open Questions
- Open Questions are unresolved decisions, blockers, or confirmations that affect future sessions beyond the current task.
- Open Questions may only be created, rewritten, or strengthened by user prompts.
- Remove an Open Question once it is resolved.
```

Signal weight rules:

```md
Signal weights
- Use `[1]` to `[10]`; cap at `[10]`.
- Memory Signals and Open Questions: only user-prompt evidence may create, rewrite, or increase weight.
- Skill Signals: qualifying reusable workflow evidence may create, rewrite, or increase weight only when it passes the Skill Signal rules above.
- If the user explicitly asks to remember or reuse a Memory Signal or Skill Signal in future sessions, preserve the requested scope and set its weight to `[10]`.
- Count evidence events conservatively. Repeated task steps, command sequences, or feature-local instructions do not increase weight.
- A new signal starts with weight equal to its current-batch evidence count, capped at `[3]`, unless the explicit-remember rule applies.
- An existing signal gains `+1` per current-batch evidence event, capped at `+3` per batch, unless the explicit-remember rule applies.
- Do not invent historical counts; use existing weight plus current-batch evidence.
```

Extractor input labels should become:

```diff
- Prompt (signal evidence):
+ Prompt (memory signal evidence):

- Response (not signal evidence):
+ Response (workflow context, not memory signal evidence):
```

## Extractor Patch Semantics

The extractor may output any changed lightweight section:

```md
## Memory Signals
- [10] ...

## Skill Signals
- [1] `signal-noise-triage`: ...

## Open Questions
- [1] ...
```

Patch rules:

- Omitted signal section means unchanged.
- Empty signal section clears that category.
- If a lightweight signal section is present, it is the complete updated list
  for that category.
- `## Skill Details` contains only changed or new details.
- A changed detail replaces `skillDetails[skillName]`.
- A detail entry with an empty body removes `skillDetails[skillName]`.
- After applying a patch, delete any `skillDetails` entry whose skill name is no
  longer present in `skillSignals`.

Skill Detail patch format:

```md
## Skill Details
### `signal-noise-triage`
# signal-noise-triage

## When to Use
...

## Procedure
...

## Pitfalls
...

## Verification
...
```

The parser should validate that every changed Skill Detail heading uses a valid
skill name. Final snapshot validation should require every `skillDetails` key to
have a matching Skill Signal card.

## Project Dreaming Design

Project dreams render the same categories:

```md
# Project Dream: <project>

## Memory Signals

## Skill Signals

## Open Questions

## Skill Details
```

The project dream row still stores a single `content` Markdown document. Session
snapshot skill details are maps; project dream skill details are rendered inside
the dream document.

Dreaming input should be lightweight by default:

- Parent dream view without `## Skill Details`.
- Incremental snapshot `memorySignals`, `skillSignals`, and `openQuestions`.
- No raw session ids in the prompt.

The dreamer gets an internal LLM tool:

```ts
get_skill({ skillName })
```

This is not an MCP tool. It reads from:

- the parent project dream's `## Skill Details`, and
- the selected incremental session snapshots' `skillDetails[skillName]`.

Dreamer tool rules:

```md
Tool use
- Use `get_skill({"skillName":"..."})` only for Skill Signals.
- Call `get_skill` before preserving, merging, rewriting, or dropping a Skill Signal when the card alone is not enough to safely judge the reusable workflow.
- Do not call `get_skill` for Memory Signals or Open Questions.
- Call `get_skill` at most once per skill name per merge.
```

Dreamer `get_skill` result shape:

```md
# Skill Detail: <skillName>

## Parent Project Detail
...

## Incremental Session Details
### Source 1
...
### Source 2
...
```

Dreamer merge rules:

```md
Merge rules
- Preserve the intended meaning of source signals, including scope and constraints. Do not broaden it beyond what source signals explicitly support.
- Merge similar Memory Signals and Open Questions only for their shared meaning and scope; use the latest source-supported wording and add weights only for that shared signal.
- Merge Skill Signals by skill name and reusable workflow meaning; use loaded Skill Details to merge reusable procedure, pitfalls, and verification.
- Treat `[10]` source signals as explicit user-pinned signals; preserve them unless newer source signals explicitly change, narrow, reject, or supersede them.
- If newer source signals change, narrow, or reject an earlier signal, keep the newer signal and do not carry forward contradicted earlier weight.
- Drop task-local, feature-specific, PR-specific, CI/result-specific, command/checklist, prompt/spec draft, and implementation-plan content instead of rewriting it into project-level signals.
- Write natural-language output signals in the primary language already used by the source signals; preserve identifiers exactly.
- Do not invent facts, user preferences, decisions, workflows, or open questions.
```

Dreamer output rules:

```md
Output format
- Output exactly one Markdown document.
- Start with `# Project Dream: {{project}}`.
- Include `## Memory Signals`, `## Skill Signals`, `## Open Questions`, and `## Skill Details` in that order.
- Each top-level signal bullet must start with a weight marker like `- [4]`.
- Every Skill Signal must use a valid skill name in backticks.
- Every `## Skill Details` entry must start with `### `skill-name`` and must have a matching Skill Signal.
```

## Server API Scope

Server-side `GET /api/v1/dreaming/project/signals` should use the new category
names:

```ts
{
  memorySignals: string[];
  skillSignals: string[];
  openQuestions: string[];
}
```

No external project skill API is added in this round. No MCP tools are added in
this round. A later MCP/API follow-up can expose project-level `get_skill` once
the storage and dream merge semantics have settled.

## Implementation Boundaries

- Keep `mcp` thin and do not add MCP behavior in this round.
- Keep business logic in `server`.
- The Rust `format` crate owns persisted table fields and Arrow/Lance
  conversion.
- TypeScript snapshot parsing owns Markdown-to-state patch semantics.
- Project dream content parsing owns project-level `Skill Details` extraction.

## Test Plan

Native and storage tests:

- `session_snapshot` schema includes `memory_signals`, `skill_signals`,
  `open_questions`, and `skill_details`, and no longer includes `signals`.
- Roundtrip insert/get/list/delta preserves all four new fields.
- `skill_details` JSON map defaults to `{}`.

Snapshot parser and renderer tests:

- Default extractor snapshot view hides Skill Details.
- Full snapshot rendering can include Skill Details.
- Omitted signal sections preserve existing state.
- Empty signal sections clear only their category.
- `## Skill Details` patch replaces only included details.
- Removing a Skill Signal deletes its stale detail.
- Invalid skill names are rejected.
- Details without matching Skill Signals are rejected after patch application.

Extractor tests:

- Prompt includes split Memory Signals, Skill Signals, and Open Questions rules.
- Prompt includes explicit remember/reuse `[10]` rule.
- Prompt removes old `Guidance`/`Skills` section language.
- Extractor tool loop exposes both `get_extraction` and `get_skill`.
- `get_skill` returns hidden current snapshot detail.
- Renderer labels use `Prompt (memory signal evidence)` and
  `Response (workflow context, not memory signal evidence)`.

Dreamer tests:

- Prompt input omits Skill Details until `get_skill` is called.
- Dreamer tool loop exposes internal `get_skill`.
- `get_skill` returns parent and incremental details for the requested skill
  name.
- Dreamer validates the new project dream headings.
- Dreamer preserves `[10]` pinned signals unless explicitly superseded.
- Project dream signal parser ignores `## Skill Details` when returning top
  signals.

Server API tests:

- `/api/v1/dreaming/project/signals` returns `memorySignals`, `skillSignals`,
  and `openQuestions`.
- Existing project dream creation still skips LLM work when there are no
  changed snapshot rows with any signal data.

Suggested verification commands:

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

## Reset and Validation

Because this replaces the persisted `session_snapshot` shape, reset the active
dataset after implementation:

- Stop the Muninn server.
- Clear `/home/majin.nathan/.muninn/main` and runtime checkpoint/cache.
- Keep `~/.muninn/muninn.json` and original Codex session files.
- Restart the server.
- Reimport known noisy Muninn sessions.
- Run finalize/extraction.
- Run project dreaming.
- Inspect the full project dream:
  - top signals are lightweight;
  - skill details appear only under `## Skill Details`;
  - explicit remember/reuse signals are `[10]`;
  - prior response-only, task-local, English drift, prompt/spec draft, and
    compressed-task-step noise does not reappear.
