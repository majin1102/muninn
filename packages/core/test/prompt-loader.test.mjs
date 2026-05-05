import test from 'node:test';
import assert from 'node:assert/strict';

import { loadDomainPrompt, loadGatewayDomainPrompt } from '../dist/llm/domain-prompt.js';
import { loadPromptTemplate } from '../dist/llm/prompt-loader.js';

test('observation extraction prompt exists and describes grounded observations', () => {
  const prompt = loadPromptTemplate('observation_extraction');
  assert.match(prompt.system, /durable memory observations/i);
  assert.match(prompt.system, /domain-specific observation guidance/i);
  assert.match(prompt.system, /domain_prompt/);
  assert.match(prompt.userTemplate, /recentContext/);
  assert.match(prompt.userTemplate, /up to three earlier raw turns/);
  assert.match(prompt.userTemplate, /do not extract observations from `recentContext` by itself/);
  assert.match(prompt.userTemplate, /input_json/);
});

test('observation review prompt only removes observations', () => {
  const prompt = loadPromptTemplate('observation_review');
  assert.match(prompt.system, /remove observations/i);
  assert.doesNotMatch(prompt.system, /create new observations/i);
});

test('thread preparation prompt enforces two observations for new threads', () => {
  const prompt = loadPromptTemplate('thread_preparation');
  assert.match(prompt.system, /at least two related observations/i);
  assert.match(prompt.system, /memory-get/i);
  assert.doesNotMatch(prompt.system, /memory_get/i);
  assert.match(prompt.userTemplate, /reviewedObservations\[\]\.id/);
  assert.match(prompt.userTemplate, /Do not put candidate memory ids/);
});

test('chat domain prompt provides category guidance without observing workflow schema', () => {
  const template = loadPromptTemplate('chat');
  const system = template.system;

  assert.match(system, /Chat observation categories and granularity/);
  assert.match(system, /Observing thread definition/);
  assert.match(system, /subject observing thread tracks one coherent subject that can develop over time/);
  assert.match(system, /narrower than the whole conversation and more stable than a single message/);
  assert.match(system, /Route a new span to a subject thread only when it updates, answers, clarifies, corrects, supports, or directly continues that subject/);
  assert.doesNotMatch(system, /Use `update` plus `add`/);
  assert.doesNotMatch(system, /Chat filtering/);
  assert.doesNotMatch(system, /Observation granularity/);
  assert.match(system, /Store the useful conclusion, answer, state, plan, preference, or reusable fact, not the conversation act/);
  assert.match(system, /Questions, compliments, reactions, acknowledgements, and prompts usually belong in `openQuestions` or `contextRefs`, not observations/);
  assert.match(system, /Keep them as observations only when their content establishes a grounded, self-contained fact, preference, decision, entity characteristic, or reusable concept/);
  assert.match(system, /When chat evidence answers, explains, or completes an existing point, fold it into the relevant observation/);
  assert.match(system, /Before finalizing chat observations, combine new candidates that describe the same plan, direction, artifact, event, answer, or developing subject/);
  assert.match(system, /Combine details when one detail explains, specifies, answers, motivates, evaluates, or provides evidence for another detail/);
  assert.doesNotMatch(system, /greetings, small talk, filler/);
  assert.doesNotMatch(system, /pure questions, temporary status updates/);
  assert.doesNotMatch(system, /descriptive details, transition remarks, pure questions, one-off actions/);
  assert.match(system, /Choose the observation before choosing the category/);
  assert.match(system, /Each category below defines both what to store and the useful granularity/);
  assert.match(system, /stable or reusable likes/);
  assert.match(system, /Preserve who holds the preference/);
  assert.match(system, /Merge related signals when they describe the same stable preference/);
  assert.match(system, /One-time reactions, compliments, ratings/);
  assert.match(system, /are `Fact` if worth remembering/);
  assert.match(system, /do not generalize them into `Preference`/);
  assert.match(system, /source-described detail, answerable detail/);
  assert.match(system, /Prefer `Fact` for one-time details when they may support future recall/);
  assert.match(system, /Preserve enough subject, object, time, place, status, and cause\/effect or purpose/);
  assert.match(system, /Merge details from the same event, context, or answer/);
  assert.match(system, /For time-bearing `Fact` observations, resolve clear relative time from grounded chat context into an absolute date or period/);
  assert.match(system, /`yesterday` with an `8 May 2023` context becomes `7 May 2023`/);
  assert.match(system, /`last month` with a `May 2023` context becomes `April 2023`/);
  assert.match(system, /`last year` with a `2023` context becomes `2022`/);
  assert.match(system, /Keep relative wording only when the absolute time cannot be determined/);
  assert.doesNotMatch(system, /Extract useful absolute time from context when available/);
  assert.doesNotMatch(system, /memory-get/);
  assert.doesNotMatch(system, /If an observation or `contextRefs\.summary` would still contain unresolved relative time/);
  assert.match(system, /does not fit a more specific category/);
  assert.match(system, /Preserve the decision maker/);
  assert.match(system, /For time-bearing `Decision` observations, resolve clear relative time/);
  assert.match(system, /reusable entities and their stable characteristics/);
  assert.match(system, /identity\/profile attributes/);
  assert.match(system, /Do not record one-time actions or dialogue participation as `Entity`/);
  assert.match(system, /Preserve the reusable idea/);
  assert.doesNotMatch(system, /Observation definition/);
  assert.doesNotMatch(system, /Thread title/);
  assert.doesNotMatch(system, /Thread summary/);
  assert.doesNotMatch(system, /memory_get/);
  assert.doesNotMatch(system, /observationChanges/);
  assert.doesNotMatch(system, /observationDelta/);
  assert.doesNotMatch(system, /Return exactly one JSON object/);
});

test('chat domain prompt sections are loaded by observing stage', () => {
  const gateway = loadGatewayDomainPrompt('chat');
  const observing = loadDomainPrompt('chat');

  assert.match(gateway, /Observing thread definition/);
  assert.match(gateway, /Same vs separate routing/);
  assert.match(gateway, /Route spans to the session thread when they introduce a different subject/);
  assert.doesNotMatch(gateway, /Chat observation categories and granularity/);
  assert.doesNotMatch(gateway, /`Fact`/);
  assert.doesNotMatch(gateway, /`Preference`/);
  assert.doesNotMatch(gateway, /Observation granularity/);

  assert.match(observing, /Chat observation categories and granularity/);
  assert.match(observing, /`Fact`/);
  assert.match(observing, /`Preference`/);
  assert.doesNotMatch(observing, /Same vs separate routing/);
  assert.doesNotMatch(observing, /Observation granularity/);
  assert.doesNotMatch(observing, /Chat filtering/);
  assert.doesNotMatch(observing, /memory-get/);
});

test('thread observing prompt uses generic recall-ready memory guidance', () => {
  const template = loadPromptTemplate('thread_observing');
  const system = template.system;

  assert.match(system, /Concepts/);
  assert.match(system, /Observer: updates exactly one observing thread from routed fragments/);
  assert.match(system, /Fragment: selected material routed to this thread/);
  assert.match(system, /Observation state: the complete current list of observations this thread should keep/);
  assert.match(system, /Do/);
  assert.match(system, /Don't do/);
  assert.match(system, /Observation/);
  assert.match(system, /Observation: a grounded, self-contained statement that may remain useful after this conversation/);
  assert.match(system, /Write observations as conclusions about what is true, planned, decided, preferred, known, or changed/);
  assert.match(system, /Make each observation understandable and usable without replaying the transcript/);
  assert.match(system, /Use domain category guidance to decide category, details, and granularity/);
  assert.doesNotMatch(system, /Routing has already selected the fragments for this thread/);
  assert.doesNotMatch(system, /rewrite clear relative dates or periods into absolute dates or periods/);
  assert.doesNotMatch(system, /`yesterday`, `tomorrow`, `last week`, `last month`, and `last year`/);
  assert.doesNotMatch(system, /Fallback inspection/);
  assert.doesNotMatch(system, /batches of up to 5/);
  assert.doesNotMatch(system, /starting from the first sourceRef/);
  assert.doesNotMatch(system, /Include useful subject, time, place, object, status, cause, or purpose/);
  assert.match(system, /Do not store pure transcript events, unsupported inference, unresolved pronouns/);
  assert.match(system, /content that the domain guidance says should not become an observation/);
  assert.doesNotMatch(system, /Granularity:/);
  assert.doesNotMatch(system, /memory unit/);
  assert.match(system, /Domain category guidance/);
  assert.match(system, /First decide whether a valid observation exists under the general rules here/);
  assert.match(system, /The domain guidance below controls observation category, category-specific details, and granularity/);
  assert.match(system, /Domain guidance does not override source scope, grounding, or observation-change rules/);
  assert.match(system, /domain_prompt/);
  assert.doesNotMatch(system, /Category selection:/);
  assert.doesNotMatch(system, /Prefer the most specific category over `Fact` when an observation describes/);
  assert.doesNotMatch(system, /Observation definition/);
  assert.doesNotMatch(system, /Recall-ready writing/);
  assert.doesNotMatch(system, /Derivation style/);
  assert.doesNotMatch(system, /Fact quality/);
  assert.match(system, /Thread title/);
  assert.match(system, /clear, concrete label for the stable thread subject/);
  assert.match(system, /key person\/entity\/object plus concrete topic, activity, artifact, plan, relationship, or state/);
  assert.match(system, /stable thread subject, not the latest turn/);
  assert.match(system, /stay neutral and concrete without overstating long-term meaning/);
  assert.match(system, /meta labels/);
  assert.doesNotMatch(system, /Prefer 6-14 words/);
  assert.doesNotMatch(system, /Prefer 3-8 words/);
  assert.match(system, /Thread summary/);
  assert.match(system, /refined summary of the thread subject, known information, current state, and development/);
  assert.match(system, /future routing and recall by clarifying what future updates naturally belong here/);
  assert.match(system, /known information, current state, and development/);
  assert.match(system, /Prefer synthesis over listing observations or replaying turns/);
  assert.match(system, /Include useful people, objects, time context, status, unresolved questions, and developing direction/);
  assert.match(system, /without dropping important context/);
  assert.doesNotMatch(system, /roughly 1000 characters/);
  assert.doesNotMatch(system, /roughly 500 characters/);
});

test('observing prompt preserves the current observation schema', () => {
  const template = loadPromptTemplate('thread_observing');
  const system = template.system;

  for (const category of ['Preference', 'Fact', 'Decision', 'Entity', 'Concept', 'Other']) {
    assert.match(system, new RegExp(category));
  }
  assert.doesNotMatch(system, /"category": "Goal"/);
  assert.doesNotMatch(system, /`Goal`/);
  assert.match(system, /observations/);
  assert.match(system, /Return the complete current observations for this thread/i);
  assert.match(system, /Keep the existing `id` when an existing observation remains valid/i);
  assert.match(system, /Omit low-value, duplicate, replaced, or no-longer-valid observations/i);
  assert.match(system, /Do not return `observationChanges`/);
  assert.doesNotMatch(system, /"observationChanges"/);
  assert.match(system, /call `memory-get`/);
  assert.match(system, /visible turn ids/);
  assert.match(system, /fragments\[\]\.turns\[\]\.turnId/);
  assert.doesNotMatch(system, /observing snapshot details/);
  assert.doesNotMatch(system, /existing observation details/);
  assert.match(system, /Id usage/);
  assert.match(system, /Use existing `observingContent\.observations\[\]\.id` values only for observations that remain in the final state/);
  assert.match(system, /Use `fragments\[\]\.turns\[\]\.turnId` values in observation `references`/);
  assert.match(system, /Keep unresolved conflicts in `openQuestions`/);
  assert.match(system, /"observations": \[/);
  assert.doesNotMatch(system, /observationConsolidation/);
  assert.doesNotMatch(system, /observationDelta/);
  assert.doesNotMatch(system, /observingContentUpdate/);
  assert.doesNotMatch(system, /whyRelated/);
  assert.doesNotMatch(system, /memoryDelta\.before/);
  assert.doesNotMatch(system, /sourceRefs/);
  assert.doesNotMatch(system, /excerpt/);
});

test('observing gateway prompt uses session and subject threads', () => {
  const template = loadPromptTemplate('observing_gateway');
  const system = template.system;

  assert.match(system, /Domain observing thread guidance/);
  assert.match(system, /{{domain_prompt}}/);
  assert.match(system, /Session observing thread: the default observing thread/);
  assert.match(system, /Subject observing thread: a derived observing thread/);
  assert.match(system, /kind: "session" \| "subject"/);
  assert.match(system, /Use the session thread when the fragment does not clearly fit any subject thread/);
  assert.match(system, /Do not create new threads or titles/);
  assert.doesNotMatch(system, /continuityHints/);
  assert.doesNotMatch(system, /previousTurn/);
  assert.doesNotMatch(system, /newThreadTitle/);
  assert.doesNotMatch(system, /ignoredTurnIds/);
});

test('observing gateway prompt is routing-only', () => {
  const template = loadPromptTemplate('observing_gateway');
  const system = template.system;

  assert.match(system, /Concepts/);
  assert.match(system, /Gateway: the routing stage that splits session turns and routes them to observing threads/);
  assert.match(system, /It does not write memories or create threads/);
  assert.match(system, /SessionFragment: source information from one or more turns/);
  assert.match(system, /`threadId`: target observing thread id/);
  assert.match(system, /`turnIds`: source turn ids covered by this fragment/);
  assert.match(system, /`content`: faithful thread-scoped narrative/);
  assert.match(system, /`reason`: short trace-only routing explanation/);
  assert.match(system, /Domain observing thread guidance/);
  assert.match(system, /domain_prompt/);
  assert.match(system, /Routing principles/);
  assert.match(system, /Lossless routing is more important than concise output/);
  assert.match(system, /Route all meaningful session information/);
  assert.match(system, /First split the pending turns into thread-scoped session fragments/);
  assert.match(system, /Prefer a subject thread only when the fragment clearly updates, answers, clarifies, corrects, supports, or continues/);
  assert.match(system, /A fragment may cover multiple turns/);
  assert.match(system, /The same turn may appear in multiple fragments/);
  assert.match(system, /Do not drop meaningful information just to keep output short/);
  assert.match(system, /Do not force content into a subject thread only because it shares dialogue context/);
  assert.match(system, /Do not include unrelated information in a subject thread fragment as background/);
  assert.match(system, /faithful, source-scoped narrative/);
  assert.match(system, /Preserve meaningful details/);
  assert.match(system, /do not drop people, objects, time, actions, questions, answers, uncertainty, or relationships/);
  assert.match(system, /do not add facts, infer final memory conclusions, or generalize beyond the source/);
  assert.match(system, /reason/);
  assert.match(system, /trace\/debug only/);
  assert.match(system, /sessionFragments/);
  assert.match(system, /"turnIds": \["string"\]/);
  assert.match(system, /"content": "string"/);
  assert.match(system, /Wow, love that painting/);
  assert.match(system, /What's it done for you/);
  assert.doesNotMatch(system, /You'd be a great counselor/);
  assert.doesNotMatch(system, /"updates"/);
  assert.doesNotMatch(system, /"action"/);
  assert.doesNotMatch(system, /"why": "string"/);
  assert.doesNotMatch(system, /targetThreadId/);
  assert.doesNotMatch(system, /refs\[\]\.excerpt/);
  assert.doesNotMatch(system, /Incidental media source-only rule/i);
});

test('chat domain prompt defines subject routing boundaries', () => {
  const template = loadPromptTemplate('chat');
  const system = template.system;

  assert.match(system, /Same vs separate routing/);
  assert.match(system, /Keep spans with a subject thread when they complete or refine that subject/);
  assert.match(system, /Route spans to the session thread when they introduce a different subject/);
  assert.match(system, /do not clearly fit an existing subject thread/);
  assert.match(system, /need later derivation/);
  assert.match(system, /Do not route to a subject thread only because spans are adjacent, in the same batch, or mention the same people/);
  assert.doesNotMatch(system, /separate work item/);
  assert.doesNotMatch(system, /Split spans/);
});

test('observing prompt uses selected source spans and emits context refs', () => {
  const template = loadPromptTemplate('thread_observing');
  const system = template.system;

  assert.match(system, /fragments/);
  assert.match(system, /memory-get/);
  assert.doesNotMatch(system, /memory_get/);
  assert.match(system, /Treat fragment\.content as the selected material/);
  assert.match(system, /Use fragment\.turns only to verify and clarify fragment\.content/);
  assert.match(system, /Do not observe unrelated raw turn content outside the fragment content/);
  assert.match(system, /If content is too ambiguous/);
  assert.match(system, /no useful observation content after inspection/);
  assert.match(system, /observing thread/i);
  assert.match(system, /contextRefs/);
  assert.doesNotMatch(system, /sourceReferences/);
  assert.match(system, /Only request visible turn ids from `fragments\[\]\.turns\[\]\.turnId`/);
  assert.doesNotMatch(system, /sourceRefs/);
  assert.doesNotMatch(system, /excerpt/);
  assert.doesNotMatch(system, /DATE:/);
  assert.doesNotMatch(system, /Incidental media/i);
  assert.doesNotMatch(system, /Do not turn .*liked.*reacted.*image.*painting.* into .*Fact/i);
  assert.doesNotMatch(system, /`summary`: grounded content from the turn/);
});
