import test from 'node:test';
import assert from 'node:assert/strict';

import { loadPromptTemplate } from '../dist/llm/prompt-loader.js';

test('observation extraction prompt exists and describes grounded observations', () => {
  const prompt = loadPromptTemplate('observation_extraction');
  assert.match(prompt.system, /durable memory observations/i);
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
});

test('observing prompt uses generic recall-ready memory guidance', () => {
  const template = loadPromptTemplate('observing');
  const system = template.system;

  assert.match(system, /durable or workflow-relevant/);
  assert.match(system, /Recall-ready writing/);
  assert.match(system, /Derivation style/);
  assert.match(system, /Transform grounded dialogue into concise, self-contained observation conclusions/);
  assert.match(system, /Do not merely restate who said or asked what/);
  assert.match(system, /Do not store speech acts as observations/);
  assert.match(system, /A single turn may produce multiple observations/);
  assert.match(system, /understandable when recalled without the original conversation/);
  assert.match(system, /Prefer explicit subjects over pronouns/);
  assert.match(system, /clear relative time/);
  assert.match(system, /durable, answerable conclusions about what is true, planned, changed, or known/);
  assert.match(system, /Store questions only in `openQuestions`/);
  assert.match(system, /Keep small answerable facts/);
  assert.match(system, /yesterday.*7 May 2023.*last month.*April 2023.*last year.*2022/);
  assert.match(system, /exact date or period is ambiguous/);
  assert.match(system, /Do not invent missing details/);
  assert.match(system, /brief reactions, asides, descriptive details/);
  assert.match(system, /unless they establish a durable state, plan, preference, relationship, decision, recurring interest, or answerable fact/);
  assert.match(system, /transcript events whose only durable content/);
  assert.match(system, /duplicate, ungrounded, or short-lived details.*recurring interest/);
  assert.match(system, /The user prefers concise implementation plans/);
  assert.match(system, /Do not keep questions that have already been answered/);
  assert.match(system, /Category selection/);
  assert.match(system, /Prefer the most specific category over `Fact`/);
  assert.match(system, /stable likes, dislikes, interests, constraints/);
  assert.match(system, /does not fit a more specific category/);
  assert.match(system, /reusable entities and their stable characteristics/);
  assert.match(system, /identity\/profile attributes/);
  assert.match(system, /do not record one-time actions or dialogue participation as `Entity`/);
  assert.match(system, /Thread title/);
  assert.match(system, /clear, concrete, human-readable title/);
  assert.match(system, /key person\/entity\/object plus the concrete subject or activity/);
  assert.match(system, /Prefer 6-14 words/);
  assert.match(system, /Do not use meta labels such as `aside`, `candidate`, `tentative`, `misc`, or `unknown`/);
  assert.match(system, /neutral concrete title/);
  assert.doesNotMatch(system, /Prefer 3-8 words/);
  assert.match(system, /Thread summary/);
  assert.match(system, /refined summary of this observing thread's theme, content, and current state/);
  assert.match(system, /Preserve the meaningful context/);
  assert.match(system, /Prefer synthesis over listing observations or replaying the transcript/);
  assert.match(system, /roughly 1000 characters/);
  assert.doesNotMatch(system, /roughly 500 characters/);
  assert.match(system, /must be complete and must not end with an ellipsis/);
});

test('observing prompt preserves the current observation schema', () => {
  const template = loadPromptTemplate('observing');
  const system = template.system;

  for (const category of ['Preference', 'Fact', 'Decision', 'Entity', 'Concept', 'Other']) {
    assert.match(system, new RegExp(`\\\`${category}\\\``));
  }
  assert.doesNotMatch(system, /"category": "Goal"/);
  assert.doesNotMatch(system, /`Goal`/);
  assert.match(system, /observations/);
  assert.match(system, /observationDelta\.before/);
  assert.match(system, /observationDelta\.after/);
  assert.match(system, /Preserve `id` for existing observations/);
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

  assert.match(system, /topic slices/i);
  assert.match(system, /Identify each slice first, then route each slice/i);
  assert.match(system, /Create a new thread when a source slice introduces a durable subject/i);
  assert.match(system, /Do not append a slice to an existing thread only because/i);
  assert.match(system, /Detect topic shifts by semantic content, not fixed keywords/i);
  assert.match(system, /newThreadTitle/);
  assert.match(system, /clear, concrete, human-readable title/);
  assert.match(system, /key person\/entity\/object plus the concrete subject or activity/);
  assert.match(system, /Prefer 6-14 words/);
  assert.match(system, /Do not use meta labels such as `aside`, `candidate`, `tentative`, `misc`, or `unknown`/);
  assert.match(system, /Gateway only sets the initial title/);
  assert.match(system, /Current turn:/);
  assert.match(system, /sourceSlice/);
  assert.match(system, /routing scope only/);
  assert.match(system, /not a final memory fact/i);
  assert.match(system, /rationale/);
  assert.match(system, /trace\/debug only/);
  assert.match(system, /observer will read .*sourceSlice.*prompt.*response/i);
  assert.doesNotMatch(system, /"updates"/);
  assert.doesNotMatch(system, /"action"/);
  assert.doesNotMatch(system, /"why": "string"/);
  assert.doesNotMatch(system, /Incidental media source-only rule/i);
});

test('observing prompt consumes raw source and emits context refs', () => {
  const template = loadPromptTemplate('observing');
  const system = template.system;

  assert.match(system, /linked observations/);
  assert.match(system, /use the observations as the source facts for this thread/);
  assert.match(system, /Use observation `references` only for provenance and `contextRefs`/);
  assert.match(system, /pending turns, or linked observations/);
  assert.match(system, /raw `prompt` and `response`/);
  assert.match(system, /sourceSlice/);
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
