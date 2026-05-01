import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const labModule = require('../dist/gateway-lab.js');

test('gateway lab applies source slice routes to in-memory threads', () => {
  const state = labModule.createGatewayLabState();

  labModule.applyGatewayRoutes(state, [{
    turnId: 'D1:3',
    targetThreadId: null,
    newThreadTitle: "Caroline's LGBTQ support group and self-acceptance",
    sourceSlice: 'I went to a LGBTQ support group yesterday and it was so powerful.',
    rationale: 'This starts a support group thread.',
  }]);
  labModule.applyGatewayRoutes(state, [{
    turnId: 'D1:11',
    targetThreadId: null,
    newThreadTitle: "Caroline's counseling and mental-health career plans",
    sourceSlice: "I'm keen on counseling or working in mental health.",
    rationale: 'This starts a career planning thread.',
  }]);
  labModule.applyGatewayRoutes(state, [{
    turnId: 'D1:12',
    targetThreadId: state.threads[1].threadId,
    sourceSlice: "You'd be a great counselor!",
    rationale: 'This continues the career planning thread.',
  }, {
    turnId: 'D1:12',
    targetThreadId: null,
    newThreadTitle: "Melanie's lake sunrise painting and creative outlet",
    sourceSlice: 'By the way, take a look at this. [shares a photo of a painting of a sunset over a lake]',
    rationale: 'This starts a separate painting thread.',
  }]);

  assert.deepEqual(state.threads.map((thread) => thread.title), [
    "Caroline's LGBTQ support group and self-acceptance",
    "Caroline's counseling and mental-health career plans",
    "Melanie's lake sunrise painting and creative outlet",
  ]);
  assert.deepEqual(state.threads[1].sourceSlices.map((slice) => slice.turnId), ['D1:11', 'D1:12']);
  assert.deepEqual(labModule.expectedTopicCoverage(state), {
    support: true,
    career: true,
    painting: true,
  });
});

test('gateway lab renders raw locomo turns with date and media captions', () => {
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

test('gateway lab runner keeps incidental photo reactions source-only', async () => {
  const turns = labModule.locomoSessionTurns({
    conversation: {
      session_1_date_time: '1:56 pm on 8 May, 2023',
      session_1: [
        {
          speaker: 'Caroline',
          dia_id: 'D1:3',
          text: 'I went to a LGBTQ support group yesterday and it was so powerful.',
        },
        {
          speaker: 'Caroline',
          dia_id: 'D1:5',
          text: 'The transgender stories were so inspiring! I was so happy and thankful for all the support.',
          blip_caption: 'a photo of a dog walking past a wall with a painting of a woman',
        },
        {
          speaker: 'Melanie',
          dia_id: 'D1:6',
          text: "Wow, love that painting! So cool you found such a helpful group. What's it done for you?",
        },
        {
          speaker: 'Caroline',
          dia_id: 'D1:7',
          text: 'The support group has made me feel accepted and given me courage to embrace myself.',
        },
        {
          speaker: 'Caroline',
          dia_id: 'D1:11',
          text: "I'm keen on counseling or working in mental health - I'd love to support those with similar issues.",
        },
        {
          speaker: 'Melanie',
          dia_id: 'D1:12',
          text: "You'd be a great counselor! Your empathy and understanding will really help the people you work with. By the way, take a look at this.",
          blip_caption: 'a photo of a painting of a sunset over a lake',
        },
      ],
    },
  }, 1);

  const result = await labModule.runGatewayLab({
    turns,
    routeGateway: async (threads, pendingTurns) => {
      const turn = pendingTurns[0];
      const support = threads.find((thread) => /support/i.test(thread.title));
      const career = threads.find((thread) => /career/i.test(thread.title));
      if (turn.turnId === 'D1:3') {
        return {
          routes: [{
            turnId: turn.turnId,
            targetThreadId: null,
            newThreadTitle: "Caroline's LGBTQ support group and self-acceptance",
            sourceSlice: 'I went to a LGBTQ support group yesterday and it was so powerful.',
            rationale: 'This starts a support group thread.',
          }],
        };
      }
      if (turn.turnId === 'D1:5') {
        return {
          routes: [{
            turnId: turn.turnId,
            targetThreadId: support.threadId,
            sourceSlice: 'The transgender stories were so inspiring! I was so happy and thankful for all the support.',
            rationale: 'This continues the support group thread.',
          }],
        };
      }
      if (turn.turnId === 'D1:6') {
        return {
          routes: [{
            turnId: turn.turnId,
            targetThreadId: support.threadId,
            sourceSlice: "So cool you found such a helpful group. What's it done for you?",
            rationale: 'This asks about the support group thread.',
          }],
        };
      }
      if (turn.turnId === 'D1:7') {
        return {
          routes: [{
            turnId: turn.turnId,
            targetThreadId: support.threadId,
            sourceSlice: 'The support group has made me feel accepted and given me courage to embrace myself.',
            rationale: 'This continues the support group thread.',
          }],
        };
      }
      if (turn.turnId === 'D1:11') {
        return {
          routes: [{
            turnId: turn.turnId,
            targetThreadId: null,
            newThreadTitle: "Caroline's counseling and mental-health career plans",
            sourceSlice: "I'm keen on counseling or working in mental health.",
            rationale: 'This starts a career planning thread.',
          }],
        };
      }
      return {
        routes: [{
          turnId: turn.turnId,
          targetThreadId: career.threadId,
          sourceSlice: "You'd be a great counselor! Your empathy and understanding will really help the people you work with.",
          rationale: 'This continues the career planning thread.',
        }, {
          turnId: turn.turnId,
          targetThreadId: null,
          newThreadTitle: "Melanie's lake sunrise painting and creative outlet",
          sourceSlice: 'By the way, take a look at this. [shares a photo of a painting of a sunset over a lake]',
          rationale: 'This starts a separate painting thread.',
        }],
      };
    },
  });

  assert.deepEqual(result.coverage, {
    support: true,
    career: true,
    painting: true,
  });
  assert.equal(result.threads.some((thread) => /shared photo|reaction|dog|wall/i.test(thread.title)), false);
  assert.equal(
    result.threads
      .flatMap((thread) => thread.sourceSlices)
      .some((slice) => /love that painting/i.test(slice.sourceSlice)),
    false,
  );
  assert.ok(result.turnRoutes.some((entry) => entry.turnId === 'D1:12' && entry.routes.length === 2));
});
