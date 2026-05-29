# Observing Thread-Scoped Slicing Design

## Context

Muninn currently uses observing threads as the primary recall unit. That direction is still correct: topic-level observing snapshots are more useful for recall than raw session turns, and session turns should remain supporting evidence rather than the primary indexed memory unit.

The current `conv-26` LoCoMo slice shows two related but distinct problems:

- Topic splitting exists, but cross-topic turns still leak into multiple observing threads as full turn summaries.
- Inside each observing thread, many persisted memories are still transcript-like speech acts such as "Melanie asked...", "Melanie reacted positively...", or "Caroline thanked...".

The most obvious example is `D1:12`, where one turn both reinforces Caroline's counseling direction and introduces Melanie's painting topic. The current system allows that turn to affect multiple threads, but it does not first slice the turn into thread-scoped grounded fragments. As a result, both threads absorb too much irrelevant content.

## Goals

- Keep observing threads as the primary recall unit.
- Preserve the ability for one turn to contribute to multiple observing threads.
- Make gateway updates thread-scoped before they reach observing update.
- Reduce transcript-like observing memories without removing durable facts, preferences, decisions, or entities.
- Improve observing thread titles and summaries so they read like topic state, not event lists or partial transcripts.

## Non-Goals

- Do not change benchmark QA prompting, answering, or scoring.
- Do not change recall to use raw session turns as the primary semantic index unit.
- Do not force identity conclusions such as "Caroline is a transgender woman" directly into observing memory when the source is only indirectly suggestive.
- Do not redesign the full observer architecture or add a second post-processing pipeline after observing update.

## Design

### 1. Gateway Produces Thread-Scoped Summaries

`packages/core/src/llm/observing-gateway.ts` already routes pending turns to one or more observing threads. This design keeps that behavior, but changes the required meaning of each routed update:

- Each `(turn, thread)` update must contain a `summary` that is already sliced to only the content relevant to that observing thread.
- If a single turn is routed to two threads, the gateway should emit two different summaries, one per thread.
- The gateway should omit grounded content that is unrelated to the current thread even if it appears in the same original turn.

This makes the gateway responsible for "what part of the turn belongs to this thread?" and keeps the observing update responsible for "what durable state should be remembered from that thread-scoped input?"

Expected behavior for a cross-topic turn such as `D1:12`:

- For Caroline's career thread, the update summary keeps only the counselor-related statement.
- For Melanie's painting thread, the update summary keeps only the painting-related statement.

This is intentionally not a new public API. The schema stays the same; only the quality contract for `summary` becomes stricter.

### 2. Observing Update Stores Durable Conclusions, Not Speech Acts

`packages/core/prompts/observing.yaml` should be tightened so that observing memories represent durable conclusions, not conversational mechanics.

New hard rules:

- Do not store speech acts as memories.
- If a turn only asks, reacts, thanks, praises, greets, or closes the conversation, do not store it as a memory unless it changes durable state, an unresolved question, a decision, a preference, a relationship, or a reusable fact.
- Prefer conclusions over utterance descriptions. For example, store "Melanie uses painting to express feelings and relax" instead of "Melanie said painting is fun and relaxing."

This does not mean all short facts should be removed. Small answerable facts are still valuable if they support later recall.

### 3. Title And Summary Become State-Oriented

Observing thread `title` and `summary` should become thread-level state descriptions rather than transcript fragments.

Required title behavior:

- Short readable topic label.
- Not a sentence.
- Not an event list.
- Should not try to enumerate every subtopic in the thread.

Required summary behavior:

- Durable state summary, not chronological transcript.
- Summarize the stable conclusions, current direction, open work, and important entities in the thread.
- Omit greetings, thanks, praise, reactions, and resolved conversational turns unless they changed durable state.
- Must remain complete and readable; avoid truncated ellipsis-shaped output.

This is both a prompt rule and a runtime storage rule. Prompt guidance should push the model toward short, readable outputs, while runtime normalization should stop collapsing complete strings into hard-clipped ellipses.

### 4. Expected Thread Shape For `conv-26`

The design target for the current slice is still two observing threads.

Thread A:

- Caroline support group experience
- identity exploration / self-acceptance
- education and counseling / mental health direction

Thread B:

- Melanie painting
- painting as self-expression / relaxation

Shared turns can contribute to both threads, but only through sliced summaries that preserve thread-local relevance.

Examples of desired thread-local memories:

- `Caroline attended an LGBTQ support group on 7 May 2023 and found it powerful.`
- `The support group made Caroline feel accepted and gave her courage to embrace herself.`
- `Caroline plans to continue her education and explore counseling or mental health work.`
- `Melanie painted a lake sunrise in 2022.`
- `Painting helps Melanie express feelings, be creative, and relax after a long day.`

Examples that should usually not survive as durable memories:

- `Melanie asked Caroline what happened.`
- `Melanie reacted positively.`
- `Caroline thanked Melanie.`
- `Caroline said she was off to do research.`
- `Melanie said she was going swimming with the kids.`

## Implementation Scope

This design intentionally limits implementation scope to observing-side behavior:

- `packages/core/prompts/observing_gateway.yaml`
- `packages/core/src/llm/observing-gateway.ts`
- `packages/core/prompts/observing.yaml`
- related prompt / observer tests

The benchmark harness remains a consumer for validation only. It should not be modified as part of this work except where existing observing-side tests need fixture updates.

## Testing

### Unit Tests

Add or update tests to cover:

- gateway prompt contract for thread-scoped slicing
- a cross-topic turn that is routed to two threads and yields two different per-thread summaries
- observing prompt contract for rejecting speech-act memories
- title and summary quality rules
- no runtime ellipsis clipping for final stored observing title / summary

### Manual Evaluation

Rerun the existing `conv-26` small slice after implementation and inspect the latest observing snapshots.

Manual checks:

- exactly two main observing threads still exist
- the cross-topic turn is sliced differently for each thread
- the Caroline thread no longer absorbs Melanie painting details as primary thread content
- the painting thread no longer absorbs Caroline career/support-group details as primary thread content
- titles are short and readable
- summaries are state-oriented and complete
- transcript-like memories such as "asked", "reacted", and "thanked" are materially reduced

## Risks

- Gateway slicing may become too aggressive and drop useful context if the thread relevance contract is too narrow.
- Prompt tightening may still leave a small amount of speech-act leakage because the model can be conservative about converting utterances into conclusions.
- If title and summary are no longer clipped, poor prompt output could become verbose unless the title / summary quality rules are strong enough.

## Acceptance Criteria

- The gateway still allows one turn to contribute to multiple threads.
- Per-thread gateway updates use different thread-scoped summaries when the same turn touches multiple topics.
- Observing memories are more conclusion-oriented and less transcript-like.
- Observing thread titles are short readable topic labels.
- Observing thread summaries are durable state summaries rather than chronological transcripts.
- Final stored observing titles and summaries are no longer clipped into ellipsis-shaped partial strings by runtime normalization.
