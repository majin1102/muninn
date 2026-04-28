# Observer-Owned Source References Design

## Summary

Muninn's observing pipeline should stop using gateway-generated summaries as the observer's fact input. The gateway should only decide which observing thread should inspect each source turn. The observer should read the raw source turn, extract only the parts relevant to the current thread, and produce both durable observations and thread-local source references.

This fixes cases where gateway summarization drops important source details before the observer can use them. The concrete failure this design addresses is a LoCoMo turn with a `DATE:` anchor and `last year`: the raw source supports normalizing the answer to `2022`, but the gateway summary removed the date anchor, so the observer stored only `last year`.

## Goals

- Preserve raw source facts, including `DATE:` anchors, speaker text, prompt, and response, until the observer stage.
- Keep gateway responsibilities limited to routing control.
- Let observer decide which parts of a routed turn are relevant to the current observing thread.
- Store source provenance with a thread-local explanation of relevance.
- Avoid storing gateway summaries or gateway reasons in observing snapshots.
- Keep semantic indexing focused on durable observations, not provenance metadata.

## Non-Goals

- Do not redesign recall ranking or semantic indexing.
- Do not add source span extraction in this iteration.
- Do not preserve compatibility with old `SnapshotContent.turns` naming inside the code path; this repo is MVP-stage and schema changes should move to the new shape directly.
- Do not make gateway output human-readable explanations for persistence.

## Current Problem

Current flow:

1. Gateway receives pending session turns.
2. Gateway returns `GatewayUpdate.summary`.
3. `applyGatewayUpdates()` passes that summary to `observeThread()`.
4. Observer sees only the gateway summary, not the original turn.
5. Snapshot `turns` are also based on the gateway summary.

This makes gateway summarization a lossy fact bottleneck. If the gateway summary drops a date anchor, speaker detail, or quoted source text, the observer cannot recover it. The observer prompt may ask for date normalization, but that rule only works when the observer input still contains the date anchor.

## Proposed Architecture

### Gateway Responsibilities

The gateway is a routing controller.

It should:

- Decide whether each pending turn should append to one or more existing observing threads.
- Decide whether a pending turn should create a new observing thread.
- Use thread title, thread summary, continuity hints, pending turn summaries, and previous-turn context only to make routing decisions.
- Return only control fields needed to execute routing.

It should not:

- Extract durable facts.
- Summarize source content for observation.
- Return `why` for persistence.
- Return any summary that becomes observer input.
- Write anything directly to observing snapshots.

New gateway output:

```ts
type GatewayUpdate = {
  turnId: string;
  action: 'append' | 'new';
  observingId?: string | null;
  newThread?: NewThreadHint | null;
};
```

`newThread.title` and `newThread.summary` remain allowed because a new thread needs an initial topic seed. They are not observation facts and must not be semantic-indexed as memories.

### Observer Responsibilities

The observer is the extraction stage.

It receives:

- Current observing thread state.
- Complete raw source turns selected by gateway routing.
- For each source turn, at least `turnId`, `prompt`, and `response`.

It must:

- Treat routing as already done and update only the current observing thread.
- Inspect complete raw source content.
- Extract only the parts relevant to the current observing thread.
- Ignore unrelated parts of mixed-topic turns.
- Normalize clear relative times when the raw source contains a `DATE:` anchor.
- Produce durable observations.
- Produce source references that explain why a source turn matters to this observing thread.

New observer input:

```ts
type ObservingTurnInput = {
  turnId: string;
  prompt?: string | null;
  response?: string | null;
};
```

New observer output:

```ts
type SourceReference = {
  turnId: string;
  summary: string;
};

type ObserveResult = {
  observingContentUpdate: ObservingContentUpdate;
  sourceReferences: SourceReference[];
  observationDelta: LlmFieldUpdate<Observation>;
};
```

`sourceReferences[].summary` is the observer-owned explanation of the current thread's relevant slice of the source turn. It replaces both gateway `summary` and gateway `why` for long-term usefulness.

### Snapshot Content

Rename thread-local source slices from `turns` to `sourceReferences`.

```ts
type SnapshotContent = {
  observations: Observation[];
  sourceReferences: SourceReference[];
  openQuestions?: string[];
  nextSteps?: string[];
  observationDelta: LlmFieldUpdate<Observation>;
};
```

Semantics:

- `observations` are durable conclusions.
- `sourceReferences` are observer-produced provenance slices.
- `sourceReferences` are ordered and bounded by `observer.contextTurns`.
- `sourceReferences` are used for continuity hints, inspection, and debug.
- `sourceReferences` are not written to the semantic index.
- `observationDelta.after` remains the semantic-index source.

The native observing row's `references: string[]` should be derived from observer-produced `sourceReferences.map(ref => ref.turnId)`, not from gateway routing updates. If gateway routes a turn but observer returns no source reference for it, that turn should not be persisted as a reference for the snapshot.

## Prompt Design

### Gateway Prompt

Gateway prompt should be shorter and stricter:

- State that the gateway decides which thread should inspect each turn.
- State that the gateway must not extract facts, rewrite source content, or summarize for observation.
- State that the observer will read raw `prompt` and `response`.
- Keep `continuityHint` and `previousTurn` as routing-only context.
- Require every pending turn to appear in at least one routing update.
- Allow a turn to appear multiple times only when multiple threads should inspect it.
- Remove `summary` and `why` from the output schema.

The gateway output schema should be:

```json
{
  "updates": [
    {
      "turnId": "string",
      "action": "append|new",
      "observingId": "string|null",
      "newThread": {
        "title": "string",
        "summary": "string"
      }
    }
  ]
}
```

### Observer Prompt

Observer prompt should emphasize source fidelity and thread relevance:

- Routing has already selected this observing thread.
- Use raw `prompt` and `response` as source.
- Update only the current observing thread.
- If a turn contains multiple topics, use only the parts relevant to this thread.
- Do not let unrelated parts affect title, summary, observations, open questions, next steps, or source references.
- For each source turn with relevant content, return one `sourceReferences` entry summarizing only the relevant slice.
- If a routed source turn has no relevant durable content after inspection, do not include it in `sourceReferences`.
- Normalize relative dates when source contains `DATE:` anchors.
- Continue writing recall-ready observations with explicit subjects and enough context to stand alone.

Observer output schema should be:

```json
{
  "observingContentUpdate": {
    "title": "string",
    "summary": "string",
    "openQuestions": ["string"],
    "nextSteps": ["string"]
  },
  "sourceReferences": [
    {
      "turnId": "string",
      "summary": "string"
    }
  ],
  "observationDelta": {
    "before": [],
    "after": []
  }
}
```

`sourceReferences[].summary` should be concise. It should explain the relevant source slice, not the whole turn. A target budget of 160-220 characters is appropriate for MVP.

## Data Flow

1. `observeEpoch()` calls `routeObservingThreads()`.
2. Gateway returns routing-only updates.
3. `applyGatewayUpdates()` groups raw session turns by target observing thread.
4. For each touched thread, `observeThread()` receives current observing content plus raw `prompt` and `response` for the routed turns.
5. Observer returns updated thread fields, `sourceReferences`, and `observationDelta`.
6. `applyObserveResult()` stores observations, bounded `sourceReferences`, and observation delta.
7. Observing row `references` are derived from observer `sourceReferences`, not gateway updates.
8. Semantic index writes only `observationDelta.after`.
9. Future gateway `continuityHint` is derived from the latest snapshot's last `sourceReferences[].summary`.

## Error Handling

- Gateway validation should reject updates that omit required routing control fields.
- Gateway validation should no longer require or accept `summary` or `why`.
- Observer validation should require `sourceReferences` to be an array.
- Observer validation should discard malformed source references rather than allowing invalid snapshot content.
- A routed turn without observer-produced source reference is allowed; it means the observer inspected the turn and found no thread-relevant source slice worth persisting.
- If observer returns observations that cite a turn but omits all source references, the observation can still be accepted, but the test suite should cover normal cases where relevant observations have corresponding source references.

## Testing Plan

### Prompt and Schema Tests

- Gateway prompt does not expose `summary` or `why` in output schema.
- Gateway prompt says not to extract facts or summarize for observation.
- Observer prompt says raw `prompt` and `response` are source.
- Observer prompt says to extract only current-thread-relevant content.
- Observer prompt output schema includes `sourceReferences`.
- Observer prompt preserves date normalization rules.

### Core Tests

- `GatewayUpdate` accepts routing-only updates.
- `applyGatewayUpdates()` passes raw `prompt` and `response` to observer.
- Gateway update fields are not written into snapshot content.
- Observer-produced `sourceReferences` are written into snapshot content.
- Observing row `references` are derived from observer `sourceReferences`, not gateway-routed turn ids.
- `continuityHint` is derived from the latest `sourceReferences` summary.
- A mixed-topic turn routed to two threads gives each observer call the complete raw turn, but stores only each thread's observer-produced source reference.
- A routed turn with no `sourceReferences` is not persisted in snapshot references.

### LoCoMo Small-Sample Check

Run the existing `conv-26` small sample with real observer and embedding config.

Expected improvements:

- Q2 observation should normalize `last year` relative to `8 May 2023` into `2022`.
- Q2 answer should be `2022` or an equivalent answer that scores correctly.
- The painting thread should contain a source reference for the relevant source turn explaining the painting date.
- The career/support-group thread should not absorb painting-only source details.
- Q1 and Q3 recall should not regress.

## Acceptance Criteria

- Gateway output contains no persisted source fact fields.
- Observer receives raw source content and owns extraction.
- Snapshot content stores `sourceReferences`, not gateway summaries.
- Observing row references reflect observer-confirmed source references.
- Date anchors survive into observer input.
- Semantic index remains based only on observation deltas.
- The LoCoMo Q2 failure mode caused by lost date anchors is addressed.

