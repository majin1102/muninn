# Conservative Observing Quality Design

## Context

Muninn recall currently uses semantic index rows built from observing memory deltas. Raw session turns are still valuable as evidence, but they are too fragmented to be the primary recall unit. Observing threads provide better recall context because each thread groups related turns into a topic-level memory unit.

The current `conv-26` LoCoMo run shows that topic splitting is useful and should remain intact. The issue is inside each topic: many memories are still transcript-like speech acts such as "Melanie asked...", "Melanie said that's cool...", or "Caroline thanked...". These make observing noisier without improving durable memory quality.

## Goals

- Keep observing threads as the primary recall unit.
- Preserve existing topic routing behavior in `observing-gateway.yaml`.
- Improve memory quality inside each observing thread.
- Keep answerable facts available so recall coverage is not materially reduced.
- Add a readable benchmark review output for manual evaluation.

## Non-Goals

- Do not switch to session-only recall.
- Do not add a session semantic index in this iteration.
- Do not add deterministic runtime filtering after the observer LLM.
- Do not force fewer observing threads or prevent one turn from contributing to multiple topics.
- Do not build automated quality scoring for observing output in this iteration.

## Design

### 1. Prompt-Only Observing Refinement

Update `packages/core/prompts/observing.yaml` only. The gateway prompt stays unchanged.

The observing prompt should preserve topic context but make memory extraction more selective:

- A `Fact` should describe a reusable state, event, plan, preference, relationship, identity, interest, or grounded conclusion.
- A `Fact` should not default to recording the act of speaking, asking, commenting, thanking, greeting, praising, or transitioning.
- Questions should not become durable memories. Unanswered questions belong in `openQuestions`; answered questions should be removed from `openQuestions`.
- Conversational reactions and acknowledgements should be omitted unless they directly reveal durable information.
- Answerable facts should remain in memories even if they are small, as long as they can plausibly support future recall.

Expected examples:

- Keep: `Caroline attended an LGBTQ support group on 7 May 2023 and found it powerful.`
- Keep: `The LGBTQ support group made Caroline feel accepted and gave her courage to embrace herself.`
- Keep: `Caroline is interested in counseling or mental health work to support people with similar issues.`
- Keep: `Melanie painted a lake sunrise painting in 2022.`
- Drop: `Melanie asked Caroline what kind of jobs she was thinking of.`
- Drop: `Melanie said that's really cool and asked "What now?"`
- Drop: `Caroline thanked Melanie.`

The prompt should not be LoCoMo-specific. The examples should describe general memory extraction patterns rather than benchmark answers.

### 2. Preserve Recall Shape

Recall continues to target observing semantic index rows. When benchmark QA needs more detail, it should continue using recalled observing hits plus expanded referenced session turns.

This keeps the division clear:

- Observing memories provide topic-level recall and normalized facts.
- Session references provide raw evidence and missing details.

### 3. Manual Review Output

Add a readable benchmark review artifact, for example:

`benchmark/locomo/out/<run-name>_review.md`

The report should be aimed at human inspection rather than automated scoring. It should include:

- Observing threads:
  - snapshot id
  - title
  - latest summary
  - referenced session ids
  - memories grouped by category
  - open questions
  - next steps
- QA trace:
  - question
  - gold answer
  - recalled observing hits
  - matched memory text
  - expanded related sessions when enabled
  - LLM answer
  - LoCoMo F1 and hidden recall

The report should make it easy to answer two review questions:

- Did observing quality improve without losing important topic facts?
- Did recall still retrieve enough context for the QA task?

## Testing And Evaluation

Unit tests should cover the prompt contract and report rendering shape. The main quality evaluation is manual review of the generated markdown report after rerunning the `conv-26` small sample with real observer, embedding, and answerer config.

Expected manual comparison:

- Fewer speech-act memories appear in observing output.
- Core answerable facts from the previous run remain present.
- Topic summaries still provide useful context.
- Recall still retrieves relevant observing hits for the sample QA.

## Risks

- Prompt-only refinement may not consistently remove all low-value speech acts.
- If the prompt becomes too strict, recall coverage can drop because semantic index rows only come from observing memories.
- Manual review is slower than automated metrics, but it is less misleading for this early-stage quality work.

## Acceptance Criteria

- `observing-gateway.yaml` is unchanged.
- `observing.yaml` is refined to distinguish durable facts from speech-act transcript fragments.
- Benchmark output includes a human-readable review artifact.
- `conv-26` can be rerun and reviewed manually.
- The review output shows observing memories and QA recall evidence in one place.
