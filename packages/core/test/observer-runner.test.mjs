import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { hasPendingObserverWork, __testing } from '../dist/observer/runner.js';
import { observeAnchor } from '../dist/llm/observing.js';

const { getObserverWorkStatus, runObserver } = __testing;

test('observe queue groups by entity anchor and replaces duplicate extraction rows', async () => {
  const { enqueueChanges } = await import('../dist/observer/queue.js');
  const first = extractionRow('ex-1', ['Entity: Caroline'], 'old text');
  const latest = extractionRow('ex-1', ['Entity: Caroline'], 'latest text');
  const queue = enqueueChanges({ anchors: [] }, [{ type: 'upsert', extraction: first }]);
  const next = enqueueChanges(queue, [{ type: 'upsert', extraction: latest }]);

  assert.equal(next.anchors.length, 1);
  assert.equal(next.anchors[0].key, 'caroline');
  assert.equal(next.anchors[0].extractionChanges.length, 1);
  assert.equal(next.anchors[0].extractionChanges[0].extraction.text, 'latest text');
});

test('observe queue preserves old bucket when extraction anchor changes', async () => {
  const { enqueueChanges } = await import('../dist/observer/queue.js');
  const oldRow = extractionRow('ex-1', ['Entity: Caroline'], 'old');
  const newRow = extractionRow('ex-1', ['Entity: Melanie'], 'new');
  const queue = enqueueChanges({ anchors: [] }, [{ type: 'upsert', extraction: oldRow }]);
  const next = enqueueChanges(queue, [{ type: 'upsert', extraction: newRow }]);

  assert.deepEqual(next.anchors.map((bucket) => bucket.key), ['caroline', 'melanie']);
  assert.equal(next.anchors[0].extractionChanges[0].extraction.text, 'new');
  assert.equal(next.anchors[1].extractionChanges[0].extraction.text, 'new');
});

test('observe queue batches and acks one anchor bucket', async () => {
  const { enqueueChanges, readyBucket, ackBucket } = await import('../dist/observer/queue.js');
  let queue = { anchors: [] };
  for (let index = 0; index < 9; index += 1) {
    queue = enqueueChanges(queue, [{
      type: 'upsert',
      extraction: extractionRow(`ex-${index}`, ['Entity: Caroline'], `text ${index}`),
    }]);
  }

  const bucket = readyBucket(queue, { threshold: 8, batchSize: 4, finalize: false });
  assert.equal(bucket.anchor, 'Caroline');
  assert.equal(bucket.extractionChanges.length, 4);

  const acked = ackBucket(queue, bucket.key, bucket.extractionChanges.map((change) => change.extraction.id));
  assert.equal(acked.anchors[0].extractionChanges.length, 5);
});

test('hasPendingObserverWork waits for threshold without advancing baseline', async () => {
  const client = makeClient({
    extractions: makeExtractions(4),
  });

  assert.equal(await hasPendingObserverWork({ client, baselineVersion: 0, anchorThreshold: 5 }), false);
  assert.deepEqual(
    await getObserverWorkStatus({ client, baselineVersion: 0, anchorThreshold: 5 }),
    { changed: true, pending: false, groupCount: 1, baselineVersion: 1 },
  );
});

test('hasPendingObserverWork reports pending when incremental threshold is reached', async () => {
  const client = makeClient({
    extractions: makeExtractions(5),
  });

  assert.equal(await hasPendingObserverWork({ client, baselineVersion: 0, anchorThreshold: 5 }), true);
});

test('getObserverWorkStatus advances baseline when delta has no eligible entity anchors', async () => {
  const client = makeClient({
    extractions: makeExtractions(2, { anchors: ['Fact: support group'] }),
  });

  assert.deepEqual(
    await getObserverWorkStatus({ client, baselineVersion: 0, anchorThreshold: 5 }),
    { changed: true, pending: false, groupCount: 0, baselineVersion: 1 },
  );
});

test('getObserverWorkStatus sees below-threshold work during finalize', async () => {
  const client = makeClient({
    extractions: makeExtractions(4),
  });

  assert.deepEqual(
    await getObserverWorkStatus({ client, baselineVersion: 0, anchorThreshold: 5, finalize: true }),
    { changed: true, pending: true, groupCount: 1, baselineVersion: 1 },
  );
});

test('runObserver skips until anchor threshold is reached', async () => {
  const client = makeClient({
    extractions: makeExtractions(4),
  });

  const result = await runObserver({
    client,
    observerName: 'test-observer',
    baselineVersion: 0,
    anchorThreshold: 5,
    observeAnchorImpl: async () => {
      throw new Error('observeAnchorImpl should not be called before threshold');
    },
  });

  assert.deepEqual(result, { observed: 0, skipped: 1, baselineVersion: 0 });
});

test('runObserver finalizes pending extractions below threshold', async (t) => {
  await useMockHome(t, 'muninn-observer-finalize-');
  let observedInput = null;
  const client = makeClient({
    extractions: makeExtractions(4),
  });

  const result = await runObserver({
    client,
    observerName: 'test-observer',
    baselineVersion: 0,
    anchorThreshold: 5,
    finalize: true,
    observeAnchorImpl: async (input) => {
      observedInput = input;
      return {
        title: 'Caroline',
        sections: [{
          level: 2,
          heading: 'Who is Caroline?',
          observingPath: 'Caroline / Who is Caroline?',
          sourceRefs: [],
          expandRefs: [],
          body: '',
          children: input.extractions.map((extraction) => ({
            level: 3,
            heading: extraction.id,
            observingPath: `Caroline / Who is Caroline? / ${extraction.id}`,
            sourceRefs: [extraction.id],
            expandRefs: [],
            body: `Caroline has pending memory ${extraction.id}.\n\n- [${extraction.id}] ${extraction.text}`,
            children: [],
          })),
        }],
      };
    },
  });

  assert.deepEqual(result, { observed: 1, skipped: 0, baselineVersion: 1 });
  assert.deepEqual(observedInput.extractions.map((extraction) => extraction.id), [
    'pending-1',
    'pending-2',
    'pending-3',
    'pending-4',
  ]);
});

test('runObserver renders existing leaf refs from observation rows', async () => {
  let observedInput = null;
  const client = makeClient({
    contexts: [
      {
        id: 'Caroline / Who is Caroline?',
        observingPath: 'Caroline / Who is Caroline?',
        parentId: null,
        position: 0,
        content: 'Caroline overview.',
        observer: 'test-observer',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
      {
        id: 'Caroline / Who is Caroline? / Support group',
        observingPath: 'Caroline / Who is Caroline? / Support group',
        parentId: 'Caroline / Who is Caroline?',
        position: 0,
        content: 'Caroline attended a support group.',
        observer: 'test-observer',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
    ],
    observations: [{
      id: 'Caroline / Who is Caroline? / Support group',
      observingPath: 'Caroline / Who is Caroline? / Support group',
      text: 'Caroline attended a support group.',
      vector: [],
      extractionRefs: ['extraction:old'],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    }],
    extractions: [{ ...makeExtractions(1)[0], observationPaths: ['Caroline / Who is Caroline? / Support group'] }],
  });

  await runObserver({
    client,
    observerName: 'test-observer',
    baselineVersion: 0,
    anchorThreshold: 5,
    finalize: true,
    observeAnchorImpl: async (input) => {
      observedInput = input;
      return {
        title: 'Caroline',
        sections: [{
          level: 2,
          heading: 'Who is Caroline?',
          observingPath: 'Caroline / Who is Caroline?',
          sourceRefs: [],
          expandRefs: [],
          body: '',
          children: [{
            level: 3,
            heading: 'Support group',
            observingPath: 'Caroline / Who is Caroline? / Support group',
            sourceRefs: ['extraction:old'],
            expandRefs: [],
            body: '',
            children: [],
          }],
        }],
      };
    },
  });

  assert.match(observedInput.outline, /leaf: Caroline \/ Who is Caroline\? \/ Support group/);
  assert.match(observedInput.observedDocument, /### Support group <!-- path: Caroline \/ Who is Caroline\? \/ Support group -->/);
  assert.match(observedInput.observedDocument, /Caroline attended a support group/);
  assert.doesNotMatch(observedInput.observedDocument, /Source extractions:/);
});

test('runObserver removes changed extraction refs from existing leaf hints', async () => {
  let observedInput = null;
  const client = makeClient({
    contexts: [
      {
        id: 'Caroline / Who is Caroline?',
        observingPath: 'Caroline / Who is Caroline?',
        parentId: null,
        position: 0,
        content: 'Caroline overview.',
        observer: 'test-observer',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
      {
        id: 'Caroline / Who is Caroline? / Support group',
        observingPath: 'Caroline / Who is Caroline? / Support group',
        parentId: 'Caroline / Who is Caroline?',
        position: 0,
        content: 'Caroline attended a support group.',
        observer: 'test-observer',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
    ],
    observations: [{
      id: 'Caroline / Who is Caroline? / Support group',
      observingPath: 'Caroline / Who is Caroline? / Support group',
      text: 'Caroline attended a support group.',
      vector: [],
      extractionRefs: ['extraction:old', 'pending-1'],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    }],
    extractions: [{ ...makeExtractions(1)[0], observationPaths: ['Caroline / Who is Caroline? / Support group'] }],
  });

  await runObserver({
    client,
    observerName: 'test-observer',
    baselineVersion: 0,
    anchorThreshold: 5,
    finalize: true,
    observeAnchorImpl: async (input) => {
      observedInput = input;
      return {
        title: 'Caroline',
        sections: [{
          level: 2,
          heading: 'Who is Caroline?',
          observingPath: 'Caroline / Who is Caroline?',
          sourceRefs: [],
          expandRefs: [],
          body: '',
          children: [{
            level: 3,
            heading: 'Support group',
            observingPath: 'Caroline / Who is Caroline? / Support group',
            sourceRefs: ['extraction:old', input.extractions[0].id],
            expandRefs: [],
            body: '',
            children: [],
          }],
        }],
      };
    },
  });

  assert.match(observedInput.observedDocument, /Support group <!-- path: Caroline \/ Who is Caroline\? \/ Support group -->/);
  assert.match(observedInput.observedDocument, /Caroline attended a support group/);
  assert.doesNotMatch(observedInput.observedDocument, /pending-1/);
  assert.deepEqual(observedInput.extractions.map((extraction) => extraction.id), ['pending-1']);
});

test('runObserver sends full outline but only linked rewrite content', async () => {
  let observedInput = null;
  const client = makeClient({
    contexts: existingCarolineContexts(),
    observations: [
      observationRow('Caroline / Support / Support group', 'Caroline / Support / Support group', ['pending-1']),
      observationRow('Caroline / Art / Painting', 'Caroline / Art / Painting', ['extraction:painting']),
    ],
    extractions: [
      {
        ...extractionRow('pending-1', ['Entity: Caroline'], 'Caroline updated support group details.'),
        observationPaths: ['Caroline / Support / Support group'],
      },
    ],
  });

  await runObserver({
    client,
    observerName: 'test-observer',
    baselineVersion: 0,
    anchorThreshold: 5,
    finalize: true,
    observeAnchorImpl: async (input) => {
      observedInput = input;
      return {
        title: 'Caroline',
        sections: [{
          level: 2,
          heading: 'Support',
          observingPath: 'Caroline / Support',
          sourceRefs: [],
          expandRefs: [],
          body: '',
          children: [{
            level: 3,
            heading: 'Support group',
            observingPath: 'Caroline / Support / Support group',
            sourceRefs: ['pending-1'],
            expandRefs: [],
            body: '',
            children: [],
          }],
        }],
      };
    },
  });

  assert.match(observedInput.outline, /leaf: Caroline \/ Support \/ Support group/);
  assert.match(observedInput.outline, /leaf: Caroline \/ Art \/ Painting/);
  assert.match(observedInput.observedDocument, /Support group/);
  assert.match(observedInput.observedDocument, /Painting <!-- path: Caroline \/ Art \/ Painting -->/);
  assert.doesNotMatch(observedInput.observedDocument, /Caroline painted a landscape/);
  assert.deepEqual(observedInput.extractions.map((extraction) => extraction.status), ['changed']);
});

test('runObserver preserves sibling branches outside returned subtree', async (t) => {
  await useMockHome(t, 'muninn-observer-preserve-sibling-');
  const client = makeClient({
    contexts: existingCarolineContexts(),
    observations: [
      observationRow('support-leaf', 'Caroline / Support / Support group', ['pending-1']),
      observationRow('painting-leaf', 'Caroline / Art / Painting', ['extraction:painting']),
    ],
    extractions: [
      {
        ...extractionRow('pending-1', ['Entity: Caroline'], 'Caroline updated support group details.'),
        observationPaths: ['Caroline / Support / Support group'],
      },
    ],
  });

  await runObserver({
    client,
    observerName: 'test-observer',
    baselineVersion: 0,
    anchorThreshold: 5,
    finalize: true,
    observeAnchorImpl: async () => ({
      title: 'Caroline',
      sections: [{
        level: 2,
        heading: 'Support',
        observingPath: 'Caroline / Support',
        sourceRefs: [],
        expandRefs: [],
        body: '',
        rewritten: true,
        children: [{
          level: 3,
          heading: 'Support group',
          observingPath: 'Caroline / Support / Support group',
          sourceRefs: ['pending-1'],
          expandRefs: [],
          body: 'Caroline updated support group details.\n\n- [pending-1] Caroline updated support group details.',
          children: [],
        }],
      }],
    }),
  });

  assert.equal(client.writes.deletedObservationIds.includes('Caroline / Art / Painting'), false);
  assert.equal(client.writes.observationContexts.some((row) => row.id === 'Caroline / Art / Painting'), false);
});

test('runObserver deletes omitted descendants inside a returned subtree scope', async (t) => {
  await useMockHome(t, 'muninn-observer-delete-descendants-');
  const siblingPath = 'Caroline / Support / Family';
  const client = makeClient({
    contexts: [
      ...existingCarolineContexts(),
      {
        id: siblingPath,
        observingPath: siblingPath,
        parentId: 'Caroline / Support',
        position: 1,
        content: 'Caroline has family support.',
        observer: 'test-observer',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
    ],
    observations: [
      observationRow('Caroline / Support / Support group', 'Caroline / Support / Support group', ['pending-1']),
      observationRow(siblingPath, siblingPath, ['extraction:family']),
    ],
    extractions: [
      {
        ...extractionRow('pending-1', ['Entity: Caroline'], 'Caroline updated support group details.'),
        observationPaths: ['Caroline / Support / Support group'],
      },
    ],
  });

  await runObserver({
    client,
    observerName: 'test-observer',
    baselineVersion: 0,
    anchorThreshold: 5,
    finalize: true,
    observeAnchorImpl: async () => ({
      title: 'Caroline',
      sections: [{
        level: 2,
        heading: 'Support',
        observingPath: 'Caroline / Support',
        sourceRefs: [],
        expandRefs: [],
        body: '',
        rewritten: true,
        children: [{
          level: 3,
          heading: 'Support group',
          observingPath: 'Caroline / Support / Support group',
          sourceRefs: ['pending-1'],
          expandRefs: [],
          body: 'Caroline updated support group details.\n\n- [pending-1] Caroline updated support group details.',
          children: [],
        }],
      }],
    }),
  });

  assert.equal(client.writes.deletedContextIds.includes(siblingPath), true);
  assert.equal(client.writes.deletedObservationIds.includes(siblingPath), true);
});

test('runObserver keeps heading-only existing descendants under a rewritten parent', async () => {
  const siblingPath = 'Caroline / Support / Family';
  const client = makeClient({
    contexts: [
      ...existingCarolineContexts(),
      {
        id: siblingPath,
        observingPath: siblingPath,
        parentId: 'Caroline / Support',
        position: 1,
        content: 'Caroline has family support.',
        observer: 'test-observer',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
    ],
    observations: [
      observationRow('Caroline / Support / Support group', 'Caroline / Support / Support group', ['pending-1']),
      observationRow(siblingPath, siblingPath, ['extraction:family']),
    ],
    extractions: [
      {
        ...extractionRow('pending-1', ['Entity: Caroline'], 'Caroline updated support group details.'),
        observationPaths: ['Caroline / Support / Support group'],
      },
    ],
  });

  await runObserver({
    client,
    observerName: 'test-observer',
    baselineVersion: 0,
    anchorThreshold: 5,
    finalize: true,
    observeAnchorImpl: async () => ({
      title: 'Caroline',
      sections: [{
        level: 2,
        heading: 'Support',
        observingPath: 'Caroline / Support',
        sourceRefs: [],
        expandRefs: [],
        body: '',
        rewritten: true,
        children: [{
          level: 3,
          heading: 'Support group',
          observingPath: 'Caroline / Support / Support group',
          sourceRefs: ['pending-1'],
          expandRefs: [],
          body: '',
          rewritten: true,
          children: [],
        }, {
          level: 3,
          heading: 'Family',
          observingPath: siblingPath,
          sourceRefs: [],
          expandRefs: [],
          body: '',
          rewritten: false,
          children: [],
        }],
      }],
    }),
  });

  assert.equal(client.writes.deletedContextIds.includes(siblingPath), false);
  assert.equal(client.writes.deletedObservationIds.includes(siblingPath), false);
  assert.equal(client.writes.observationContexts.some((row) => row.id === siblingPath), false);
});

test('runObserver clears stale leaf content when a heading-only leaf is promoted to parent', async () => {
  const familyPath = 'Caroline / Support / Family';
  const parentsPath = 'Caroline / Support / Family / Parents';
  const client = makeClient({
    contexts: [
      ...existingCarolineContexts(),
      {
        id: familyPath,
        observingPath: familyPath,
        parentId: 'Caroline / Support',
        position: 1,
        content: 'Caroline has family support.',
        sourceRefs: ['extraction:family-old'],
        expandRefs: [],
        observer: 'test-observer',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
    ],
    observations: [
      observationRow(familyPath, familyPath, ['extraction:family-old']),
    ],
    extractions: [
      {
        ...extractionRow('pending-1', ['Entity: Caroline'], 'Caroline said her parents support her.'),
        observationPaths: [familyPath],
      },
    ],
  });

  await runObserver({
    client,
    observerName: 'test-observer',
    baselineVersion: 0,
    anchorThreshold: 5,
    finalize: true,
    observeAnchorImpl: async () => ({
      title: 'Caroline',
      sections: [{
        level: 2,
        heading: 'Support',
        observingPath: 'Caroline / Support',
        sourceRefs: [],
        expandRefs: [],
        body: '',
        rewritten: true,
        children: [{
          level: 3,
          heading: 'Family',
          observingPath: familyPath,
          sourceRefs: [],
          expandRefs: [],
          body: '',
          rewritten: false,
          children: [{
            level: 4,
            heading: 'Parents',
            observingPath: parentsPath,
            sourceRefs: ['pending-1'],
            expandRefs: [],
            body: '',
            rewritten: true,
            children: [],
          }],
        }],
      }],
    }),
  });

  const promoted = client.writes.observationContexts.find((row) => row.id === familyPath);
  assert.equal(promoted?.content, '');
  assert.deepEqual(promoted?.sourceRefs, []);
  assert.deepEqual(promoted?.expandRefs, []);
  assert.equal(client.writes.deletedObservationIds.includes(familyPath), true);
  assert.equal(client.writes.deletedContextIds.includes(familyPath), false);
});

test('runObserver rejects heading-only new leaves', async () => {
  const client = makeClient({
    contexts: existingCarolineContexts(),
    observations: [
      observationRow('Caroline / Support / Support group', 'Caroline / Support / Support group', ['pending-1']),
    ],
    extractions: [
      {
        ...extractionRow('pending-1', ['Entity: Caroline'], 'Caroline updated support group details.'),
        observationPaths: ['Caroline / Support / Support group'],
      },
    ],
  });

  await assert.rejects(() => runObserver({
    client,
    observerName: 'test-observer',
    baselineVersion: 0,
    anchorThreshold: 5,
    finalize: true,
    observeAnchorImpl: async () => ({
      title: 'Caroline',
      sections: [{
        level: 2,
        heading: 'Support',
        observingPath: 'Caroline / Support',
        sourceRefs: [],
        expandRefs: [],
        body: 'Updated support overview.',
        rewritten: true,
        children: [{
          level: 3,
          heading: 'New empty leaf',
          observingPath: 'Caroline / Support / New empty leaf',
          sourceRefs: [],
          expandRefs: [],
          body: '',
          rewritten: false,
          children: [],
        }],
      }],
    }),
  }), /heading-only observer section does not exist/i);
});

test('runObserver deletes a linked leaf omitted from the returned rewrite scope', async () => {
  const client = makeClient({
    contexts: existingCarolineContexts(),
    observations: [
      observationRow('Caroline / Support / Support group', 'Caroline / Support / Support group', ['pending-1']),
    ],
    extractions: [
      {
        ...extractionRow('pending-1', ['Entity: Caroline'], 'Caroline updated support group details.'),
        observationPaths: ['Caroline / Support / Support group'],
      },
    ],
  });

  await runObserver({
    client,
    observerName: 'test-observer',
    baselineVersion: 0,
    anchorThreshold: 5,
    finalize: true,
    observeAnchorImpl: async () => ({
      title: 'Caroline',
      sections: [{
        level: 2,
        heading: 'Support',
        observingPath: 'Caroline / Support',
        sourceRefs: [],
        expandRefs: [],
        body: '',
        rewritten: true,
        children: [],
      }],
    }),
  });

  assert.equal(client.writes.deletedContextIds.includes('Caroline / Support / Support group'), true);
  assert.equal(client.writes.deletedObservationIds.includes('Caroline / Support / Support group'), true);
});

test('runObserver does not upsert deleted extraction changes when updating links', async () => {
  const deletedExtraction = {
    ...extractionRow('pending-1', ['Entity: Caroline'], 'Caroline removed old support group details.'),
    observationPaths: ['Caroline / Support / Support group'],
  };
  const client = makeClient({
    contexts: existingCarolineContexts(),
    observations: [
      observationRow('Caroline / Support / Support group', 'Caroline / Support / Support group', ['pending-1']),
    ],
    extractions: [],
  });

  await runObserver({
    client,
    observerName: 'test-observer',
    anchor: 'Caroline',
    extractionChanges: [{ type: 'delete', extraction: deletedExtraction }],
    observeAnchorImpl: async () => ({
      title: 'Caroline',
      sections: [{
        level: 2,
        heading: 'Support',
        observingPath: 'Caroline / Support',
        sourceRefs: [],
        expandRefs: [],
        body: '',
        rewritten: true,
        children: [],
      }],
    }),
  });

  assert.equal(client.writes.deletedContextIds.includes('Caroline / Support / Support group'), true);
  assert.equal(client.writes.deletedObservationIds.includes('Caroline / Support / Support group'), true);
  assert.deepEqual(client.writes.extractions, []);
});

test('runObserver get_observation returns selected subtree without siblings', async () => {
  let toolContent = '';
  const client = makeClient({
    contexts: existingCarolineContexts(),
    observations: [
      observationRow('Caroline / Support / Support group', 'Caroline / Support / Support group', ['extraction:support']),
      observationRow('Caroline / Art / Painting', 'Caroline / Art / Painting', ['extraction:painting']),
    ],
    extractions: makeExtractions(1),
  });

  await runObserver({
    client,
    observerName: 'test-observer',
    baselineVersion: 0,
    anchorThreshold: 5,
    finalize: true,
    observeAnchorImpl: async (input) => {
      toolContent = await input.getObservation(['Caroline / Art / Painting']);
      return {
        title: 'Caroline',
        sections: [{
          level: 2,
          heading: 'Art',
          observingPath: 'Caroline / Art',
          sourceRefs: [],
          expandRefs: [],
          body: '',
          children: [{
            level: 3,
            heading: 'Painting',
            observingPath: 'Caroline / Art / Painting',
            sourceRefs: ['extraction:painting', input.extractions[0].id],
            expandRefs: [],
            body: '',
            children: [],
          }],
        }],
      };
    },
  });

  assert.match(toolContent, /# Caroline/);
  assert.match(toolContent, /## Art/);
  assert.match(toolContent, /### Painting <!-- path: Caroline \/ Art \/ Painting -->/);
  assert.match(toolContent, /Caroline painted a landscape/);
  assert.doesNotMatch(toolContent, /Source extractions:/);
  assert.doesNotMatch(toolContent, /Support group/);
});

test('runObserver get_observation returns non-leaf subtree without sibling branches', async () => {
  let toolContent = '';
  const client = makeClient({
    contexts: [
      ...existingCarolineContexts(),
      {
        id: 'Caroline / Art / Music',
        observingPath: 'Caroline / Art / Music',
        parentId: 'Caroline / Art',
        position: 1,
        content: 'Caroline plays piano.',
        observer: 'test-observer',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
    ],
    observations: [
      observationRow('Caroline / Support / Support group', 'Caroline / Support / Support group', ['extraction:support']),
      observationRow('Caroline / Art / Painting', 'Caroline / Art / Painting', ['extraction:painting']),
      observationRow('Caroline / Art / Music', 'Caroline / Art / Music', ['extraction:music']),
    ],
    extractions: makeExtractions(1),
  });

  await runObserver({
    client,
    observerName: 'test-observer',
    baselineVersion: 0,
    anchorThreshold: 5,
    finalize: true,
    observeAnchorImpl: async (input) => {
      toolContent = await input.getObservation(['Caroline / Art']);
      return {
        title: 'Caroline',
        sections: [{
          level: 2,
          heading: 'Art',
          observingPath: 'Caroline / Art',
          sourceRefs: [],
          expandRefs: [],
          body: 'Art overview.',
          children: [{
            level: 3,
            heading: 'Painting',
            observingPath: 'Caroline / Art / Painting',
            sourceRefs: ['extraction:painting'],
            expandRefs: [],
            body: '',
            children: [],
          }, {
            level: 3,
            heading: 'Music',
            observingPath: 'Caroline / Art / Music',
            sourceRefs: ['extraction:music'],
            expandRefs: [],
            body: '',
            children: [],
          }],
        }],
      };
    },
  });

  assert.match(toolContent, /# Caroline/);
  assert.match(toolContent, /## Art/);
  assert.match(toolContent, /### Painting <!-- path: Caroline \/ Art \/ Painting -->/);
  assert.match(toolContent, /Caroline painted a landscape/);
  assert.match(toolContent, /### Music <!-- path: Caroline \/ Art \/ Music -->/);
  assert.match(toolContent, /Caroline plays piano/);
  assert.doesNotMatch(toolContent, /Source extractions:/);
  assert.doesNotMatch(toolContent, /Support group/);
});

test('runObserver applies a rootless leaf rewrite to its existing parent', async (t) => {
  await useMockHome(t, 'muninn-observer-rootless-leaf-');
  const client = makeClient({
    contexts: existingCarolineContexts(),
    observations: [
      observationRow('support-leaf', 'Caroline / Support / Support group', ['pending-1']),
    ],
    extractions: [
      {
        ...extractionRow('pending-1', ['Entity: Caroline'], 'Caroline updated support group details.'),
        observationPaths: ['Caroline / Support / Support group'],
      },
    ],
  });

  await runObserver({
    client,
    observerName: 'test-observer',
    baselineVersion: 0,
    anchorThreshold: 5,
    finalize: true,
    observeAnchorImpl: async () => ({
      title: 'Caroline',
      sections: [{
        level: 2,
        heading: 'Support',
        observingPath: 'Caroline / Support',
        sourceRefs: [],
        expandRefs: [],
        body: '',
        children: [{
          level: 3,
          heading: 'Support group',
          observingPath: 'Caroline / Support / Support group',
          sourceRefs: ['pending-1'],
          expandRefs: [],
          body: 'Caroline updated support group details.\n\n- [pending-1] Caroline updated support group details.',
          children: [],
        }],
      }],
    }),
  });

  const leaf = client.writes.observationContexts.find((row) => row.observingPath === 'Caroline / Support / Support group');
  assert.equal(leaf?.parentId, 'Caroline / Support');
  assert.equal(leaf?.observingPath, 'Caroline / Support / Support group');
});

test('observeAnchor accepts path-based subtree markdown', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'muninn-observer-rootless-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const homeDir = path.join(dir, 'home');
  await writeFile(path.join(dir, 'muninn.json'), JSON.stringify(mockConfig(), null, 2));
  await mkdir(homeDir, { recursive: true });
  await copyFile(path.join(dir, 'muninn.json'), path.join(homeDir, 'muninn.json'));

  const previousHome = process.env.MUNINN_HOME;
  process.env.MUNINN_HOME = homeDir;
  t.after(() => {
    if (previousHome === undefined) {
      delete process.env.MUNINN_HOME;
    } else {
      process.env.MUNINN_HOME = previousHome;
    }
  });

  const result = await observeAnchor({
    entityAnchor: 'Caroline',
    outline: '# Caroline',
    observedDocument: '',
    extractions: [{
      id: 'ext-a',
      status: 'changed',
      title: 'caroline support detail update summary',
      text: 'Caroline updated support details.',
      context: null,
      anchors: ['Entity: Caroline'],
      turnRefs: ['turn:1'],
    }],
    getObservation: () => '# Caroline',
    maxAttempts: 1,
    model: async () => ({
      type: 'final',
      text: `## Support

### Support group
Caroline updated support details.

- [ext-a] Caroline updated support details.`,
    }),
  });

  assert.equal(result.title, 'Caroline');
  assert.equal(result.sections[0].level, 2);
  assert.equal(result.sections[0].observingPath, 'Caroline / Support');
  assert.equal(result.sections[0].children[0].observingPath, 'Caroline / Support / Support group');
});

test('runObserver upserts each observation id once', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'muninn-observer-dedupe-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const homeDir = path.join(dir, 'home');
  await writeFile(path.join(dir, 'muninn.json'), JSON.stringify(mockConfig(), null, 2));
  await mkdir(homeDir, { recursive: true });
  await copyFile(path.join(dir, 'muninn.json'), path.join(homeDir, 'muninn.json'));

  const previousHome = process.env.MUNINN_HOME;
  process.env.MUNINN_HOME = homeDir;
  t.after(() => {
    if (previousHome === undefined) {
      delete process.env.MUNINN_HOME;
    } else {
      process.env.MUNINN_HOME = previousHome;
    }
  });

  const client = makeClient({
    extractions: makeExtractions(1),
  });

  await runObserver({
    client,
    observerName: 'test-observer',
    baselineVersion: 0,
    anchorThreshold: 5,
    finalize: true,
    observeAnchorImpl: async (input) => ({
      title: 'Caroline',
      sections: [{
        level: 2,
        heading: 'Who is Caroline?',
        observingPath: 'Caroline / Who is Caroline?',
        sourceRefs: [],
        expandRefs: [],
        body: 'Caroline overview.',
        children: [{
          level: 3,
          heading: 'Support group',
          observingPath: 'Caroline / Who is Caroline? / Support group',
          sourceRefs: [input.extractions[0].id],
          expandRefs: [],
          body: 'Caroline attended a support group.',
          children: [],
        }],
      }],
    }),
  });

  const ids = client.writes.observations.map((row) => row.id);
  assert.equal(ids.length, new Set(ids).size);
});

test('runObserver indexes and links extraction-linked refs', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'muninn-observer-source-refs-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const homeDir = path.join(dir, 'home');
  await writeFile(path.join(dir, 'muninn.json'), JSON.stringify(mockConfig(), null, 2));
  await mkdir(homeDir, { recursive: true });
  await copyFile(path.join(dir, 'muninn.json'), path.join(homeDir, 'muninn.json'));

  const previousHome = process.env.MUNINN_HOME;
  process.env.MUNINN_HOME = homeDir;
  t.after(() => {
    if (previousHome === undefined) {
      delete process.env.MUNINN_HOME;
    } else {
      process.env.MUNINN_HOME = previousHome;
    }
  });

  const client = makeClient({
    extractions: makeExtractions(2),
  });

  await runObserver({
    client,
    observerName: 'test-observer',
    baselineVersion: 0,
    anchorThreshold: 5,
    finalize: true,
    observeAnchorImpl: async (input) => ({
      title: 'Caroline',
      sections: [{
        level: 2,
        heading: 'Who is Caroline?',
        observingPath: 'Caroline / Who is Caroline?',
        sourceRefs: [],
        expandRefs: [],
        body: 'Caroline overview.',
        children: [{
          level: 3,
          heading: 'Support group',
          observingPath: 'Caroline / Who is Caroline? / Support group',
          sourceRefs: [input.extractions[0].id, input.extractions[1].id],
          expandRefs: [],
          body: `Caroline attended a support group.\n\n- [${input.extractions[0].id}] Caroline started attending a support group.\n- [${input.extractions[1].id}] Caroline updated details about the support group.`,
          children: [],
        }],
      }],
    }),
  });

  assert.equal(client.writes.observations.length, 1);
  assert.deepEqual(client.writes.observations[0].extractionRefs, ['pending-1', 'pending-2']);
  const leafId = client.writes.observations[0].id;
  assert.deepEqual(
    client.writes.extractions.map((row) => [row.id, row.observationPaths]),
    [['pending-1', [leafId]], ['pending-2', [leafId]]],
  );
});

test('runObserver indexes rewritten leaves with extraction-linked bullets', async (t) => {
  await useMockHome(t, 'muninn-observer-linked-bullets-');
  const client = makeClient({
    extractions: makeExtractions(1),
  });

  await runObserver({
    client,
    observerName: 'test-observer',
    baselineVersion: 0,
    anchorThreshold: 5,
    finalize: true,
    observeAnchorImpl: async (input) => ({
      title: 'Caroline',
      sections: [{
        level: 2,
        heading: 'Plans',
        observingPath: 'Caroline / Plans',
        sourceRefs: [],
        expandRefs: [],
        body: '',
        children: [{
          level: 3,
          heading: 'Support group',
          observingPath: 'Caroline / Plans / Support group',
          sourceRefs: [input.extractions[0].id],
          expandRefs: [],
          body: `Caroline attended a support group.\n\n- [${input.extractions[0].id}] Caroline started attending a support group.`,
          children: [],
        }],
      }],
    }),
  });

  const leaf = client.writes.observationContexts.find((row) => row.observingPath === 'Caroline / Plans / Support group');
  assert.match(leaf?.content ?? '', /- \[pending-1\] Caroline started attending a support group/);
  assert.equal(client.writes.observations.length, 1);
  assert.deepEqual(client.writes.observations[0].extractionRefs, ['pending-1']);
  assert.deepEqual(client.writes.extractions.map((row) => [row.id, row.observationPaths]), [
    ['pending-1', ['Caroline / Plans / Support group']],
  ]);
});

test('runObserver updates stale observation index when a leaf is rewritten', async (t) => {
  await useMockHome(t, 'muninn-observer-linked-update-');
  const leafPath = 'Caroline / Plans / Support group';
  const extraction = {
    ...makeExtractions(1)[0],
    observationPaths: [leafPath],
  };
  const client = makeClient({
    contexts: [{
      id: 'Caroline / Plans',
      observingPath: 'Caroline / Plans',
      parentId: null,
      position: 0,
      content: '',
      observer: 'test-observer',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    }, {
      id: leafPath,
      observingPath: leafPath,
      parentId: 'Caroline / Plans',
      position: 0,
      content: 'Caroline attended a support group.',
      sourceRefs: ['pending-1'],
      expandRefs: [],
      observer: 'test-observer',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    }],
    observations: [observationRow(leafPath, leafPath, ['pending-1'])],
    extractions: [extraction],
  });

  await runObserver({
    client,
    observerName: 'test-observer',
    anchor: 'Caroline',
    extractionChanges: [{ type: 'upsert', extraction }],
    observeAnchorImpl: async (input) => ({
      title: 'Caroline',
      sections: [{
        level: 2,
        heading: 'Plans',
        observingPath: 'Caroline / Plans',
        sourceRefs: [],
        expandRefs: [],
        body: '',
        children: [{
          level: 3,
          heading: 'Support group',
          observingPath: leafPath,
          sourceRefs: [input.extractions[0].id],
          expandRefs: [],
          body: `Caroline attended a support group.\n\n- [${input.extractions[0].id}] Caroline kept attending a support group.`,
          children: [],
        }],
      }],
    }),
  });

  assert.equal(client.writes.observations.length, 1);
  assert.deepEqual(client.writes.observations[0].extractionRefs, ['pending-1']);
  assert.equal(client.writes.deletedObservationIds.includes(leafPath), false);
});

test('runObserver skips extraction path upsert when observation paths are unchanged', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'muninn-observer-path-noop-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const homeDir = path.join(dir, 'home');
  await writeFile(path.join(dir, 'muninn.json'), JSON.stringify(mockConfig(), null, 2));
  await mkdir(homeDir, { recursive: true });
  await copyFile(path.join(dir, 'muninn.json'), path.join(homeDir, 'muninn.json'));

  const previousHome = process.env.MUNINN_HOME;
  process.env.MUNINN_HOME = homeDir;
  t.after(() => {
    if (previousHome === undefined) {
      delete process.env.MUNINN_HOME;
    } else {
      process.env.MUNINN_HOME = previousHome;
    }
  });

  const pathId = 'Caroline / Who is Caroline? / Support group';
  const client = makeClient({
    contexts: [{
      id: pathId,
      observingPath: pathId,
      parentId: 'Caroline / Who is Caroline?',
      position: 0,
      content: 'Caroline attended a support group.',
      sourceRefs: ['pending-1'],
      expandRefs: [],
      observer: 'test-observer',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    }],
    extractions: [{
      ...makeExtractions(1)[0],
      observationPaths: [pathId],
    }],
  });

  await runObserver({
    client,
    observerName: 'test-observer',
    baselineVersion: 0,
    anchorThreshold: 5,
    finalize: true,
    observeAnchorImpl: async (input) => ({
      title: 'Caroline',
      sections: [{
        level: 2,
        heading: 'Who is Caroline?',
        observingPath: 'Caroline / Who is Caroline?',
        sourceRefs: [],
        expandRefs: [],
        body: '',
        children: [{
          level: 3,
          heading: 'Support group',
          observingPath: pathId,
          sourceRefs: [input.extractions[0].id],
          expandRefs: [],
          body: 'Caroline attended a support group.',
          children: [],
        }],
      }],
    }),
  });

  assert.deepEqual(client.writes.extractions, []);
});

test('runObserver updates stored extraction links when old refs move to a new leaf', async (t) => {
  await useMockHome(t, 'muninn-observer-link-move-');
  const oldPath = 'Caroline / Support / Support group';
  const newPath = 'Caroline / Support / Community support';
  const oldExtraction = {
    ...extractionRow('extraction:old', ['Entity: Caroline'], 'Caroline previously attended a support group.'),
    observationPaths: [oldPath],
  };
  const pendingExtraction = {
    ...extractionRow('pending-1', ['Entity: Caroline'], 'Caroline joined a broader community support circle.'),
    observationPaths: [oldPath],
  };
  const client = makeClient({
    contexts: [{
      id: 'Caroline / Support',
      observingPath: 'Caroline / Support',
      parentId: null,
      position: 0,
      content: '',
      observer: 'test-observer',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    }, {
      id: oldPath,
      observingPath: oldPath,
      parentId: 'Caroline / Support',
      position: 0,
      content: 'Caroline previously attended a support group.',
      sourceRefs: ['extraction:old'],
      expandRefs: [],
      observer: 'test-observer',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    }],
    extractions: [oldExtraction, pendingExtraction],
  });

  await runObserver({
    client,
    observerName: 'test-observer',
    anchor: 'Caroline',
    extractionChanges: [{ type: 'upsert', extraction: pendingExtraction }],
    observeAnchorImpl: async () => ({
      title: 'Caroline',
      sections: [{
        level: 2,
        heading: 'Support',
        observingPath: 'Caroline / Support',
        sourceRefs: [],
        expandRefs: [],
        body: 'Caroline has community support.',
        rewritten: true,
        children: [{
          level: 3,
          heading: 'Community support',
          observingPath: newPath,
          sourceRefs: ['extraction:old', 'pending-1'],
          expandRefs: [],
          body: 'Caroline moved from a prior support group into broader community support.',
          rewritten: true,
          children: [],
        }],
      }],
    }),
  });

  assert.equal(client.writes.deletedContextIds.includes(oldPath), true);
  assert.deepEqual(
    client.writes.extractions.map((row) => [row.id, row.observationPaths]).sort(),
    [['extraction:old', [newPath]], ['pending-1', [newPath]]],
  );
});

test('runObserver clears stored extraction links when old refs are removed from rewritten scope', async (t) => {
  await useMockHome(t, 'muninn-observer-link-remove-');
  const oldPath = 'Caroline / Support / Support group';
  const oldExtraction = {
    ...extractionRow('extraction:old', ['Entity: Caroline'], 'Caroline previously attended a support group.'),
    observationPaths: [oldPath],
  };
  const pendingExtraction = {
    ...extractionRow('pending-1', ['Entity: Caroline'], 'Caroline removed outdated support details.'),
    observationPaths: [oldPath],
  };
  const client = makeClient({
    contexts: [{
      id: 'Caroline / Support',
      observingPath: 'Caroline / Support',
      parentId: null,
      position: 0,
      content: '',
      observer: 'test-observer',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    }, {
      id: oldPath,
      observingPath: oldPath,
      parentId: 'Caroline / Support',
      position: 0,
      content: 'Caroline previously attended a support group.',
      sourceRefs: ['extraction:old'],
      expandRefs: [],
      observer: 'test-observer',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    }],
    extractions: [oldExtraction, pendingExtraction],
  });

  await runObserver({
    client,
    observerName: 'test-observer',
    anchor: 'Caroline',
    extractionChanges: [{ type: 'upsert', extraction: pendingExtraction }],
    observeAnchorImpl: async () => ({
      title: 'Caroline',
      sections: [{
        level: 2,
        heading: 'Support',
        observingPath: 'Caroline / Support',
        sourceRefs: [],
        expandRefs: [],
        body: 'Caroline support details were updated.',
        rewritten: true,
        children: [],
      }],
    }),
  });

  assert.equal(client.writes.deletedContextIds.includes(oldPath), true);
  assert.deepEqual(
    client.writes.extractions.map((row) => [row.id, row.observationPaths]).sort(),
    [['extraction:old', []], ['pending-1', []]],
  );
});

test('runObserver stores only current section content in observation text', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'muninn-observer-text-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const homeDir = path.join(dir, 'home');
  await writeFile(path.join(dir, 'muninn.json'), JSON.stringify(mockConfig(), null, 2));
  await mkdir(homeDir, { recursive: true });
  await copyFile(path.join(dir, 'muninn.json'), path.join(homeDir, 'muninn.json'));

  const previousHome = process.env.MUNINN_HOME;
  process.env.MUNINN_HOME = homeDir;
  t.after(() => {
    if (previousHome === undefined) {
      delete process.env.MUNINN_HOME;
    } else {
      process.env.MUNINN_HOME = previousHome;
    }
  });

  const client = makeClient({
    extractions: makeExtractions(1),
  });

  await runObserver({
    client,
    observerName: 'test-observer',
    baselineVersion: 0,
    anchorThreshold: 5,
    finalize: true,
    observeAnchorImpl: async (input) => ({
      title: 'Caroline',
      sections: [{
        level: 2,
        heading: 'Who is Caroline?',
        observingPath: 'Caroline / Who is Caroline?',
        sourceRefs: [],
        expandRefs: [],
        body: 'Parent overview should not enter leaf observation text.',
        children: [{
          level: 3,
          heading: 'Support group',
          observingPath: 'Caroline / Who is Caroline? / Support group',
          sourceRefs: [input.extractions[0].id],
          expandRefs: [],
          body: 'Caroline attended a support group.',
          children: [],
        }],
      }],
    }),
  });

  assert.equal(client.writes.observations.length, 1);
  const leaf = client.writes.observations.find((row) => row.observingPath.endsWith('Support group'));
  assert.equal(leaf?.text, 'Caroline / Who is Caroline? / Support group\n\nCaroline attended a support group.');
  assert.doesNotMatch(leaf?.text ?? '', /Parent overview/);
});

test('runObserver deletes stale non-leaf observation rows', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'muninn-observer-parent-delete-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const homeDir = path.join(dir, 'home');
  await writeFile(path.join(dir, 'muninn.json'), JSON.stringify(mockConfig(), null, 2));
  await mkdir(homeDir, { recursive: true });
  await copyFile(path.join(dir, 'muninn.json'), path.join(homeDir, 'muninn.json'));

  const previousHome = process.env.MUNINN_HOME;
  process.env.MUNINN_HOME = homeDir;
  t.after(() => {
    if (previousHome === undefined) {
      delete process.env.MUNINN_HOME;
    } else {
      process.env.MUNINN_HOME = previousHome;
    }
  });

  const client = makeClient({
    contexts: [{
      id: 'Caroline / Who is Caroline?',
      observingPath: 'Caroline / Who is Caroline?',
      parentId: null,
      position: 0,
      content: 'Parent overview.',
      observer: 'test-observer',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    }],
    observations: [{
      id: 'Caroline / Who is Caroline?',
      observingPath: 'Caroline / Who is Caroline?',
      text: 'Who is Caroline?\n\nParent overview.',
      vector: [],
      extractionRefs: ['pending-1'],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    }],
    extractions: makeExtractions(1),
  });

  await runObserver({
    client,
    observerName: 'test-observer',
    baselineVersion: 0,
    anchorThreshold: 5,
    finalize: true,
    observeAnchorImpl: async (input) => ({
      title: 'Caroline',
      sections: [{
        level: 2,
        heading: 'Who is Caroline?',
        observingPath: 'Caroline / Who is Caroline?',
        sourceRefs: [],
        expandRefs: [],
        body: 'Parent overview.',
        children: [{
          level: 3,
          heading: 'Support group',
          observingPath: 'Caroline / Who is Caroline? / Support group',
          sourceRefs: [input.extractions[0].id],
          expandRefs: [],
          body: 'Caroline attended a support group.',
          children: [],
        }],
      }],
    }),
  });

  assert.deepEqual(client.writes.deletedObservationIds, ['Caroline / Who is Caroline?']);
});

test('getObserverWorkStatus reports no work when extraction baseline is current', async () => {
  const client = makeClient({
    extractions: makeExtractions(5),
    extractionVersion: 7,
  });

  assert.deepEqual(
    await getObserverWorkStatus({ client, baselineVersion: 7, anchorThreshold: 5 }),
    { changed: false, pending: false, groupCount: 0, baselineVersion: 7 },
  );
});

test('observeAnchor writes observer trace with input, prompt, and parsed document', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'muninn-observer-trace-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const homeDir = path.join(dir, 'home');
  await writeFile(path.join(dir, 'muninn.json'), JSON.stringify(mockConfig(), null, 2));
  await mkdir(homeDir, { recursive: true });
  await copyFile(path.join(dir, 'muninn.json'), path.join(homeDir, 'muninn.json'));

  const previousHome = process.env.MUNINN_HOME;
  const previousTrace = process.env.MUNINN_OBSERVER_TRACE_FILE;
  const tracePath = path.join(dir, 'observer-trace.jsonl');
  process.env.MUNINN_HOME = homeDir;
  process.env.MUNINN_OBSERVER_TRACE_FILE = tracePath;
  t.after(() => {
    if (previousHome === undefined) {
      delete process.env.MUNINN_HOME;
    } else {
      process.env.MUNINN_HOME = previousHome;
    }
    if (previousTrace === undefined) {
      delete process.env.MUNINN_OBSERVER_TRACE_FILE;
    } else {
      process.env.MUNINN_OBSERVER_TRACE_FILE = previousTrace;
    }
  });

  const result = await observeAnchor({
    entityAnchor: 'Caroline',
    outline: '# Caroline\n\n(empty)',
    observedDocument: '',
    extractions: [{
      id: 'ext-a',
      status: 'new',
      title: 'caroline support group attendance detail',
      text: 'Caroline attended an LGBTQ support group.',
      context: 'Caroline discussed support.',
      anchors: ['Entity: Caroline'],
      turnRefs: ['turn:1'],
    }],
    maxAttempts: 1,
  });

  assert.equal(result.title, 'Mock entity');
  const trace = JSON.parse(await readFile(tracePath, 'utf8'));
  assert.equal(trace.input.entityAnchor, 'Caroline');
  assert.match(trace.prompt.system, /observer that maintains parts of a cross-session observation tree/);
  assert.match(trace.prompt.system, /get_observation\(paths\)/);
  assert.match(trace.prompt.user, /Observed document:/);
  assert.match(trace.prompt.user, /Extraction units:/);
  assert.match(trace.finalText, /# Mock entity/);
  assert.equal(trace.document.title, 'Mock entity');
  assert.equal(trace.document.sections[0].children[0].sourceRefs[0], 'ext-a');
});

test('observeAnchor exposes get_observation tool without memory-get', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'muninn-observer-tool-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const homeDir = path.join(dir, 'home');
  await writeFile(path.join(dir, 'muninn.json'), JSON.stringify(mockConfig(), null, 2));
  await mkdir(homeDir, { recursive: true });
  await copyFile(path.join(dir, 'muninn.json'), path.join(homeDir, 'muninn.json'));

  const previousHome = process.env.MUNINN_HOME;
  process.env.MUNINN_HOME = homeDir;
  t.after(() => {
    if (previousHome === undefined) {
      delete process.env.MUNINN_HOME;
    } else {
      process.env.MUNINN_HOME = previousHome;
    }
  });

  const toolNames = [];
  let calls = 0;
  const result = await observeAnchor({
    entityAnchor: 'Caroline',
    outline: '# Caroline\n- leaf: Caroline / Support / Support group',
    observedDocument: '',
    extractions: [{
      id: 'ext-a',
      status: 'new',
      title: 'caroline support group attendance detail',
      text: 'Caroline attended an LGBTQ support group.',
      context: null,
      anchors: ['Entity: Caroline'],
      turnRefs: ['turn:1'],
    }],
    getObservation: (paths) => `# Caroline

## Support

### Support group
Caroline previously attended a support group.

- [ext-old] Caroline previously attended a support group.`,
    validRefs: ['ext-old'],
    maxAttempts: 1,
    model: async (_task, request) => {
      calls += 1;
      toolNames.push(...request.tools.map((tool) => tool.name));
      if (calls === 1) {
        return {
          type: 'tool_calls',
          toolCalls: [{
            id: 'call-1',
            name: 'get_observation',
            arguments: { paths: ['Caroline / Support / Support group'] },
          }],
        };
      }
      return {
        type: 'final',
        text: `# Caroline

## Support

### Support group
Caroline attended an LGBTQ support group.

- [ext-old] Caroline previously attended a support group.
- [ext-a] Caroline attended an LGBTQ support group.`,
      };
    },
  });

  assert.deepEqual([...new Set(toolNames)], ['get_observation']);
  assert.equal(result.sections[0].children[0].sourceRefs.includes('ext-a'), true);
});

test('observeAnchor only accepts refs from extraction-linked bullet lines', async (t) => {
  await useMockHome(t, 'muninn-observer-ref-extract-');

  await assert.rejects(() => observeAnchor({
    entityAnchor: 'Caroline',
    outline: '# Caroline\n- leaf: Caroline / Support / Support group',
    observedDocument: `# Caroline

## Support
### Support group
Caroline used a [priority] label in ordinary prose.

- [ext-old] Caroline previously attended a support group.`,
    extractions: [{
      id: 'ext-a',
      status: 'new',
      text: 'Caroline attended an LGBTQ support group.',
      context: null,
      anchors: ['Entity: Caroline'],
      turnRefs: ['turn:1'],
    }],
    getObservation: () => '# Caroline',
    validRefs: ['ext-old'],
    maxAttempts: 1,
    model: async () => ({
      type: 'final',
      text: `# Caroline

## Support
### Support group
Caroline used a priority label.

- [priority] This should not become a valid extraction ref.`,
    }),
  }), /unknown extraction id: priority/);
});

test('observeAnchor rejects more than two get_observation calls', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'muninn-observer-tool-steps-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const homeDir = path.join(dir, 'home');
  await writeFile(path.join(dir, 'muninn.json'), JSON.stringify(mockConfig(), null, 2));
  await mkdir(homeDir, { recursive: true });
  await copyFile(path.join(dir, 'muninn.json'), path.join(homeDir, 'muninn.json'));

  const previousHome = process.env.MUNINN_HOME;
  process.env.MUNINN_HOME = homeDir;
  t.after(() => {
    if (previousHome === undefined) {
      delete process.env.MUNINN_HOME;
    } else {
      process.env.MUNINN_HOME = previousHome;
    }
  });

  let calls = 0;
  await assert.rejects(() => observeAnchor({
    entityAnchor: 'Caroline',
    outline: '# Caroline\n- leaf: Caroline / Support / Support group',
    observedDocument: '',
    extractions: [{
      id: 'ext-a',
      status: 'new',
      title: 'caroline support group attendance detail',
      text: 'Caroline attended an LGBTQ support group.',
      context: null,
      anchors: ['Entity: Caroline'],
      turnRefs: ['turn:1'],
    }],
    getObservation: () => `# Caroline

## Support

### Support group
Caroline previously attended a support group.

- [ext-old] Caroline previously attended a support group.`,
    validRefs: ['ext-old'],
    maxAttempts: 1,
    model: async () => {
      calls += 1;
      if (calls <= 4) {
        return {
          type: 'tool_calls',
          toolCalls: [{
            id: `call-${calls}`,
            name: 'get_observation',
            arguments: { paths: ['Caroline / Support / Support group'] },
          }],
        };
      }
      return {
        type: 'final',
        text: `# Caroline

## Support

### Support group
Caroline attended an LGBTQ support group.

- [ext-old] Caroline previously attended a support group.
- [ext-a] Caroline attended an LGBTQ support group.`,
      };
    },
  }), /get_observation exceeded max calls=3/);

  assert.equal(calls, 4);
});

test('observeAnchor recovers when get_observation is called with an unavailable id', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'muninn-observer-tool-error-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const homeDir = path.join(dir, 'home');
  await writeFile(path.join(dir, 'muninn.json'), JSON.stringify(mockConfig(), null, 2));
  await mkdir(homeDir, { recursive: true });
  await copyFile(path.join(dir, 'muninn.json'), path.join(homeDir, 'muninn.json'));

  const previousHome = process.env.MUNINN_HOME;
  process.env.MUNINN_HOME = homeDir;
  t.after(() => {
    if (previousHome === undefined) {
      delete process.env.MUNINN_HOME;
    } else {
      process.env.MUNINN_HOME = previousHome;
    }
  });

  let calls = 0;
  let sawToolError = false;
  const result = await observeAnchor({
    entityAnchor: 'Caroline',
    outline: '# Caroline\n- leaf: Caroline / Support / Support group',
    observedDocument: '',
    extractions: [{
      id: 'ext-a',
      status: 'new',
      title: 'caroline support group attendance detail',
      text: 'Caroline attended an LGBTQ support group.',
      context: null,
      anchors: ['Entity: Caroline'],
      turnRefs: ['turn:1'],
    }],
    getObservation: (paths) => {
      if (paths[0] !== 'Caroline / Support / Support group') {
        throw new Error(`get_observation path is not visible in the outline: ${paths[0]}`);
      }
      return `# Caroline

## Support

### Support group
Caroline previously attended a support group.

- [ext-old] Caroline previously attended a support group.`;
    },
    validRefs: ['ext-old'],
    maxAttempts: 1,
    model: async (_purpose, input) => {
      calls += 1;
      if (calls === 1) {
        return {
          type: 'tool_calls',
          toolCalls: [{
            id: 'call-invalid',
            name: 'get_observation',
            arguments: { paths: ['not-visible'] },
          }],
        };
      }
      sawToolError = input.messages.some((message) =>
        message.role === 'tool' && String(message.content).includes('not visible in the outline'));
      return {
        type: 'final',
        text: `# Caroline

## Support

### Support group
Caroline attended an LGBTQ support group.

- [ext-old] Caroline previously attended a support group.
- [ext-a] Caroline attended an LGBTQ support group.`,
      };
    },
  });

  assert.equal(calls, 2);
  assert.equal(sawToolError, true);
  assert.equal(result.sections[0].children[0].sourceRefs.includes('ext-a'), true);
});

function makeClient({ extractions, contexts = [], observations = [], extractionVersion = 1 }) {
  const normalizedContexts = contexts.map((context) => {
    const observation = observations.find((row) => row.id === context.id);
    return {
      sourceRefs: observation?.extractionRefs ?? [],
      expandRefs: [],
      ...context,
    };
  });
  const writes = {
    observationContexts: [],
    observations: [],
    extractions: [],
    deletedContextIds: [],
    deletedObservationIds: [],
  };
  return {
    writes,
    extractionTable: {
      stats: async () => ({
        version: extractionVersion,
        fragmentCount: 1,
        rowCount: extractions.length,
      }),
      get: async ({ ids }) => extractions.filter((row) => ids.includes(row.id)),
      delta: async ({ baselineVersion }) => (
        baselineVersion < extractionVersion ? extractions : []
      ),
      upsert: async ({ rows }) => {
        writes.extractions.push(...rows);
      },
    },
    observationContextTable: {
      list: async () => normalizedContexts,
      get: async ({ ids }) => normalizedContexts.filter((row) => ids.includes(row.id)),
      upsert: async ({ rows }) => {
        writes.observationContexts.push(...rows);
      },
      delete: async ({ ids }) => {
        writes.deletedContextIds.push(...ids);
        return { deleted: ids.length };
      },
    },
    observationTable: {
      get: async ({ ids }) => observations.filter((row) => ids.includes(row.id)),
      upsert: async ({ rows }) => {
        writes.observations.push(...rows);
      },
      delete: async ({ ids }) => {
        writes.deletedObservationIds.push(...ids);
        return { deleted: ids.length };
      },
    },
  };
}

async function useMockHome(t, prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const homeDir = path.join(dir, 'home');
  await writeFile(path.join(dir, 'muninn.json'), JSON.stringify(mockConfig(), null, 2));
  await mkdir(homeDir, { recursive: true });
  await copyFile(path.join(dir, 'muninn.json'), path.join(homeDir, 'muninn.json'));

  const previousHome = process.env.MUNINN_HOME;
  process.env.MUNINN_HOME = homeDir;
  t.after(() => {
    if (previousHome === undefined) {
      delete process.env.MUNINN_HOME;
    } else {
      process.env.MUNINN_HOME = previousHome;
    }
  });
}

function extractionRow(id, anchors, text) {
  return {
    id,
    text,
    context: null,
    anchors,
    vector: [0.1, 0.2],
    importance: 0.5,
    turnRefs: ['turn:1'],
    observationPaths: [],
    observedRootAnchors: [],
    createdAt: '2026-05-17T00:00:00.000Z',
    updatedAt: '2026-05-17T00:00:00.000Z',
  };
}

function makeExtractions(count, options = {}) {
  const offset = options.offset ?? 0;
  const anchors = options.anchors ?? ['Entity: Caroline'];
  return Array.from({ length: count }, (_, index) => ({
    id: `pending-${offset + index + 1}`,
    text: `Caroline memory ${offset + index + 1}`,
    context: null,
    anchors,
    turnRefs: [`turn:${offset + index + 1}`],
    observationPaths: [],
    observedRootAnchors: options.observed ? ['Caroline'] : [],
  }));
}

function existingCarolineContexts() {
  return [
    {
      id: 'Caroline / Support',
      observingPath: 'Caroline / Support',
      parentId: null,
      position: 0,
      content: 'Support overview.',
      observer: 'test-observer',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
    {
      id: 'Caroline / Support / Support group',
      observingPath: 'Caroline / Support / Support group',
      parentId: 'Caroline / Support',
      position: 0,
      content: 'Caroline attended a support group.',
      observer: 'test-observer',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
    {
      id: 'Caroline / Art',
      observingPath: 'Caroline / Art',
      parentId: null,
      position: 1,
      content: 'Art overview.',
      observer: 'test-observer',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
    {
      id: 'Caroline / Art / Painting',
      observingPath: 'Caroline / Art / Painting',
      parentId: 'Caroline / Art',
      position: 0,
      content: 'Caroline painted a landscape.',
      observer: 'test-observer',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
  ];
}

function observationRow(id, observingPath, extractionRefs) {
  return {
    id,
    observingPath,
    text: `${observingPath.split('/').at(-1)?.trim() ?? id}\n\nObservation text.`,
    vector: [],
    extractionRefs,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };
}

function mockConfig() {
  return {
    extractor: {
      name: 'test-extractor',
      llm: 'default',
    },
    observer: {
      name: 'test-observer',
      llm: 'default',
    },
    llm: {
      default: {
        provider: 'mock',
      },
    },
    extraction: {
      embedding: {
        provider: 'mock',
        dimensions: 8,
      },
    },
  };
}
