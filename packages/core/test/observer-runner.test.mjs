import assert from 'node:assert/strict';
import test from 'node:test';

import { hasPendingObserverWork, __testing } from '../dist/observer/runner.js';

const { pendingExtractions, runObserver } = __testing;

test('hasPendingObserverWork waits for threshold on observed root anchors', async () => {
  const client = makeClient({
    extractions: makeExtractions(4, { observed: true }),
  });

  assert.equal(await hasPendingObserverWork({ client, anchorThreshold: 5 }), false);
});

test('hasPendingObserverWork reports pending when incremental threshold is reached', async () => {
  const client = makeClient({
    extractions: makeExtractions(5),
  });

  assert.equal(await hasPendingObserverWork({ client, anchorThreshold: 5 }), true);
});

test('runObserver skips until anchor threshold is reached', async () => {
  const client = makeClient({
    extractions: makeExtractions(4),
  });

  const result = await runObserver({
    client,
    observerName: 'test-observer',
    anchorThreshold: 5,
    observeAnchorImpl: async () => {
      throw new Error('observeAnchorImpl should not be called before threshold');
    },
  });

  assert.deepEqual(result, { observed: 0, skipped: 1 });
});

test('pendingExtractions returns only uncovered extractions', () => {
  const extractions = [
    ...makeExtractions(2, { observed: true }),
    ...makeExtractions(2, { offset: 2 }),
  ];

  assert.deepEqual(
    pendingExtractions('Caroline', extractions).map((extraction) => extraction.id),
    ['pending-3', 'pending-4'],
  );
});

function makeClient({ extractions }) {
  return {
    extractionTable: {
      list: async () => extractions,
    },
    observationContextTable: {
      list: async () => [],
    },
  };
}

function makeExtractions(count, options = {}) {
  const offset = options.offset ?? 0;
  return Array.from({ length: count }, (_, index) => ({
    id: `pending-${offset + index + 1}`,
    text: `Caroline memory ${offset + index + 1}`,
    context: null,
    anchors: ['Entity: Caroline'],
    turnRefs: [`turn:${offset + index + 1}`],
    observationIds: [],
    observedRootAnchors: options.observed ? ['Caroline'] : [],
  }));
}
