import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const labModule = require('../dist/gateway-lab.js');

test('observing lab renders raw locomo turns with date and media captions', () => {
  const turns = labModule.locomoTurns({
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
          sessionFragments: [{
            threadId: observingThreads[0].threadId,
            turnIds: [pendingTurns[0].turnId],
            content: pendingTurns[0].text,
            reason: 'The source belongs to the support group thread.',
          }],
        };
      },
      observe: async ({ observingContent, turns }) => {
        calls.push(`observe:${turns.map((turn) => turn.turnId).join(',')}`);
        const content = turns.map((turn) => turn.prompt).join(' ');
        return {
          title: "Caroline's LGBTQ support group and self-acceptance",
          threadMemory: content,
          extractions: observingContent.extractions,
          openQuestions: observingContent.openQuestions,
          nextSteps: observingContent.nextSteps,
          contextRefs: turns.map((turn) => ({
            turnId: turn.turnId,
            summary: turn.prompt,
          })),
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
  assert.deepEqual(result.epochs[0].sessionFragments[0].turnIds, ['D1:3']);
  assert.deepEqual(result.threads[0].contextRefs.map((reference) => reference.turnId), ['D1:3', 'D1:7']);
  assert.equal(result.coverage.support, true);
});

test('observing lab applies session fragments into the session thread', async () => {
  const result = await labModule.runGatewayLab({
    turns: [
      { turnId: 'D1:12', text: 'Melanie shared a lake painting.' },
    ],
    pipeline: {
      fit: async ({ pendingTurns }) => ({
        sessionFragments: [{
          threadId: 'thread-session',
          turnIds: [pendingTurns[0].turnId],
          content: pendingTurns[0].text,
          reason: 'The source introduces a painting topic.',
        }],
      }),
      observe: async ({ observingContent, turns }) => ({
        title: observingContent.title,
        threadMemory: turns.map((turn) => turn.prompt).join(' '),
        extractions: [{
          id: 'lab-extraction-1',
          text: 'Melanie shared a lake painting.',
          category: 'Fact',
          references: ['D1:12'],
        }],
        openQuestions: [],
        nextSteps: [],
        contextRefs: turns.map((turn) => ({
          turnId: turn.turnId,
          summary: turn.prompt,
        })),
      }),
    },
  });

  assert.equal(result.threads.length, 1);
  assert.equal(result.threads[0].title, 'Session observing thread');
  assert.deepEqual(result.threads[0].contextRefs.map((reference) => reference.turnId), ['D1:12']);
  assert.equal(result.coverage.painting, true);
});
