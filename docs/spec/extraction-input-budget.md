# Extraction Input Budget Spec

## Goal

Reduce Muninn extraction token cost and latency by bounding what enters a single extraction LLM call, without losing the user-prompt evidence needed for Memory Signals and Skill Signals.

This spec focuses on extraction input shaping and LLM request sizing. It does not change storage schema, signal categories, project dreaming, or provider selection.

## Current Behavior

Each extraction call renders the current batch as turns with:

- `Prompt (memory signal evidence)`
- `Response (workflow context, not memory signal evidence)`

The extraction input does not directly include raw tool events. Tool calls and tool outputs are stored on turn events, but extraction currently receives only the turn prompt and response fields. Tool details enter extraction only when the assistant response mentions them.

`maxEpochTurns` limits the number of turns per LLM call, but it does not limit the total text size of those turns. A 32-turn batch can still be large when responses contain long plans, specs, code blocks, issue text, or review/debug summaries.

The extractor does not currently provide a `get_turn` tool. If the rendered prompt/response preview omits necessary details, the model has no bounded way to ask for the full turn content.

## Trace Baseline

Observed from current `extractor-trace.jsonl` sampling:

```text
All sampled extraction calls:
prompt chars:        243,041
response chars:    1,356,975
parent memory chars: 303,939
approx total chars: 1,903,955

Recent 20 extraction calls:
prompt chars:         61,924
response chars:      467,244
parent memory chars:  51,798
approx total chars:  580,966
```

Response text is the dominant cost driver, especially assistant-generated plans and draft/spec content.

Batch size alone is not a cost fix. Reducing 32 turns to 8 or 16 lowers peak request size and failure risk, but total token cost may stay similar or increase because the static prompt and parent snapshot are repeated across more calls.

## Target Outcome

Target:

```text
response preview + content compression + batch/snapshot budgets:
- response rendered/original ratio: <=70% of current baseline
- plan-heavy response rendered/original ratio: 35%-50% of current baseline
- current batch rendered chars: capped by maxInputChars except explicit single-turn oversize
- snapshot rendered chars: capped by snapshotInputChars except explicit protected-context oversize
```

These percentages are targets for rendered response text, not guaranteed full-prompt size or provider billing reductions. Snapshot budget, system prompt size, provider tokenization, cached-input pricing, retries, and output tokens can shift final cost.

## Design Principles

- User prompts remain the primary evidence for Memory Signals and Skill Signals.
- Assistant responses are workflow context, not memory signal evidence.
- Do not feed raw tool input/output into the main extraction prompt.
- Assistant responses often carry conclusions, current state, and tradeoffs; keep bounded response context instead of treating responses as disposable.
- Tool events are evidence and provenance, not the primary knowledge input for extraction.
- Prefer bounded previews plus stable turn references over full assistant responses.
- Preserve enough recent assistant response context to understand what the user is approving, correcting, or rejecting.
- Make every omission measurable in trace logs.

## Response Budgeting

Apply response budgeting during extraction input rendering, before sending the request to the LLM.

Recommended config and defaults:

```json
{
  "extractor": {
    "minEpochTurns": 8,
    "maxEpochTurns": 32,
    "maxInputChars": 24576,
    "snapshotInputChars": 16384,
    "previewChars": 800
  }
}
```

Default values:

- `minEpochTurns`: `8`
- `maxEpochTurns`: `32`
- `maxInputChars`: `24576`
- `snapshotInputChars`: `16384`
- `previewChars`: `800`

Validation:

- `minEpochTurns` and `maxEpochTurns` must be positive integers.
- `maxEpochTurns` must be greater than or equal to `minEpochTurns`.
- `maxInputChars`, `snapshotInputChars`, and `previewChars` must be positive integers.
- `previewChars` must be smaller than `maxInputChars`.
- `snapshotInputChars` is independent from `maxInputChars`; it limits current snapshot rendering, not current batch rendering.

Character-count units:

- `Chars` means JavaScript string length, measured in UTF-16 code units after rendering markdown.
- Most Chinese characters count as 1 char.
- English is not word-based: `project` counts as 7 chars, and spaces/punctuation count too.
- Some emoji or non-BMP symbols may count as 2 chars.
- These budgets are deterministic rendering limits, not exact model token limits.

`minEpochTurns` controls when live ingest seals an epoch. It is not a promise that every LLM request contains at least that many turns.

`maxEpochTurns` remains the maximum number of turns that can enter one extraction request.

`maxInputChars` is the rendered `## Current Batch Turns` markdown ceiling, not the full LLM request ceiling. It does not include the system prompt, retry wrapper text, or rendered current snapshot. During import, finalize, bootstrap/replay, and live extraction, build the current batch by adding turns in order until adding the next rendered turn would exceed `maxInputChars` or `maxEpochTurns`. The resulting request may contain fewer than `maxEpochTurns` turns. It may also contain fewer than `minEpochTurns` turns when processing already-sealed or finalized backlog. Turns deferred by `maxInputChars` or `maxEpochTurns` remain pending and must be extracted in later requests. Always include at least one turn so extraction cannot stall; if one rendered turn still exceeds `maxInputChars`, process that turn alone and record the oversize condition in trace logs.

`snapshotInputChars` is the rendered `## Current Snapshot` markdown budget. Default it to `16384`. Render the current snapshot independently from the new batch budget:

- Build a protected snapshot block from the current title, session summary, Memory Signals, Skill Signals, and the most recent 16 extraction summaries.
- If the full snapshot fits within `snapshotInputChars`, render the full snapshot.
- If the full snapshot exceeds `snapshotInputChars` but the protected snapshot block fits, render the protected block first, then use remaining budget for additional newest extraction detail that fits.
- If the protected snapshot block itself exceeds `snapshotInputChars`, render the protected block anyway and record `snapshot-protected-oversize` in trace logs.
- Do not let snapshot trimming remove user-prompt evidence from the current batch; current batch turns remain governed by `maxInputChars`.

Do not use separate "last turn response" or "batch response" caps. The final turn in a batch is not semantically special enough to justify a larger response budget, and a batch response cap is less direct than a full rendered input cap.

`previewChars` applies to each assistant response and Codex `<proposed_plan>` prompt block. Use a head/tail preview so the extractor sees both the opening context and final conclusion:

```text
previewChars = 800
head = 480 chars
tail = 320 chars
```

If the response or Codex proposed-plan block is no longer than `previewChars`, render the full content.

When a response is truncated, include a compact marker:

```text
[response middle omitted; omittedChars=<N>; source turn available with get_turn turnId=<turn_row_id>]
```

The marker must include enough identity for the extractor's `get_turn` tool to retrieve the omitted content, but it must not inline the omitted content.

## Extraction Output Shape

Extraction output should stay compact because source turns remain available through citations and `get_turn`.

- `### Summary` and `### Content` together form the extraction's semantic index for future recall and later extraction updates. They summarize and distill the core content of the source turns; they are not a transcript replacement.
- The goal of `### Summary` and `### Content` is semantic extraction and indexing, not maximizing content volume; include extracted source-turn content when it helps future retrieval, and split by extraction title when the semantic index would exceed budget.
- Include core knowledge, durable conclusions, current state, decisions, constraints, root causes, blockers, unresolved items, required confirmations, and exact identifiers when they help future retrieval.
- Use `### Summary` for the compact recall capsule.
- Each `### Summary` is usually 32-96 tokens, with a hard maximum of 128 tokens.
- Use `### Content` only for supporting details that would make the summary too dense: concise evidence pointers, resolution notes, constraints, or why and when future agents should open the source turns.
- Include status and resolution criteria for unresolved items when useful for future recall.
- Use citations to indicate source turns that should be opened for raw details, especially for long plans, specs, logs, diffs, command output, or assistant responses.
- Do not copy full prompts, plans, specs, logs, diffs, command output, or assistant responses into `### Summary` or `### Content`.
- `### Summary` and `### Content` share a maximum 800-token budget across all changed extraction units in one snapshot patch; this is an upper bound, not a target.

## Content-Type Compression

Implement targeted compression together with response previews, `maxInputChars`, `snapshotInputChars`, `get_turn`, and trace logging. Content-type compression applies to assistant responses before the current batch enters the LLM request. Prompt-side compression applies only to Codex `<proposed_plan>` blocks described in Prompt Handling.

For assistant responses, apply content-type block compression first. If the response is still longer than `previewChars` after block compression, apply the normal response head/tail preview to the compressed response. Trace each operation in order; each per-turn record's rendered char count is the response length after that operation.

### Proposed Plans

Responses starting with or dominated by `<proposed_plan>` should not enter extraction in full.

Detect a proposed-plan response when the trimmed assistant response starts with `<proposed_plan>` or contains a complete `<proposed_plan>...</proposed_plan>` block whose inner content is more than half of the response.

Do not semantically summarize the plan in the renderer. Apply deterministic head/tail preview to the detected proposed-plan response or block, preserve surrounding response text, and record reason `proposed-plan`.

### Drafts And Specs

Assistant-generated prompt/spec/doc drafts are task artifacts unless the user later confirms a reusable future-agent instruction from them.

Keep only a preview and turn reference. Do not treat the draft body as signal evidence.

Detect draft/spec responses only with explicit markers or bounded blocks:

- a response starts with `PLEASE IMPLEMENT THIS PLAN`
- a fenced block is labeled or introduced as prompt, spec, doc, test plan, or review draft
- a markdown section is explicitly introduced as a prompt/spec/doc/test-plan draft and the section exceeds `previewChars`; the section spans from that heading through the next heading of the same or higher level, or the end of the response

Do not compress ordinary assistant prose just because it mentions plans, specs, prompts, docs, tests, or reviews. When a detected draft/spec block exceeds `previewChars`, fold that block with deterministic head/tail preview and reason `draft-or-spec`.

### Code, Logs, Diffs, And Command Output

Large code fences, diffs, logs, test output, and command output should be folded by default.

Detect foldable blocks deterministically:

- fenced code blocks longer than `previewChars`
- fenced diff blocks, or fenced blocks whose content starts with `diff --git`, `@@`, or repeated diff lines
- fenced text/bash/sh/output/log blocks that contain command output, test output, stack traces, or logs

Keep:

- language or output kind
- first useful heading or error line
- compact status if obvious
- turn reference

Drop:

- full diff bodies
- full test logs
- full command output
- long code blocks already present in files or artifacts

Do not compress unfenced ordinary assistant prose in this implementation. When a detected fenced block exceeds `previewChars`, fold that block with a compact marker and preserve surrounding response text. Use reason `code-fence` for long code fences and `diff-log-or-command-output` for diffs, logs, test output, and command output.

When multiple detectors match the same response span, use the first matching reason in this order: `proposed-plan`, `draft-or-spec`, `diff-log-or-command-output`, `code-fence`.

Use this marker inside folded response blocks:

```text
[response block middle omitted; reason=<reason>; omittedChars=<N>; source turn available with get_turn turnId=<turn_row_id>]
```

## Prompt Handling

User-authored prompt text has higher preservation priority than assistant responses because prompts are signal evidence.

However, Codex proposed-plan blocks inside prompts are task artifacts and can dominate input. Handle these blocks with the same head/tail preview shape and `previewChars` budget as response truncation.

For prompt-side truncation, only recognize Codex proposed-plan blocks:

```text
<proposed_plan>
...
</proposed_plan>
```

Do not match generic words like "plan", markdown plan headings, `PLEASE IMPLEMENT THIS PLAN`, pasted specs, issues, reviews, diffs, or logs in user prompts. Prompt-side truncation should stay narrow and Codex-specific.

Scan the rendered prompt text for complete `<proposed_plan>...</proposed_plan>` blocks anywhere in the prompt, not only at the beginning. This covers Codex transcript and approval-review prompts where a prior plan appears inside a transcript line such as `[N] assistant: <proposed_plan>...`.

Use a narrow global non-greedy regex for detection:

```ts
const PROPOSED_PLAN_BLOCK_RE = /<proposed_plan>([\s\S]*?)<\/proposed_plan>/g;
```

- Match only exact `<proposed_plan>` and `</proposed_plan>` tags.
- Use `g` so multiple plan blocks in one prompt are handled independently.
- Use non-greedy `[\s\S]*?` so adjacent plan blocks are not collapsed into one match.
- Do not add `\s*` around the capture; preserve original whitespace for deterministic character accounting.
- Truncate only the captured inner body. Keep all text before the opening tag, the opening tag itself, the closing tag, and all text after the closing tag unchanged.

If a prompt contains a complete `<proposed_plan>...</proposed_plan>` block and that block exceeds `previewChars`, truncate only that block's inner content with the same head/tail split as responses:

```text
previewChars = 800
head = 480 chars
tail = 320 chars
```

Keep the user's text before and after the block unchanged. Preserve the opening and closing `<proposed_plan>` tags in the rendered prompt so the extractor can see that the omitted content is a plan artifact.

When a prompt plan is truncated, include a compact marker inside the block:

```text
[prompt plan middle omitted; omittedChars=<N>; source turn available with get_turn turnId=<turn_row_id>]
```

Truncated Codex proposed-plan content is task artifact context, not signal evidence by itself. The user's surrounding approval, rejection, correction, or explicit remember/reuse instruction remains signal evidence.

## Tool Events

Do not add raw tool input/output to extraction input.

Tool events are valuable as provenance and verification material:

- exact errors, paths, command outputs, diffs, and test results
- evidence for whether an assistant conclusion was grounded
- historical state that may no longer be reproducible after files or remote systems change

They are usually not the best primary memory input. Project files can often be re-read, and raw tool output is noisy. Assistant responses more often carry the distilled conclusion, current state, decision, or tradeoff that should become an extraction.

If Muninn later needs tool-aware memory:

- store tool events as separate observations
- compress them asynchronously
- feed extraction only observation title/summary/reference
- optionally provide a separate evidence lookup tool, but do not make raw tool output part of the default extraction prompt

This follows the same direction as hook/worker memory systems: capture more raw material in storage, but expose only compact summaries to extraction and recall paths.

## `get_turn` Tool

Add a `get_turn` tool in this implementation stage so the model can recover omitted turn content only when the rendered preview is insufficient.

The tool contract accepts only the persisted `turn` table row id:

```json
{ "turnId": "123" }
```

Use the turn row id value directly, without a `turn:` prefix or any other namespacing. Encode the id as a decimal string in JSON so large row ids do not lose precision in JavaScript.

Do not introduce a separate `memoryId`, `part`, or other selector. A successful call returns one bounded readable view of that turn:

- rendered user prompt
- rendered assistant response

Do not attach raw tool-call arguments, raw tool outputs, or extra tool IO through `get_turn`; `prompt` and `response` come only from the stored turn prompt and assistant response fields. `get_turn` must render from those stored fields before extraction input preview/compression is applied. It should apply only the `get_turn` returned-character budget, not reuse the already-truncated current-batch preview.

A successful tool result uses this shape:

```json
{
  "turnId": "123",
  "prompt": "...",
  "response": "..."
}
```

Omission counts belong in extraction trace records, not in the tool result returned to the model.

Update `server/prompts/extractor.yaml` when implementing this tool:

- List `get_turn` in the extractor `Inputs` section as the tool for reading omitted current-batch turn content.
- Explain in `Tool use` that `get_turn` should be called only when the rendered prompt/response preview is insufficient to safely create or update the snapshot.
- Show the tool call with the raw persisted turn row id, for example `get_turn({"turnId":"123"})`.
- Keep citation syntax separate: extraction citations still use `@[turn:<turnId>]`, but `get_turn.turnId` must be the raw row id value, such as `"123"`, not `"turn:123"`.

The executor must validate each call at runtime:

- only allow turn ids from the current extraction request
- return a tool error for unknown turn ids or turn ids outside the current extraction scope
- enforce per-call and per-extraction returned-character budgets
- trace every call, returned prompt/response chars, and omitted chars
- keep assistant responses as workflow context, not memory signal evidence, even when returned by `get_turn`

Default tool budgets:

- at most 3 `get_turn` calls per extraction attempt
- at most 8000 returned characters per `get_turn` call
- at most 16000 returned characters total per extraction attempt

If the requested turn view exceeds the remaining budget, keep the prompt first because it is signal evidence, then use remaining budget for the response. If the prompt alone exceeds the per-call budget, render a head/tail preview of the prompt up to the per-call budget and return an empty response string. Trace the full response length as omitted response chars. Otherwise, use remaining budget for a response head/tail preview when needed. Put omission markers inside the returned `prompt` or `response` string, not as separate tool-result fields:

```text
[prompt middle omitted; omittedChars=<N>; full content remains stored in turn table]
[response middle omitted; omittedChars=<N>; full content remains stored in turn table]
```

If the model exceeds the call count or total returned-character budget, return a tool error and trace the rejected call. Budget exhaustion should not throw from the tool handler or fail the extraction attempt by itself; the model should continue from the visible preview and any successful tool results.

Encourage `get_turn` only when the model cannot safely complete extraction from the rendered input:

- the user prompt refers to omitted response content, such as "上面", "刚才", "这个方案", or "第二版"
- the user prompt approves, rejects, corrects, compares, or asks about an omitted Codex `<proposed_plan>` block, and the visible preview is insufficient
- deciding whether to update an existing extraction or create a new one requires omitted details
- cross-turn merge, conflict resolution, or correction requires exact wording from omitted content
- exact identifiers, API/schema names, file paths, command names, or error text are needed and not visible in the preview

Do not call `get_turn` just to read full assistant plans, drafts, logs, or command output when the visible preview already supports the extraction decision.

## Trace Requirements

Every extraction trace should make budgeting auditable.

Add per-call fields:

```json
{
  "inputBudget": {
    "maxInputChars": 24576,
    "snapshotInputChars": 16384,
    "newBatchRenderedChars": 0,
    "snapshotRenderedChars": 0,
    "userPromptRenderedChars": 0,
    "candidateTurns": 0,
    "includedTurns": 0,
    "deferredTurns": 0,
    "stoppedBy": "max-input-chars",
    "snapshotStoppedBy": "snapshot-input-chars",
    "snapshotProtectedExtractionSummaries": 16,
    "promptCharsOriginal": 0,
    "promptCharsRendered": 0,
    "omittedPromptPlanChars": 0,
    "responseCharsOriginal": 0,
    "responseCharsRendered": 0,
    "omittedResponseCompressedChars": 0,
    "snapshotCharsOriginal": 0,
    "snapshotCharsRendered": 0,
    "omittedResponseChars": 0,
    "previewPolicy": {
      "previewChars": 800,
      "previewHeadChars": 480,
      "previewTailChars": 320
    }
  }
}
```

Add per-turn budgeting records when a response is truncated:

```json
{
  "turnId": "123",
  "responseCharsOriginal": 12000,
  "responseCharsRendered": 800,
  "previewHeadChars": 480,
  "previewTailChars": 320,
  "omittedResponseChars": 11200,
  "reason": "response-preview"
}
```

Add per-turn budgeting records when a Codex proposed-plan prompt block is truncated:

```json
{
  "turnId": "123",
  "promptPlanCharsOriginal": 12000,
  "promptPlanCharsRendered": 800,
  "previewHeadChars": 480,
  "previewTailChars": 320,
  "omittedPromptPlanChars": 11200,
  "reason": "prompt-proposed-plan-preview"
}
```

Add per-turn budgeting records when response content-type compression folds a block. Use the same shape for each compression reason: `proposed-plan`, `draft-or-spec`, `code-fence`, and `diff-log-or-command-output`. If one turn folds multiple blocks with the same reason, aggregate them into one record for that turn and reason.

```json
{
  "turnId": "123",
  "responseCharsOriginal": 12000,
  "responseCharsRendered": 2400,
  "omittedResponseCompressedChars": 9600,
  "reason": "draft-or-spec"
}
```

Allowed `reason` values:

- `response-preview`
- `prompt-proposed-plan-preview`
- `proposed-plan`
- `draft-or-spec`
- `code-fence`
- `diff-log-or-command-output`

Allowed `snapshotStoppedBy` values:

- `none`
- `snapshot-input-chars`
- `snapshot-protected-oversize`

Allowed `stoppedBy` values:

- `none`
- `max-input-chars`
- `max-epoch-turns`
- `single-turn-oversize`

Add per-call `get_turn` records when the tool is used:

```json
{
  "turnId": "123",
  "returnedPromptChars": 1200,
  "returnedResponseChars": 6800,
  "omittedPromptChars": 0,
  "omittedResponseChars": 1400,
  "reason": "cross-turn-conflict-resolution",
  "error": null
}
```

Rejected `get_turn` calls should also be traced:

```json
{
  "turnId": "999",
  "returnedPromptChars": 0,
  "returnedResponseChars": 0,
  "omittedPromptChars": 0,
  "omittedResponseChars": 0,
  "reason": "outside-current-request",
  "error": "turn is not in the current extraction request"
}
```

## Test Plan

Add focused tests before the clean-run validation:

- Config defaults and validation:
  - default `minEpochTurns=8`, `maxEpochTurns=32`, `maxInputChars=24576`, `snapshotInputChars=16384`, and `previewChars=800`
  - reject non-positive or non-integer budget values
  - reject `maxEpochTurns < minEpochTurns`
  - reject `previewChars >= maxInputChars`
- Current batch rendering:
  - assistant responses use head/tail previews when longer than `previewChars`
  - Codex `<proposed_plan>...</proposed_plan>` prompt blocks use the same head/tail preview
  - prompt block matching only recognizes exact Codex proposed-plan tags
  - content-type compression folds assistant-generated proposed plans, drafts/specs, large code blocks, diffs, logs, and command output
  - each content-type compression reason, `proposed-plan`, `draft-or-spec`, `code-fence`, and `diff-log-or-command-output`, has a per-turn trace record with original, rendered, and omitted response chars
  - when response compression still leaves a response over `previewChars`, the normal response preview runs after compression and emits a `response-preview` trace record
  - adding a turn that would exceed `maxInputChars` defers that turn for a later extraction request
  - a single oversized rendered turn is still processed alone and traced as oversize
- Snapshot rendering:
  - `snapshotInputChars` limits rendered current snapshot independently from current batch rendering
  - the protected snapshot block keeps title, session summary, Memory Signals, Skill Signals, and the most recent 16 extraction summaries
  - protected snapshot oversize is rendered and traced as `snapshot-protected-oversize`
- `get_turn` tool loop:
  - `server/prompts/extractor.yaml` lists `get_turn` in `Inputs` and `Tool use`
  - runtime tool specs include `get_turn` alongside `get_extraction` and `get_skill`
  - `get_turn({"turnId":"123"})` returns only `turnId`, `prompt`, and `response`
  - `get_turn` rejects ids outside the current extraction request
  - `get_turn` enforces per-call and per-attempt returned-character budgets
  - when a `get_turn` prompt alone exceeds the per-call budget, the prompt is head/tail previewed, response is an empty string, and omitted response chars are traced
  - accepted and rejected `get_turn` calls are traced with returned and omitted prompt/response chars

## Validation

Run the same imported sessions before and after the change and compare trace aggregates:

```text
response rendered / response original
max rendered current batch chars
max rendered snapshot chars
max rendered user prompt chars
retry count
invalid extraction count
extraction duration
number of Memory Signals
number of Skill Signals
get_turn call count and returned chars
manual review of top noisy signals
```

Acceptance criteria:

- Response rendering with preview and compression is no more than 70% of the current baseline, with plan-heavy sessions targeting 35%-50%.
- Current batch rendering respects `maxInputChars`, except explicit single-turn oversize trace records.
- Snapshot rendering respects `snapshotInputChars`, except explicit `snapshot-protected-oversize` trace records.
- Raw user prompt size is measured and reported. Rendered current batch input must still respect `maxInputChars`, except explicit single-turn oversize trace records.
- No raw tool input/output is added to extraction input.
- Response previews use head/tail rendering, not prefix-only rendering.
- `get_turn` is implemented in the extractor tool loop.
- `get_turn` calls are scoped to the current extraction request, budgeted, and visible in trace logs.
- Memory Signal and Skill Signal quality does not regress in a manual review of Muninn and Amoro sessions.
- Trace logs explain where input was removed and why.

## Non-Goals

- Do not change Lance/Rust storage schema.
- Do not change project dreaming schema.
- Do not add provider-specific cache assumptions.
- Do not rely on smaller batch size as the primary token reduction mechanism.
- Do not discard stored raw turns or tool events; only change what extraction renders.
