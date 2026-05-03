import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const labModule = require('../dist/gateway-lab.js');

test('observing lab renders raw locomo turns with date and media captions', () => {
  const turns = labModule.locomoSessionTurns({
    conversation: {
      session_1_date_time: '1:56 pm on 8 May, 2023',
      session_1: [{
        speaker: 'Melanie',
        dia_id: 'D1:12',
        text: 'By the way, take a look at this.',
        blip_caption: 'a photo of a painting of a sunset over a lake',
      }],
    },
  }, 1);

  assert.deepEqual(turns, [{
    turnId: 'D1:12',
    text: 'DATE: 1:56 pm on 8 May, 2023\nMelanie said: "By the way, take a look at this. [shares a photo of a painting of a sunset over a lake]"',
  }]);
});

test('observing lab runs gateway fitting and thread observing', async () => {
  const calls = [];
  const turns = [
    {
      turnId: 'D1:3',
      text: 'DATE: 1:56 pm on 8 May, 2023\nCaroline said: "I joined an LGBTQ support group."',
    },
    {
      turnId: 'D1:7',
      text: 'DATE: 1:56 pm on 8 May, 2023\nCaroline said: "The support group helped me accept myself."',
    },
  ];
  const result = await labModule.runGatewayLab({
    turns,
    pipeline: {
      fit: async ({ pendingTurns, observingThreads }) => {
        calls.push(`fit:${pendingTurns[0].turnId}`);
        return {
          workItems: [{
            ...(observingThreads[0]
              ? { targetThreadId: observingThreads[0].threadId }
              : { targetThreadId: null, newThreadTitle: "Caroline's LGBTQ support group and self-acceptance" }),
            sourceRefs: [{
              turnId: pendingTurns[0].turnId,
              excerpt: pendingTurns[0].text,
            }],
            routingReason: 'The source belongs to the support group thread.',
          }],
          ignoredTurnIds: [],
        };
      },
      observe: async ({ observingContent, sourceRefs }) => {
        calls.push(`observe:${sourceRefs.map((reference) => reference.turnId).join(',')}`);
        return {
          observingContent: {
            title: "Caroline's LGBTQ support group and self-acceptance",
            summary: sourceRefs.map((reference) => reference.excerpt).join(' '),
            observations: observingContent.observations,
            openQuestions: observingContent.openQuestions,
            nextSteps: observingContent.nextSteps,
          },
          contextRefs: sourceRefs.map((reference) => ({
            turnId: reference.turnId,
            summary: reference.excerpt,
          })),
          observationChanges: [],
        };
      },
    },
  });

  assert.deepEqual(calls, [
    'fit:D1:3',
    'observe:D1:3',
    'fit:D1:7',
    'observe:D1:7',
  ]);
  assert.equal(result.threads.length, 1);
  assert.deepEqual(result.epochs[0].workItems[0].sourceRefs[0].turnId, 'D1:3');
  assert.deepEqual(result.threads[0].contextRefs.map((reference) => reference.turnId), ['D1:3', 'D1:7']);
  assert.equal(result.coverage.support, true);
});

test('observing lab applies new thread work items into thread snapshots', async () => {
  const result = await labModule.runGatewayLab({
    turns: [
      { turnId: 'D1:12', text: 'Melanie shared a lake painting.' },
    ],
    pipeline: {
      fit: async ({ pendingTurns }) => ({
        workItems: [{
          targetThreadId: null,
          newThreadTitle: "Melanie's lake sunrise painting and creative outlet",
          sourceRefs: [{
            turnId: pendingTurns[0].turnId,
            excerpt: pendingTurns[0].text,
          }],
          routingReason: 'The source introduces a painting topic.',
        }],
        ignoredTurnIds: [],
      }),
      observe: async ({ observingContent, sourceRefs }) => ({
        observingContent: {
          title: observingContent.title,
          summary: sourceRefs.map((reference) => reference.excerpt).join(' '),
          observations: [{
            id: 'obs-painting',
            text: 'Melanie shared a lake painting.',
            category: 'Fact',
          }],
          openQuestions: [],
          nextSteps: [],
        },
        contextRefs: sourceRefs.map((reference) => ({
          turnId: reference.turnId,
          summary: reference.excerpt,
        })),
        observationChanges: [],
      }),
    },
  });

  assert.equal(result.threads.length, 1);
  assert.equal(result.threads[0].title, "Melanie's lake sunrise painting and creative outlet");
  assert.deepEqual(result.threads[0].contextRefs.map((reference) => reference.turnId), ['D1:12']);
  assert.equal(result.coverage.painting, true);
});
