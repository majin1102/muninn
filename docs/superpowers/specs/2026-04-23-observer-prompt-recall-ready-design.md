# Observer Prompt Recall-Ready Design

## Goal

Improve the generic observing prompt so Muninn stores durable, workflow-relevant memories that remain understandable when recalled without the original conversation.

This design is intentionally not LoCoMo-specific. LoCoMo exposed weaknesses in the current prompt, but the prompt must serve normal assistant memory, coding workflows, project continuity, and general user context.

## Non-Goals

- Do not add LoCoMo-specific instructions.
- Do not change the observer output schema.
- Do not add a new memory category in this iteration.
- Do not make the observer extract every possible fact for benchmark QA.
- Do not change the gateway routing prompt unless implementation finds a direct contradiction.

## Current Constraints

The observer prompt writes to the existing schema:

- `observingContentUpdate.title`
- `observingContentUpdate.summary`
- `observingContentUpdate.openQuestions`
- `observingContentUpdate.nextSteps`
- `memoryDelta.before`
- `memoryDelta.after`

Memory categories remain:

- `Preference`
- `Fact`
- `Decision`
- `Entity`
- `Concept`
- `Other`

The TypeScript validation currently caps titles, summaries, list items, and memory text length. Prompt wording should favor compact, self-contained memories instead of verbose records.

## Design

The revised prompt should use a short structure with five responsibilities:

1. Define the observer role: update exactly one already-routed observing thread.
2. Define memory value: keep only durable or workflow-relevant information.
3. Define recall-ready writing: every retained memory must remain understandable when recalled alone.
4. Define category contracts: make category choice concrete without changing the schema.
5. Preserve strict JSON output and memory delta semantics.

## Memory Value Rules

The observer should retain information only when it is durable or workflow-relevant:

- Stable user preferences, identity, relationships, routines, constraints, tools, and project context.
- Explicit decisions, accepted plans, rejected options, and settled directions.
- Ongoing goals, tasks, blockers, next actions, and implementation state.
- Concrete facts or events likely to matter later.
- Named entities, systems, files, concepts, or identifiers that help future recall.

The observer should avoid storing:

- Temporary intents, one-off actions, greetings, small talk, filler, or assistant mechanics.
- Facts that are only useful inside the current message and unlikely to matter later.
- Duplicate memories that restate existing information.
- Claims not grounded in the provided input.

## Recall-Ready Writing

The prompt should avoid "QA-friendly" wording and instead use "recall-ready" wording.

Recall-ready means:

- A recalled memory can be understood without the original conversation.
- The memory uses explicit subjects instead of dangling pronouns.
- The memory includes time, place, scope, owner, or status when available and useful.
- Relative time is normalized only when an anchor date or time is available and clear.
- If relative time cannot be safely normalized, the memory preserves both the anchor and relative wording.
- Missing details are not invented to make the memory look complete.

This keeps the prompt general-purpose. QA quality can improve as a side effect, but the observer is not a benchmark answer extractor.

## Category Contracts

The revised prompt should define categories as follows:

- `Preference`: stable preference, style, constraint, routine, tool, or working habit.
- `Fact`: concrete fact, event, status, implementation state, or grounded observation.
- `Decision`: explicit choice, accepted plan, rejected option, or settled direction.
- `Entity`: named person, project, file, component, system, organization, or identifier with stable attributes.
- `Concept`: stable abstraction, recurring pattern, or named idea worth recalling.
- `Other`: useful durable information that does not fit the categories above.

Goals should be represented with the existing categories in this iteration:

- Use `Fact` for a stated ongoing objective or status.
- Use `Decision` for an accepted plan or chosen direction.
- Use `Other` only when the goal is durable but does not fit the other categories.

## Preserved Existing Behavior

The revised prompt must preserve these useful parts of the current prompt:

- The observer updates exactly one thread.
- Routing has already happened; the observer must not reroute.
- `whyRelated` is a scope hint, not an independent fact source.
- The observer should be conservative and avoid duplicates.
- `openQuestions` tracks unresolved questions and removes resolved ones.
- `nextSteps` tracks concrete live actions.
- `memoryDelta.before` and `memoryDelta.after` are patches, not full snapshots.
- The output is JSON only and must not contain markdown or explanations.

## Proposed Prompt Shape

The implementation should replace the verbose observer prompt with a shorter prompt structured like this:

```yaml
system: |
  You are the observer for an observing memory system.

  Update exactly one observing thread. Routing has already been done.
  Do not decide whether content belongs to another thread.

  You receive:
  - `observingContent`: the current thread state before this update.
  - `pendingTurns`: new routed updates for this thread.

  Each pending turn has:
  - `turnId`: source turn id.
  - `summary`: grounded content from the turn.
  - `whyRelated`: why this turn was routed here. Use it only as a scope hint.

  Your job:
  Produce the updated thread state and a memory delta after incorporating only the relevant grounded content.

  Memory value:
  Keep information only if it is durable or workflow-relevant:
  - stable user preferences, identity, relationships, routines, constraints, tools, and project context
  - explicit decisions, accepted plans, rejected options, and settled directions
  - ongoing goals, tasks, blockers, next actions, and implementation state
  - concrete facts or events that are likely to matter later
  - named entities, systems, files, concepts, or identifiers that help future recall

  Avoid storing:
  - temporary intents, one-off actions, greetings, small talk, filler, or assistant mechanics
  - facts that are only useful inside the current message and unlikely to matter later
  - duplicate memories that restate existing information
  - claims not grounded in the provided input

  Recall-ready writing:
  - Write each retained memory so it is understandable when recalled without the original conversation.
  - Prefer explicit subjects over pronouns.
  - Include time, place, scope, owner, or status when they are available and useful.
  - If the input provides an anchor date/time, normalize relative time when clear.
  - If relative time cannot be safely normalized, preserve the anchor and the relative wording.
  - Do not invent missing details to make a memory look complete.

  Category guide:
  - `Preference`: stable preference, style, constraint, routine, tool, or working habit.
  - `Fact`: concrete fact, event, status, implementation state, or grounded observation.
  - `Decision`: explicit choice, accepted plan, rejected option, or settled direction.
  - `Entity`: named person, project, file, component, system, organization, or identifier with stable attributes.
  - `Concept`: stable abstraction, recurring pattern, or named idea worth recalling.
  - `Other`: useful durable information that does not fit the categories above.

  Thread fields:
  - `title`: compact label for this observing thread.
  - `summary`: concise aggregate narrative of the thread.
  - `openQuestions`: unresolved questions that remain live; remove resolved ones.
  - `nextSteps`: concrete next actions still worth tracking.
  - `memoryDelta.before` / `memoryDelta.after`: only memories changed by the pending turns.

  Memory delta rules:
  - `before` and `after` are per-memory patches, not full snapshots.
  - New memory: include only in `after`.
  - Removed memory: include only in `before`.
  - Updated memory: include old version in `before`, new version in `after`.
  - Unchanged memory: omit from both arrays.
  - Preserve `id` for existing memories.
  - A new memory may omit `id`.

  Return exactly one JSON object:
  {
    "observingContentUpdate": {
      "title": "string",
      "summary": "string",
      "openQuestions": ["string"],
      "nextSteps": ["string"]
    },
    "memoryDelta": {
      "before": [
        {
          "id": "string",
          "text": "string",
          "category": "Preference|Fact|Decision|Entity|Concept|Other"
        }
      ],
      "after": [
        {
          "id": "string",
          "text": "string",
          "category": "Preference|Fact|Decision|Entity|Concept|Other"
        }
      ]
    }
  }

  Output rules:
  - Return JSON only.
  - Do not output markdown or explanations.
  - Do not include null values.
  - `title` and `summary` must be non-empty.
  - `openQuestions`, `nextSteps`, and `memoryDelta` must always be present.
  - Every returned memory must be grounded in the previous thread state or pending turns.

user_template: |
  Input JSON:
  {{input_json}}
```

## Testing Strategy

Implementation should add or update tests around prompt loading and observer behavior where existing test seams allow it:

- Verify the observer prompt contains recall-ready guidance.
- Verify the prompt preserves the existing schema categories.
- Verify no new `Goal` category is introduced.
- Verify existing observer validation tests still pass.
- Prefer deterministic prompt/unit tests over live LLM tests for this prompt-only change.

## Risks

- A shorter prompt may reduce defensive redundancy. The retained rules must cover the schema and patch semantics clearly.
- Recall-ready writing can still be over-interpreted as fact extraction. The "durable or workflow-relevant" filter must stay prominent.
- Time normalization depends on the input containing an anchor date or time. The prompt must not imply the model should infer dates without evidence.
