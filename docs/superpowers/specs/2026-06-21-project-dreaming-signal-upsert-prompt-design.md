# Project Dreaming Signal Upsert Prompt Design

## Summary

This spec isolates the prompt changes required by the project dreaming signal
upsert design.

The extractor stops outputting numeric signal weights such as `[3]`. It outputs
evidence labels using full persisted turn ids, such as `[turn:256 +1]`, instead.
Project dreaming stops
producing a single `# Project Dream: <project>` document and instead returns the
complete current project signal set with labels that drive deterministic service
upserts.

The LLM never invents ids, contribution values, timestamps, or storage state.
Prompt labels are merge instructions and evidence references only; the service
validates labels and writes rows.

## Scope

Prompt surfaces covered here:

- `server/prompts/extractor.yaml`
- `server/prompts/project-dreamer.yaml`
- Extractor examples in `extractor.yaml`
- Prompt-loader tests that assert prompt wording

Out of scope:

- Lance schema implementation
- upsert service implementation
- API, MCP, or Web rendering
- score calculation implementation
- migration and clean-run execution

## Shared Prompt Terms

Use these terms consistently where they appear in extractor and project dreamer
prompts:

- Existing project signal id: `[signal:<stable_row_id>]`
- Incremental evidence label: `[<turn_id> +<contribution>]`, where `<turn_id>`
  is the full persisted turn id, for example `turn:256`.
- Normal user-prompt evidence contribution: `+1`
- Explicit user request to remember or reuse in future sessions: `+10`

Prompt text must not describe `[signal:*]` as evidence. A `signal:*` label is an
existing row identity. Only full turn-id labels such as `turn:256 +1` are
evidence.

## Extractor Prompt Changes

### Replace `Signal weights`

Replace the current `Signal weights` section with:

```md
Signal evidence
- Signal bullets use evidence labels instead of weight markers:
  `- [<turn_id> +<contribution>, <turn_id> +<contribution>] <signal content>`.
- Use `+1` for ordinary supporting user prompts.
- Use `+10` when the user explicitly asks to remember or reuse the signal in future sessions.
- Use only full current-batch turn ids and evidence labels already present in the current snapshot.
- Add one evidence label for each distinct current-batch turn whose user prompt supports the retained signal.
- Do not invent turn ids or contribution values.
- Treat evidence labels as source support, not as part of the signal content.
- Merge similar signals using the latest prompt-supported wording and scope, and merge their supporting evidence labels.
- Do not duplicate the same turn id within one signal.
- If newer user-prompt evidence changes, narrows, or rejects an earlier signal, keep only labels that still support the retained signal.
```

### Adjust `Session signal sections`

Keep the existing section shape, but replace weight language with evidence
language:

```md
Session signal sections
- Use two signal sections in this order: `## Memory Signals`, `## Skill Signals`.
- IMPORTANT: Before recording a Memory Signal or Skill Signal, first verify whether the signal would still matter after the current task is completed or the current session ends; if not, do not record it as a signal.
- Use user prompts as evidence for Memory Signals and Skill Signals. Non-user materials are reference-only; a user prompt can turn referenced material into signal evidence only when it explicitly names or restates the specific signal.
- Approval-only prompts such as "yes", "ok", "continue", or "do that" are not reusable signal evidence unless they explicitly say to remember or reuse a future-session rule.
- Preserve the user's intended meaning, scope, and constraints. Do not broaden a signal beyond what the supporting prompt explicitly supports.
- Merge similar signals using the latest prompt-supported wording and scope, and merge their supporting evidence labels.
- If newer user-prompt evidence changes, narrows, or rejects an earlier signal, replace the earlier signal with the newer one and do not carry forward contradicted evidence labels.
- Write natural-language signals and Skill Details prose in the dominant language of the current batch's user instructions; ignore quoted, pasted, or drafted content for language choice; preserve identifiers exactly.
- Write signals as direct future-agent instructions, not meta descriptions about the user; avoid phrasing like "The user prefers concise replies" and write the guidance itself instead.
```

### Adjust `Memory Signals`

Keep the current definition and remove any wording that refers to numeric
weights. The section should stay:

```md
Memory Signals
- Memory Signals are AGENTS.md/MEMORY.md-style operating instructions for future agents: standing user preferences, direct corrections to agent behavior, edit/review style, recurring environment quirks, explicit remember requests, and narrow repo/module boundaries.
- Memory Signals are not task-bound rules or facts about the current artifact's behavior, output format, prompt behavior, schema/API/data model, tests, or review deliverables; keep them only when they are direct future-agent instructions, explicit remember/reuse requests, or narrow repo/module boundaries.
- If the user explicitly asks to remember or reuse an instruction or simple workflow in future sessions, record it as a Memory Signal with the requested scope and a `+10` evidence label unless it should become a Skill Signal.
- Keep each Memory Signal as one concise, context-independent top-level bullet.
```

### Adjust `Skill Signals`

Replace the signal bullet format line and keep the existing strict creation gate:

```md
Skill Signals
- Skill Signals are compact indexes for reusable workflow candidates that could later become a `SKILL.md`.
- Skill Signals should name class-level reusable workflows, not one-session task artifacts; avoid names based on PR numbers, error strings, feature codenames, or today's fix/debug task.
- Installed, invoked, or referenced agent skills are execution context, not Skill Signals; only record user-prompt changes to the reusable workflow itself.
- Keep reusable guidance as a Memory Signal when it fits in 1-3 concise sentences; do not duplicate the same guidance as both a Memory Signal and a Skill Signal.
- Create, update, or upgrade a Skill Signal only when user prompts indicate an intent to shape a reusable workflow, and the workflow needs at least 3 reusable steps.
- Do not create Skill Signals from task execution artifacts, assistant-devised plans, command history, or one-off task steps.
- Store details only for accepted Skill Signals under `## Skill Details`; assistant execution may help fill reusable details only after the Skill Signal is supported by user prompts.
- Each Skill Signal is one top-level bullet: `- [<turn_id> +<contribution>, ...] Skill name: one concise reusable workflow capability.`
- Put reusable steps and details under `## Skill Details`, not under the Skill Signal bullet.
- Write Skill names in the dominant language of the supporting user prompts; preserve identifiers exactly.
```

### Adjust `Signal budget`

Replace weight sorting with dynamic evidence sorting:

```md
Signal budget
- Each signal section has at most 10 top-level bullets.
- Sort top-level bullets with explicit `+10` evidence first, then retained evidence contribution sum, then current-batch supporting prompt count, then prior order.
- Over budget, drop signals from the bottom of that order.
- Each top-level signal is one concise, context-independent sentence, usually under 40 words.
- Skill Details are procedure detail space, not a transcript; keep reusable `When to Use`, `Procedure`, `Pitfalls`, and `Verification` sections concise.
```

### Adjust `Output format`

Replace output-format bullets that mention weight markers:

```md
Output format
- Return a Markdown document only; do not wrap the whole response in a code fence or add prose outside the document.
- Return a snapshot patch only: include only changed title, summary, signal sections, Skill Details, and changed/new extractions; omit unchanged sections and extractions.
- Include `# <Session Title>` only when the session title should change.
- Include `## Summary` only when the session summary should change.
- Include `## Memory Signals` only when Memory Signals change; omit when unchanged; an empty `## Memory Signals` clears existing Memory Signals.
- Include `## Skill Signals` only when Skill Signals change; omit when unchanged; an empty `## Skill Signals` clears existing Skill Signals.
- If `## Memory Signals` or `## Skill Signals` is included, it must contain the complete final bullet list for that section, not only changed bullets.
- Each Memory Signal bullet must start with evidence labels like `- [turn:256 +1]`.
- Each Skill Signal bullet must start with evidence labels like `- [turn:256 +1] Skill name: ...`.
- Signal evidence labels must use only full current batch turn ids or labels already present in the current snapshot.
- Include `## Skill Details` only when any Skill Detail changes or should be removed; omit unchanged Skill Details.
- In `## Skill Details`, each changed detail starts with `### Skill name`.
- Do not repeat the skill name as a heading inside the Skill Detail body.
- Inside each Skill Detail body, use `#### When to Use`, `#### Procedure`, `#### Pitfalls`, and `#### Verification` for reusable detail sections.
- An empty Skill Detail body removes that skill detail.
- Every changed Skill Detail must have a matching Skill Signal after the patch is applied.
- Include `## Extractions` only when any extraction changes or new extraction is created.
- Existing extraction updates must start with metadata containing the existing `sequence` number and `refs`.
- New extractions must start with metadata containing `refs`.
- Metadata refs must only include actual supporting turn ids from the current batch.
- Never output placeholder or copied example refs such as `turn:x`, `turn:y`, or an example turn id that is not in the current batch.
- Do not include old refs. Runtime will merge metadata refs with stored refs.
- Each extraction must include `### Title` and `### Summary`.
- `### Content` is optional.
- Separate multiple extraction blocks with a line containing exactly `----`.
```

### Extractor Example Output Shape

The extractor example should no longer show `[1]`, `[2]`, or other weight
markers in signal sections.

Use this signal style instead:

```md
## Memory Signals

- [turn:102 +1] Report export failures should be triaged by checking job logs before object storage permissions.

## Skill Signals
```

If the example includes an explicit remember request, show `+10`:

```md
## Memory Signals

- [turn:102 +10] Report export failures should be triaged by checking job logs before object storage permissions.
```

## Project Dreamer Prompt Changes

### Replace `Your job`

Replace the current dream-document framing:

```md
Your job
- Maintain one compact project-level dream document for future agents working in this project.
- Merge the parent dream with incremental project signals.
- Return a full Markdown project dream document, not a patch.
- Return Markdown only; do not wrap the response in a code fence or add prose outside the document.
```

with current-state signal framing:

```md
Your job
- Maintain the current project signal set for future agents working in this project.
- Merge existing project signals with incremental session signal evidence.
- Return a complete Markdown project signal set, not a patch.
- Return Markdown only; do not wrap the response in a code fence or add prose outside the document.
```

### Replace `Inputs`

Replace parent-dream inputs:

```md
Inputs
- Parent dream content without `## Skill Details`, if one exists.
- Incremental Memory Signals and Skill Signals selected for this merge.
- Skill Details are hidden from the default input.
- The `get_skill` tool for reading parent and incremental Skill Details by skill name.
```

with row/evidence inputs:

```md
Inputs
- Existing project signal rows, each labeled with `[signal:<stable_row_id>]`.
- Incremental session Memory Signals and Skill Signals, each labeled with one or more `[<turn_id> +<contribution>]` evidence labels.
- Skill Signal input includes the reusable workflow signal and any available reusable detail needed for merging.
- Existing project signal labels identify stored rows; incremental turn labels identify user-prompt evidence.
- Existing project signal support history is not shown to the LLM; service code preserves existing `support_turns` for retained and merged rows.
```

### Remove Project Dreamer Tool-Use Requirements

The project dreamer implementation should not require an LLM tool loop in this
design. The service should render enough signal content for the merge input.

Delete the current `Tool use` section from `project-dreamer.yaml` and remove
the project dreamer `get_skill` loop from the runtime path.

### Replace `Signal definition`

Use:

```md
Signal definition
- Existing `[signal:*]` labels are row identities, not evidence.
- Incremental full-turn-id labels are new evidence and must be included only when they still support the output signal.
```

### Replace `Merge rules`

Use:

```md
Merge rules
- Preserve source-supported meaning, scope, constraints, and signal type.
- Merge or update semantically related signals using incremental wording as the latest state; include incremental turn labels only when they support the final wording and scope.
- Do not broaden, invent, or reclassify signals.
- Avoid duplicating the same reusable guidance as both a Memory Signal and a Skill Signal.
- For Skill Signals, merge details when source Skill Signal content supports the same reusable workflow.
- Sources are ordered older to newer; later evidence can replace earlier overlapping content.
- Write direct future-agent instructions in the dominant language of retained source signals; preserve identifiers exactly.
- Do not invent facts, preferences, workflows, labels, ids, or contribution values.
```

### Replace `Signal types`

Use:

```md
Signal types
- Memory Signals are concise future-agent operating instructions.
- Skill Signals are reusable workflow entries with a skill name, short summary, and optional reusable details.
```

### Replace `Signal weights`

Project dreamer no longer outputs weights. Use label rules instead:

```md
Project signal labels
- Output labels drive deterministic storage upserts.
- Every output signal block must start with exactly one label list.
- Use only labels that appeared in the input.
- Copy labels exactly; do not rewrite ids or contribution values.
- `[signal:<stable_row_id>]` labels identify existing project rows.
- `[<turn_id> +<contribution>]` labels identify incremental evidence.
- Unknown labels are ignored by service validation and must not create evidence.
- If an output block includes one or more `[signal:*]` labels, the first `[signal:*]` is the survivor row.
- Additional `[signal:*]` labels in the same output block are merged into the survivor row and removed from current state.
- Turn evidence labels in the same output block are appended as supporting evidence for the survivor or inserted row.
- If an output block has only turn evidence labels, it creates a new project signal row.
- If an input `[signal:*]` label is omitted from the output, that existing project signal is removed from current state.
- Do not include labels inside saved signal content.
```

### Remove `Budget`

Delete the project dreamer `Budget` section. The dreamer should merge signals;
do not ask the LLM to omit existing signals solely to fit a budget.

### Replace `Output format`

Use:

```md
Output format
- Output exactly one Markdown document.
- Start with `# Project Signals`.
- After the title, output zero or more signal blocks.
- Every signal block starts with one label list line.
- Every saved signal content block starts with either `## Memory Signal` or `## Skill Signal`.
- Memory Signal content is one concise future-agent instruction after `## Memory Signal`.
- Skill Signal content starts with `## Skill Signal`, then `### <skill name>`, then the reusable workflow summary and optional `#### When to Use`, `#### Procedure`, `#### Pitfalls`, and `#### Verification` sections.
```

### Project Dreamer Output Example

Use this output style:

```md
# Project Signals

[signal:101, turn:300 +1]
## Memory Signal
Prefer focused, minimal fixes and tests when the requested change is narrow.

[signal:102, signal:119, turn:400 +10]
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

[turn:256 +1, turn:271 +1]
## Memory Signal
Prefer subtractive prompt and memory-rule changes before adding new rules.
```

Interpretation:

- `signal:101` survives and receives evidence `turn:300`.
- `signal:102` survives, `signal:119` is merged into it and removed, and
  `turn:400` becomes new support evidence.
- The last block inserts a new Memory Signal row.
- Any existing input `signal:*` not shown in the output is removed.

## Prompt Validation Expectations

Prompt-facing validators should reject or retry outputs when:

- Extractor signal bullets use old `[N]` weights.
- Extractor signal bullets contain invented turn ids.
- Extractor repeats the same turn id within one signal.
- Project dreamer output does not start with `# Project Signals`.
- Project dreamer output contains `# Project Dream:`.
- Project dreamer output contains `## Open Questions`.
- Project dreamer output uses old `[N]` weights.
- Project dreamer output has a signal with no valid labels left after unknown labels are ignored.
- Project dreamer output repeats the same survivor `[signal:*]` in multiple blocks.
- Project dreamer output has a block without `## Memory Signal` or `## Skill Signal`.
- Project dreamer output has a Skill Signal without a `### <skill name>` heading.

## Tests

Prompt-loader tests should assert:

- Extractor prompt contains `Signal evidence`.
- Extractor prompt contains `+1` for ordinary supporting user prompts.
- Extractor prompt contains `+10` for explicit remember/reuse requests.
- Extractor prompt contains `Add one evidence label for each distinct current-batch turn whose user prompt supports the retained signal`.
- Extractor prompt contains the post-task/session signal gate.
- Extractor prompt says task-bound rules or facts about current artifact behavior, prompt behavior, schema/API/data model, tests, or review deliverables are not Memory Signals.
- Extractor prompt says Skill Signals should name class-level reusable workflows and should not come from installed, invoked, or referenced agent skills.
- Extractor prompt contains `Each signal section has at most 10 top-level bullets`.
- Extractor prompt no longer contains `Signal weights`.
- Extractor examples no longer contain Memory/Skill signal bullets starting with `[1]`.
- Project dreamer prompt starts output with `# Project Signals`.
- Project dreamer prompt contains `[signal:<stable_row_id>]`.
- Project dreamer prompt contains `[<turn_id> +<contribution>]`.
- Project dreamer prompt has lightweight Memory Signal and Skill Signal definitions.
- Project dreamer prompt says to preserve signal type and avoid reclassifying signals.
- Project dreamer prompt does not contain project storage budget limits.
- Project dreamer prompt explains survivor-row semantics for the first `[signal:*]`.
- Project dreamer prompt explains omitted existing `[signal:*]` means remove current state.
- Project dreamer prompt no longer contains `# Project Dream: {{project}}`.
- Project dreamer prompt no longer contains old `[N]` weight-marker rules.
- Project dreamer prompt does not require `get_skill`.

## Review Notes

This prompt design intentionally makes the LLM responsible only for semantic
normalization and label-preserving merge choices. It does not ask the LLM to:

- calculate score
- calculate timestamps
- create stable ids
- decide final top-N ranking
- enforce budgets
- preserve historical deleted rows

Those responsibilities belong to deterministic service code.
