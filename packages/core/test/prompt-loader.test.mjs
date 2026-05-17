import test from 'node:test';
import assert from 'node:assert/strict';

import { loadDomainPrompt, loadGatewayDomainPrompt } from '../dist/llm/domain-prompt.js';
import { loadPromptTemplate } from '../dist/llm/prompt-loader.js';

test('extraction extraction prompt exists and describes grounded extractions', () => {
  const prompt = loadPromptTemplate('extraction_extraction');
  assert.match(prompt.system, /durable memory extractions/i);
  assert.match(prompt.system, /domain-specific extraction guidance/i);
  assert.match(prompt.system, /domain_prompt/);
  assert.match(prompt.userTemplate, /recentContext/);
  assert.match(prompt.userTemplate, /up to three earlier raw turns/);
  assert.match(prompt.userTemplate, /do not extract extractions from `recentContext` by itself/);
  assert.match(prompt.userTemplate, /input_json/);
});

test('extraction review prompt only removes extractions', () => {
  const prompt = loadPromptTemplate('extraction_review');
  assert.match(prompt.system, /remove extractions/i);
  assert.doesNotMatch(prompt.system, /create new extractions/i);
});

test('thread preparation prompt enforces two extractions for new threads', () => {
  const prompt = loadPromptTemplate('thread_preparation');
  assert.match(prompt.system, /at least two related extractions/i);
  assert.match(prompt.system, /memory-get/i);
  assert.doesNotMatch(prompt.system, /memory_get/i);
  assert.match(prompt.userTemplate, /reviewedExtractions\[\]\.id/);
  assert.match(prompt.userTemplate, /Do not put candidate memory ids/);
});

test('memory recaller prompt composes recall context with a soft budget', () => {
  const prompt = loadPromptTemplate('memory_recaller');

  assert.match(prompt.system, /memory recall agent/i);
  assert.match(prompt.system, /different agents, sessions, and contexts/i);
  assert.match(prompt.system, /integrate the relevant memories/i);
  assert.match(prompt.system, /filter out unrelated content/i);
  assert.match(prompt.system, /main agent should see/i);
  assert.match(prompt.system, /identify the query intent/i);
  assert.match(prompt.system, /General rules/);
  assert.match(prompt.system, /Do not answer the query/);
  assert.match(prompt.system, /Prepare memory for the main agent/);
  assert.match(prompt.system, /Do not compute, finalize, or decide the answer/);
  assert.match(prompt.system, /especially time expressions/);
  assert.match(prompt.system, /compress context that is not useful or unrelated to the query/);
  assert.match(prompt.system, /Do not invent facts or make inferences/);
  assert.match(prompt.system, /candidate memories conflict/);
  assert.match(prompt.system, /soft target/);
  assert.match(prompt.system, /preserve relevant memory details and accuracy/);
  assert.match(prompt.system, /Factual recall/);
  assert.match(prompt.system, /Judgment recall/);
  assert.match(prompt.system, /gather directly relevant facts around the query/);
  assert.match(prompt.system, /Keep concrete values and relevant context/);
  assert.match(prompt.system, /compatible parts from multiple candidates/);
  assert.match(prompt.system, /keep distinct subjects, events, times, or conditions separate/);
  assert.match(prompt.system, /Do not replace concrete facts with uncertainty/);
  assert.match(prompt.system, /judgment, match, preference, likelihood, comparison, or inference based on memory/);
  assert.match(prompt.system, /positive and negative memory signals and details/);
  assert.match(prompt.system, /limits, uncertainty, or mismatches/);
  assert.match(prompt.system, /Do not answer the judgment/);
  assert.match(prompt.userTemplate, /Budget:/);
  assert.doesNotMatch(prompt.userTemplate, /General rules/);
  assert.doesNotMatch(prompt.userTemplate, /Factual recall/);
  assert.match(prompt.userTemplate, /Return refs for the memory candidates used to write the content/);
  assert.match(prompt.userTemplate, /Return JSON only/);
  assert.match(prompt.userTemplate, /"refs"/);
});

test('thread observing prompt organizes entity extractions by questions', () => {
  const prompt = loadPromptTemplate('thread_observing');

  assert.match(prompt.system, /observer that rewrites a cross-session curated observation document/i);
  assert.match(prompt.system, /root anchor is fixed/);
  assert.match(prompt.system, /heading is an observation context node/);
  assert.match(prompt.system, /cross-session curated observation document/);
  assert.match(prompt.system, /not an extraction copy/);
  assert.match(prompt.system, /broad observed scope to narrower observed scope/);
  assert.match(prompt.system, /child heading must narrow, explain, specialize, or update its parent heading's scope/);
  assert.match(prompt.system, /same observed scope/);
  assert.match(prompt.system, /overall meaning, role, state, purpose, or development/);
  assert.match(prompt.system, /Non-leaf headings may use who, what, why, or how framing/);
  assert.match(prompt.system, /choose titles based on the actual subject and scope/);
  assert.match(prompt.system, /Leaf headings should summarize their own remembered content naturally/);
  assert.match(prompt.system, /3-8 words/);
  assert.match(prompt.system, /200-500 characters/);
  assert.match(prompt.system, /4-10 words/);
  assert.match(prompt.system, /100-500 characters/);
  assert.match(prompt.system, /leaf heading has no child headings and must declare refs/);
  assert.match(prompt.system, /Preserve existing heading ids/);
  assert.match(prompt.system, /delete: true/);
  assert.match(prompt.system, /Use only `##` and `###` headings/);
  assert.match(prompt.system, /<!-- id:/);
  assert.match(prompt.system, /refs: \[extraction-id/);
  assert.match(prompt.userTemplate, /Root anchor:/);
  assert.match(prompt.userTemplate, /Current observing document:/);
  assert.match(prompt.userTemplate, /Extraction units:/);
});

test('chat domain prompt provides category guidance without observing workflow schema', () => {
  const template = loadPromptTemplate('chat');
  const system = template.system;

  assert.match(system, /Chat memory categories/);
  assert.match(system, /Observing thread definition/);
  assert.match(system, /subject observing thread tracks one coherent subject that can develop over time/);
  assert.match(system, /narrower than the whole conversation and more stable than a single message/);
  assert.match(system, /Route a new span to a subject thread only when it updates, answers, clarifies, corrects, supports, or directly continues that subject/);
  assert.doesNotMatch(system, /Use `update` plus `add`/);
  assert.doesNotMatch(system, /Chat filtering/);
  assert.doesNotMatch(system, /Extraction granularity/);
  assert.match(system, /Use categories only to organize threadMemory/);
  assert.match(system, /First write the memory content, then choose one or more categories/);
  assert.match(system, /Store useful conclusions, answers, states, plans, preferences, or reusable facts, not conversation acts/);
  assert.match(system, /Fold chat evidence into the relevant existing context/);
  assert.doesNotMatch(system, /greetings, small talk, filler/);
  assert.doesNotMatch(system, /pure questions, temporary status updates/);
  assert.doesNotMatch(system, /descriptive details, transition remarks, pure questions, one-off actions/);
  assert.match(system, /stable or recurring like/);
  assert.match(system, /explicit, non-trivial, and useful beyond the current conversation/);
  assert.doesNotMatch(system, /Prefer `Fact` for one-time events, described objects, and answerable details/);
  assert.doesNotMatch(system, /Prefer `Decision` when the main signal is what someone plans, chooses, or commits to do/);
  assert.doesNotMatch(system, /Prefer `Preference` only when the signal is stable or recurring/);
  assert.doesNotMatch(system, /Prefer `Entity` only for stable attributes, not one-time events involving the entity/);
  assert.match(system, /When chat memory contains a time expression/);
  assert.match(system, /normalize it to absolute time using grounded context anchors when possible/);
  assert.doesNotMatch(system, /Extract useful absolute time from context when available/);
  assert.doesNotMatch(system, /memory-get/);
  assert.doesNotMatch(system, /If an extraction or `contextRefs\.summary` would still contain unresolved relative time/);
  assert.match(system, /useful memory that does not fit above/);
  assert.doesNotMatch(system, /Extraction definition/);
  assert.doesNotMatch(system, /Thread title/);
  assert.doesNotMatch(system, /Thread summary/);
  assert.doesNotMatch(system, /memory_get/);
  assert.doesNotMatch(system, /extractionChanges/);
  assert.doesNotMatch(system, /extractionDelta/);
  assert.doesNotMatch(system, /Return exactly one JSON object/);
});

test('chat domain prompt sections are loaded by observing stage', () => {
  const gateway = loadGatewayDomainPrompt('chat');
  const observing = loadDomainPrompt('chat');

  assert.match(gateway, /Observing thread definition/);
  assert.match(gateway, /Same vs separate routing/);
  assert.match(gateway, /Route spans to the session thread when they introduce a different subject/);
  assert.doesNotMatch(gateway, /Chat memory categories/);
  assert.doesNotMatch(gateway, /`Fact`/);
  assert.doesNotMatch(gateway, /`Preference`/);
  assert.doesNotMatch(gateway, /Extraction granularity/);

  assert.match(observing, /Chat memory categories/);
  assert.match(observing, /`Fact`/);
  assert.match(observing, /`Preference`/);
  assert.doesNotMatch(observing, /Same vs separate routing/);
  assert.doesNotMatch(observing, /Extraction granularity/);
  assert.doesNotMatch(observing, /Chat filtering/);
  assert.doesNotMatch(observing, /memory-get/);
});

test('thread observing prompt uses generic recall-ready memory guidance', () => {
  const template = loadPromptTemplate('thread_extracting');
  const system = template.system;

  assert.doesNotMatch(system, /Extraction state: the complete current list of extractions this thread should keep/);
  assert.match(system, /Memory unit concept/);
  assert.match(system, /A memory unit is centered on one primary remembered subject/);
  assert.match(system, /can be named in a short phrase/);
  assert.doesNotMatch(system, /can work as the unit's short title/);
  assert.match(system, /\[Context\]` captures source context/);
  assert.match(system, /explains why the extraction was mentioned/);
  assert.match(system, /what local situation it belongs to/);
  assert.match(system, /\[Extraction\]` captures the remembered content/);
  assert.match(system, /Memory unit boundaries are based on the primary remembered subject/);
  assert.match(system, /extractor that rewrites one session extraction document from conversation turns/);
  assert.match(system, /Use `memory` as the current document/);
  assert.match(system, /fold in `newTurns\[\]`/);
  assert.doesNotMatch(system, /existingThreadMemory/);
  assert.match(system, /Return the complete updated Markdown document/);
  assert.match(system, /# <thread title>/);
  assert.match(system, /## Summary/);
  assert.match(system, /## Extractions/);
  assert.doesNotMatch(system, /Routing has already selected the fragments for this thread/);
  assert.doesNotMatch(system, /routed fragments/);
  assert.doesNotMatch(system, /Fragment:/);
  assert.doesNotMatch(system, /rewrite clear relative dates or periods into absolute dates or periods/);
  assert.doesNotMatch(system, /`yesterday`, `tomorrow`, `last week`, `last month`, and `last year`/);
  assert.doesNotMatch(system, /Fallback inspection/);
  assert.doesNotMatch(system, /batches of up to 5/);
  assert.doesNotMatch(system, /starting from the first sourceRef/);
  assert.doesNotMatch(system, /Include useful subject, time, place, object, status, cause, or purpose/);
  assert.doesNotMatch(system, /Filter out greetings, thanks, filler, transcript mechanics/);
  assert.match(system, /Update existing memory units first when new turn content directly develops/);
  assert.match(system, /the unit's primary subject or adds useful context without breaking its boundaries/);
  assert.match(system, /Shared people, time, mood, or conversation adjacency alone is not enough/);
  assert.match(system, /Add a new memory unit when new turn content should be remembered/);
  assert.match(system, /does not fit an existing unit as an update/);
  assert.match(system, /append new units at the end to keep existing unit order stable/);
  assert.match(system, /Remove an existing memory unit when it is outdated, wrong, or duplicated/);
  assert.match(system, /update the unit instead of removing it/);
  assert.match(system, /When remembered content contains a time expression/);
  assert.match(system, /normalize it to absolute time using grounded context anchors when possible/);
  assert.match(system, /including key source wording/);
  assert.match(system, /what any response, judgment, or feedback is about/);
  assert.doesNotMatch(system, /Granularity:/);
  assert.doesNotMatch(system, /memory unit purpose/);
  assert.match(system, /Memory anchors/);
  assert.match(system, /1-3 memory anchors/);
  assert.match(system, /short 1-5 word phrase/);
  assert.match(system, /without changing the unit's content or boundary/);
  assert.match(system, /Anchor names/);
  assert.doesNotMatch(system, /Memory categories/);
  assert.doesNotMatch(system, /Domain guidance/);
  assert.doesNotMatch(system, /domain_prompt/);
  assert.doesNotMatch(system, /Category selection:/);
  assert.doesNotMatch(system, /Prefer the most specific category over `Fact` when an extraction describes/);
  assert.doesNotMatch(system, /Extraction definition/);
  assert.doesNotMatch(system, /Recall-ready writing/);
  assert.doesNotMatch(system, /Derivation style/);
  assert.doesNotMatch(system, /Fact quality/);
  assert.match(system, /Thread title/);
  assert.doesNotMatch(system, /clear, concrete label for the stable thread subject/);
  assert.doesNotMatch(system, /key person\/entity\/object plus concrete topic, activity, artifact, plan, relationship, or state/);
  assert.doesNotMatch(system, /stable thread subject, not the latest turn/);
  assert.doesNotMatch(system, /stay neutral and concrete without overstating long-term meaning/);
  assert.doesNotMatch(system, /meta labels/);
  assert.doesNotMatch(system, /Prefer 6-14 words/);
  assert.match(system, /Prefer 3-8 words/);
  assert.match(system, /Summary/);
  assert.doesNotMatch(system, /Thread state/);
  assert.doesNotMatch(system, /contextRefs/);
  assert.doesNotMatch(system, /Include a `contextRef` for every new turn whose information is used in `threadMemory`/);
  assert.doesNotMatch(system, /clarifies ownership, time, attribution, or status/);
  assert.doesNotMatch(system, /openQuestions/);
  assert.doesNotMatch(system, /nextSteps/);
  assert.doesNotMatch(system, /roughly 1000 characters/);
  assert.doesNotMatch(system, /roughly 500 characters/);
});

test('observing prompt preserves the current extraction schema', () => {
  const template = loadPromptTemplate('thread_extracting');
  const system = template.system;

  for (const anchor of ['Preference', 'Fact', 'Decision', 'Entity']) {
    assert.match(system, new RegExp(anchor));
  }
  assert.doesNotMatch(system, /`Concept`/);
  assert.doesNotMatch(system, /`Other`/);
  assert.doesNotMatch(system, /"category": "Goal"/);
  assert.doesNotMatch(system, /`Goal`/);
  assert.match(system, /thread memory/i);
  assert.match(system, /Memory unit/);
  assert.match(system, /<!-- refs: \[turn:x, turn:y\] -->/);
  assert.match(system, /must start with metadata/);
  assert.match(system, /1-3 memory anchor lines/);
  assert.match(system, /\[Entity\] Alex/);
  assert.match(system, /\[Decision\] onboarding focus/);
  assert.match(system, /\[Context\]/);
  assert.match(system, /\[Extraction\]/);
  assert.match(system, /Alex asked Jamie what they wanted to focus on next quarter/);
  assert.match(system, /The team compared Monday and Thursday as possible planning meeting days/);
  assert.doesNotMatch(system, /Put the remembered content after the metadata line/);
  assert.match(system, /A memory unit should have 1-3 memory anchors/);
  assert.match(system, /Existing units already have metadata/);
  assert.doesNotMatch(system, /updates:/);
  assert.doesNotMatch(system, /increment its `updates` count/);
  assert.match(system, /new conversation turns to fold into memory/);
  assert.match(system, /Preserve memory as losslessly as possible/);
  assert.match(system, /do not invent facts or infer beyond what was said/);
  assert.match(system, /Put remembered content in `\[Extraction\]`/);
  assert.match(system, /use `\[Context\]` for why it was mentioned/);
  assert.match(system, /keep the target and key wording of responses, judgments, reactions, or feedback in `\[Extraction\]`/);
  assert.match(system, /One new turn may affect multiple memory units/);
  assert.match(system, /the same context may be added to more than one unit/);
  assert.match(system, /only when it supports each unit's extraction/);
  assert.match(system, /Each memory unit's refs must be the specific `newTurns\[\]\.turnId` values/);
  assert.match(system, /existing unit refs that support that unit/);
  assert.match(system, /do not copy unrelated turn ids/);
  assert.match(system, /line containing exactly `----`/);
  assert.doesNotMatch(system, /^  \s*`\[Category/m);
  assert.doesNotMatch(system, /Refs: \[/);
  assert.doesNotMatch(system, /never remove the `Refs:` line/);
  assert.doesNotMatch(system, /Update at most 5 existing memory units/);
  assert.doesNotMatch(system, /Add at most 2 new memory units/);
  assert.doesNotMatch(system, /Do not return JSON/);
  assert.doesNotMatch(system, /"extractionChanges"/);
  assert.doesNotMatch(system, /call `memory-get`/);
  assert.doesNotMatch(system, /visible turn ids/);
  assert.doesNotMatch(system, /observing snapshot details/);
  assert.doesNotMatch(system, /existing extraction details/);
  assert.doesNotMatch(system, /Id usage/);
  assert.doesNotMatch(system, /observingContent\.extractions/);
  assert.doesNotMatch(system, /extraction rows, or extraction ids/);
  assert.doesNotMatch(system, /"extractions": \[/);
  assert.doesNotMatch(system, /Keep unresolved conflicts in `openQuestions`/);
  assert.doesNotMatch(system, /extractionConsolidation/);
  assert.doesNotMatch(system, /extractionDelta/);
  assert.doesNotMatch(system, /observingContentUpdate/);
  assert.doesNotMatch(system, /whyRelated/);
  assert.doesNotMatch(system, /memoryDelta\.before/);
  assert.doesNotMatch(system, /sourceRefs/);
  assert.doesNotMatch(system, /excerpt/);
  assert.doesNotMatch(system, /fragments/);
});

test('observing gateway prompt uses session and subject threads', () => {
  const template = loadPromptTemplate('extracting_gateway');
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
  const template = loadPromptTemplate('extracting_gateway');
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

test('observing prompt uses raw turns and returns thread memory document', () => {
  const template = loadPromptTemplate('thread_extracting');
  const system = template.system;

  assert.match(system, /newTurns/);
  assert.doesNotMatch(system, /memory-get/);
  assert.doesNotMatch(system, /memory_get/);
  assert.match(system, /Use `memory` as the current document/);
  assert.match(system, /Return only the complete thread memory Markdown document/);
  assert.match(system, /Do not wrap the output in code fences, JSON, or explanations/);
  assert.match(system, /one `# <thread title>`/);
  assert.match(system, /one `## Summary`/);
  assert.match(system, /one `## Extractions`/);
  assert.doesNotMatch(system, /extraction rows, or extraction ids/);
  assert.doesNotMatch(system, /contextRefs/);
  assert.doesNotMatch(system, /sourceReferences/);
  assert.doesNotMatch(system, /Only request visible turn ids from `newTurns\[\]\.turnId`/);
  assert.doesNotMatch(system, /sourceRefs/);
  assert.doesNotMatch(system, /excerpt/);
  assert.doesNotMatch(system, /fragments/);
  assert.doesNotMatch(system, /DATE:/);
  assert.doesNotMatch(system, /Incidental media/i);
  assert.doesNotMatch(system, /Do not turn .*liked.*reacted.*image.*painting.* into .*Fact/i);
  assert.doesNotMatch(system, /`summary`: grounded content from the turn/);
});
