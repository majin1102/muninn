import test from 'node:test';
import assert from 'node:assert/strict';

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
  assert.match(prompt.system, /memory_get/i);
  assert.match(prompt.userTemplate, /reviewedObservations\[\]\.id/);
  assert.match(prompt.userTemplate, /Do not put candidate memory ids/);
});

test('chat domain prompt provides category guidance without observing workflow schema', () => {
  const template = loadPromptTemplate('chat');
  const system = template.system;

  assert.match(system, /Chat category guide/);
  assert.match(system, /Chat filtering/);
  assert.match(system, /greetings, small talk, filler, acknowledgements, compliments, thanks, brief reactions/i);
  assert.match(system, /pure questions, one-off actions, temporary status updates/);
  assert.match(system, /Do not write these details as observations unless they establish/i);
  assert.match(system, /stable preference, relationship, plan, decision, long-term state, reusable fact/i);
  assert.match(system, /Do not store compliments, comments, or brief reactions as observations/i);
  assert.match(system, /Resolve second-person pronouns from the dialogue participants/i);
  assert.match(system, /do not interpret `you` as the assistant/i);
  assert.match(system, /Category selection/);
  assert.match(system, /Prefer the most specific category over `Fact`/);
  assert.match(system, /stable or reusable likes/);
  assert.match(system, /One-time reactions, compliments, ratings/);
  assert.match(system, /are `Fact` if worth remembering/);
  assert.match(system, /do not generalize them into `Preference`/);
  assert.match(system, /does not fit a more specific category/);
  assert.match(system, /reusable entities and their stable characteristics/);
  assert.match(system, /identity\/profile attributes/);
  assert.match(system, /do not record one-time actions or dialogue participation as `Entity`/);
  assert.doesNotMatch(system, /Observation definition/);
  assert.doesNotMatch(system, /Thread title/);
  assert.doesNotMatch(system, /Thread summary/);
  assert.doesNotMatch(system, /memory_get/);
  assert.doesNotMatch(system, /observationChanges/);
  assert.doesNotMatch(system, /observationDelta/);
  assert.doesNotMatch(system, /Return exactly one JSON object/);
});

test('thread observing prompt uses generic recall-ready memory guidance', () => {
  const template = loadPromptTemplate('thread_observing');
  const system = template.system;

  assert.match(system, /Observation:/);
  assert.match(system, /grounded, self-contained memory unit that may remain useful after this conversation/);
  assert.match(system, /one memory conclusion about what is true, planned, decided, preferred, or changed/);
  assert.match(system, /multiple grounded details when they make it clearer or more useful to recall/);
  assert.match(system, /Resolve clear subjects, speakers, addressees, and pronouns/);
  assert.match(system, /rewrite clear relative dates or periods into absolute dates or periods/);
  assert.match(system, /time, owner, scope, object, and status/);
  assert.match(system, /Do not store pure transcript events, raw captions, brief reactions/);
  assert.match(system, /temporary actions with no future relevance/);
  assert.match(system, /Granularity:/);
  assert.match(system, /one compact memory unit per recall or reasoning purpose/);
  assert.match(system, /same subject, topic, event, time window, or contextual dependency/);
  assert.match(system, /recalled, updated, or contradicted independently/);
  assert.match(system, /different sentences, turns, speakers, or categories/);
  assert.match(system, /details fit different categories/);
  assert.match(system, /category that best describes the combined memory unit/);
  assert.match(system, /Domain guidance/);
  assert.match(system, /domain_prompt/);
  assert.doesNotMatch(system, /Observation definition/);
  assert.doesNotMatch(system, /Recall-ready writing/);
  assert.doesNotMatch(system, /Derivation style/);
  assert.doesNotMatch(system, /Fact quality/);
  assert.match(system, /Thread title/);
  assert.match(system, /clear, concrete, human-readable title/);
  assert.match(system, /Name the memory subject; do not summarize the latest dialogue/);
  assert.match(system, /key person\/entity\/object plus the concrete subject or activity/);
  assert.match(system, /Prefer 6-14 words/);
  assert.match(system, /Avoid joining unrelated latest-turn events with `and`, semicolons/);
  assert.match(system, /Do not use meta labels such as `aside`, `candidate`, `tentative`, `misc`, or `unknown`/);
  assert.match(system, /neutral concrete title/);
  assert.doesNotMatch(system, /Prefer 3-8 words/);
  assert.match(system, /Thread summary/);
  assert.match(system, /refined summary of this observing thread's theme, content, and current state/);
  assert.match(system, /what this thread is about and what is currently known/);
  assert.match(system, /Preserve the meaningful context/);
  assert.match(system, /Prefer synthesis over listing observations or replaying the transcript/);
  assert.match(system, /do not replay every routed turn/);
  assert.match(system, /Do not include unrelated source slices only because they were routed in the same update/);
  assert.match(system, /roughly 1000 characters/);
  assert.doesNotMatch(system, /roughly 500 characters/);
  assert.match(system, /must be complete and must not end with an ellipsis/);
});

test('observing prompt preserves the current observation schema', () => {
  const template = loadPromptTemplate('thread_observing');
  const system = template.system;

  for (const category of ['Preference', 'Fact', 'Decision', 'Entity', 'Concept', 'Other']) {
    assert.match(system, new RegExp(`\\\`${category}\\\``));
  }
  assert.doesNotMatch(system, /"category": "Goal"/);
  assert.doesNotMatch(system, /`Goal`/);
  assert.match(system, /observations/);
  assert.match(system, /observationChanges/);
  assert.match(system, /Compare with existing observations before adding/);
  assert.match(system, /Use `update` to clarify, correct, time-normalize, or extend one existing memory unit/);
  assert.match(system, /answers an open question, fills in a missing detail, or continues the same subject/);
  assert.match(system, /update that observation instead of adding a separate one/);
  assert.match(system, /Use `merge` for duplicate, complementary, or context-dependent observations/);
  assert.match(system, /Use `add` only when no existing observation covers the memory unit/);
  assert.match(system, /Use `delete` for low-value, duplicate, ungrounded, or replaced observations/);
  assert.match(system, /A pass may use both `update` and `add`/);
  assert.match(system, /merge/);
  assert.match(system, /update/);
  assert.match(system, /delete/);
  assert.match(system, /`add\.references` must list source session ids/);
  assert.match(system, /`update\.references` may list source session ids/);
  assert.match(system, /merged with the existing observation references/);
  assert.match(system, /Do not merge conflicting observations/);
  assert.doesNotMatch(system, /observationConsolidation/);
  assert.doesNotMatch(system, /observationDelta/);
  assert.doesNotMatch(system, /observingContentUpdate/);
  assert.doesNotMatch(system, /whyRelated/);
  assert.doesNotMatch(system, /memoryDelta\.before/);
});

test('observing gateway prompt constrains continuity hints', () => {
  const template = loadPromptTemplate('observing_gateway');
  const system = template.system;

  assert.match(system, /continuityHints/);
  assert.match(system, /only to judge semantic continuity/);
  assert.match(system, /Do not copy, restate, route, or observe/);
  assert.match(system, /previousTurn/);
  assert.match(system, /reference context/);
  assert.doesNotMatch(system, /continuityHint:/);
});

test('observing gateway prompt is routing-only', () => {
  const template = loadPromptTemplate('observing_gateway');
  const system = template.system;

  assert.match(system, /topic-scoped source supplements/i);
  assert.match(system, /Identify each supplement first, then route each supplement/i);
  assert.match(system, /A supplement is the smallest source span that adds context to one observing thread/);
  assert.match(system, /Cover every potentially observable span/);
  assert.match(system, /pure non-observable content/);
  assert.match(system, /Create a new thread when a supplement introduces a potentially observable subject/i);
  assert.match(system, /not better understood as a detail, answer, update, or continuation of an existing thread/i);
  assert.match(system, /Do not append a supplement to an existing thread only because/i);
  assert.match(system, /Detect topic shifts by semantic content, not fixed keywords/i);
  assert.match(system, /Source supplement rules/);
  assert.match(system, /A work item is scoped to exactly one observing thread/);
  assert.match(system, /Each `sourceRefs\.excerpt` must include only the span relevant to that work item's target thread/);
  assert.match(system, /If different spans in one turn answer, explain, update, or continue different threads/);
  assert.match(system, /If one span is a side reaction and another span asks or answers the main topic/);
  assert.match(system, /Do not combine multiple topic supplements into one excerpt only because they are adjacent/);
  assert.match(system, /newThreadTitle/);
  assert.match(system, /clear, concrete, human-readable title/);
  assert.match(system, /key person\/entity\/object plus the concrete subject or activity/);
  assert.match(system, /Prefer 6-14 words/);
  assert.match(system, /Do not use meta labels such as `aside`, `candidate`, `tentative`, `misc`, or `unknown`/);
  assert.match(system, /Gateway only sets the initial title/);
  assert.match(system, /Current turn:/);
  assert.match(system, /sourceRefs\.excerpt/);
  assert.match(system, /routing scope only/);
  assert.match(system, /not a final memory fact/i);
  assert.match(system, /routingReason/);
  assert.match(system, /trace\/debug only/);
  assert.match(system, /observer will read .*sourceRefs\.excerpt.*routing scope.*prompt.*response/i);
  assert.match(system, /Wow, love that painting/);
  assert.match(system, /What's it done for you/);
  assert.doesNotMatch(system, /You'd be a great counselor/);
  assert.doesNotMatch(system, /"updates"/);
  assert.doesNotMatch(system, /"action"/);
  assert.doesNotMatch(system, /"why": "string"/);
  assert.doesNotMatch(system, /Incidental media source-only rule/i);
});

test('observing prompt consumes raw source and emits context refs', () => {
  const template = loadPromptTemplate('thread_observing');
  const system = template.system;

  assert.match(system, /sourceRefs/);
  assert.match(system, /memory_get/);
  assert.match(system, /source session turn detail/);
  assert.match(system, /source references selected for this observing thread/);
  assert.match(system, /raw `prompt` and `response`/);
  assert.match(system, /selected source span for this observing thread/);
  assert.match(system, /raw `prompt` and `response` provide context/);
  assert.match(system, /Do not turn unrelated content outside the selected span/);
  assert.match(system, /If broader context changes the meaning of the selected span/);
  assert.match(system, /excerpt/);
  assert.match(system, /routing scope/);
  assert.match(system, /current observing thread/i);
  assert.match(system, /If a turn contains multiple topics/i);
  assert.match(system, /contextRefs/);
  assert.doesNotMatch(system, /sourceReferences/);
  assert.match(system, /DATE:/);
  assert.doesNotMatch(system, /Incidental media/i);
  assert.doesNotMatch(system, /Do not turn .*liked.*reacted.*image.*painting.* into .*Fact/i);
  assert.doesNotMatch(system, /`summary`: grounded content from the turn/);
});
