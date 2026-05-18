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

test('runObserver finalizes pending extractions below threshold', async () => {
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
          id: undefined,
          refs: [],
          delete: false,
          body: '',
          children: input.extractions.map((extraction) => ({
            level: 3,
            heading: extraction.id,
            id: undefined,
            refs: [extraction.id],
            delete: false,
            body: '',
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
        id: 'parent-1',
        observingPath: 'Caroline / Who is Caroline?',
        parentId: null,
        position: 0,
        content: 'Caroline overview.',
        observer: 'test-observer',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
      {
        id: 'leaf-1',
        observingPath: 'Caroline / Who is Caroline? / Support group',
        parentId: 'parent-1',
        position: 0,
        content: 'Caroline attended a support group.',
        observer: 'test-observer',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
    ],
    observations: [{
      id: 'leaf-1',
      observingPath: 'Caroline / Who is Caroline? / Support group',
      text: 'Caroline attended a support group.',
      vector: [],
      extractionRefs: ['extraction:old'],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    }],
    extractions: [{ ...makeExtractions(1)[0], observationIds: ['leaf-1'] }],
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
          id: 'parent-1',
          refs: [],
          delete: false,
          body: '',
          children: [{
            level: 3,
            heading: 'Support group',
            id: 'leaf-1',
            refs: ['extraction:old'],
            delete: false,
            body: '',
            children: [],
          }],
        }],
      };
    },
  });

  assert.match(observedInput.outline, /Support group <!-- id: leaf-1; leaf -->/);
  assert.match(observedInput.rewriteContent, /Support group <!-- id: leaf-1; refs: \[extraction:old\] -->/);
});

test('runObserver removes changed extraction refs from existing leaf hints', async () => {
  let observedInput = null;
  const client = makeClient({
    contexts: [
      {
        id: 'parent-1',
        observingPath: 'Caroline / Who is Caroline?',
        parentId: null,
        position: 0,
        content: 'Caroline overview.',
        observer: 'test-observer',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
      {
        id: 'leaf-1',
        observingPath: 'Caroline / Who is Caroline? / Support group',
        parentId: 'parent-1',
        position: 0,
        content: 'Caroline attended a support group.',
        observer: 'test-observer',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
    ],
    observations: [{
      id: 'leaf-1',
      observingPath: 'Caroline / Who is Caroline? / Support group',
      text: 'Caroline attended a support group.',
      vector: [],
      extractionRefs: ['extraction:old', 'pending-1'],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    }],
    extractions: [{ ...makeExtractions(1)[0], observationIds: ['leaf-1'] }],
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
          id: 'parent-1',
          refs: [],
          delete: false,
          body: '',
          children: [{
            level: 3,
            heading: 'Support group',
            id: 'leaf-1',
            refs: ['extraction:old', input.extractions[0].id],
            delete: false,
            body: '',
            children: [],
          }],
        }],
      };
    },
  });

  assert.match(observedInput.rewriteContent, /Support group <!-- id: leaf-1; refs: \[extraction:old\] -->/);
  assert.doesNotMatch(observedInput.rewriteContent, /refs: \[extraction:old, pending-1\]/);
  assert.deepEqual(observedInput.extractions.map((extraction) => extraction.id), ['pending-1']);
});

test('runObserver sends full outline but only linked rewrite content', async () => {
  let observedInput = null;
  const client = makeClient({
    contexts: existingCarolineContexts(),
    observations: [
      observationRow('support-leaf', 'Caroline / Support / Support group', ['pending-1']),
      observationRow('painting-leaf', 'Caroline / Art / Painting', ['extraction:painting']),
    ],
    extractions: [
      {
        ...extractionRow('pending-1', ['Entity: Caroline'], 'Caroline updated support group details.'),
        observationIds: ['support-leaf'],
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
          id: 'support-parent',
          refs: [],
          delete: false,
          body: '',
          children: [{
            level: 3,
            heading: 'Support group',
            id: 'support-leaf',
            refs: ['pending-1'],
            delete: false,
            body: '',
            children: [],
          }],
        }],
      };
    },
  });

  assert.match(observedInput.outline, /Support group <!-- id: support-leaf; leaf -->/);
  assert.match(observedInput.outline, /Painting <!-- id: painting-leaf; leaf -->/);
  assert.match(observedInput.rewriteContent, /Support group <!-- id: support-leaf/);
  assert.doesNotMatch(observedInput.rewriteContent, /Painting <!-- id: painting-leaf/);
  assert.deepEqual(observedInput.extractions.map((extraction) => extraction.status), ['changed']);
});

test('runObserver preserves sibling branches outside returned subtree', async () => {
  const client = makeClient({
    contexts: existingCarolineContexts(),
    observations: [
      observationRow('support-leaf', 'Caroline / Support / Support group', ['pending-1']),
      observationRow('painting-leaf', 'Caroline / Art / Painting', ['extraction:painting']),
    ],
    extractions: [
      {
        ...extractionRow('pending-1', ['Entity: Caroline'], 'Caroline updated support group details.'),
        observationIds: ['support-leaf'],
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
        id: 'support-parent',
        refs: [],
        delete: false,
        body: '',
        children: [{
          level: 3,
          heading: 'Support group',
          id: 'support-leaf',
          refs: ['pending-1'],
          delete: false,
          body: '',
          children: [],
        }],
      }],
    }),
  });

  assert.equal(client.writes.deletedObservationIds.includes('painting-leaf'), false);
  assert.equal(client.writes.observationContexts.some((row) => row.id === 'painting-leaf'), false);
});

test('runObserver get_observation returns selected subtree without siblings', async () => {
  let toolContent = '';
  const client = makeClient({
    contexts: existingCarolineContexts(),
    observations: [
      observationRow('support-leaf', 'Caroline / Support / Support group', ['extraction:support']),
      observationRow('painting-leaf', 'Caroline / Art / Painting', ['extraction:painting']),
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
      toolContent = await input.getObservation('painting-leaf');
      return {
        title: 'Caroline',
        sections: [{
          level: 2,
          heading: 'Art',
          id: 'painting-parent',
          refs: [],
          delete: false,
          body: '',
          children: [{
            level: 3,
            heading: 'Painting',
            id: 'painting-leaf',
            refs: ['extraction:painting', input.extractions[0].id],
            delete: false,
            body: '',
            children: [],
          }],
        }],
      };
    },
  });

  assert.match(toolContent, /# Caroline/);
  assert.match(toolContent, /## Art <!-- id: painting-parent -->/);
  assert.match(toolContent, /### Painting <!-- id: painting-leaf; refs: \[extraction:painting\] -->/);
  assert.doesNotMatch(toolContent, /Support group/);
});

test('runObserver get_observation returns non-leaf subtree without sibling branches', async () => {
  let toolContent = '';
  const client = makeClient({
    contexts: [
      ...existingCarolineContexts(),
      {
        id: 'music-leaf',
        observingPath: 'Caroline / Art / Music',
        parentId: 'painting-parent',
        position: 1,
        content: 'Caroline plays piano.',
        observer: 'test-observer',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
    ],
    observations: [
      observationRow('support-leaf', 'Caroline / Support / Support group', ['extraction:support']),
      observationRow('painting-leaf', 'Caroline / Art / Painting', ['extraction:painting']),
      observationRow('music-leaf', 'Caroline / Art / Music', ['extraction:music']),
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
      toolContent = await input.getObservation('painting-parent');
      return {
        title: 'Caroline',
        sections: [{
          level: 2,
          heading: 'Art',
          id: 'painting-parent',
          refs: [],
          delete: false,
          body: 'Art overview.',
          children: [{
            level: 3,
            heading: 'Painting',
            id: 'painting-leaf',
            refs: ['extraction:painting'],
            delete: false,
            body: '',
            children: [],
          }, {
            level: 3,
            heading: 'Music',
            id: 'music-leaf',
            refs: ['extraction:music'],
            delete: false,
            body: '',
            children: [],
          }],
        }],
      };
    },
  });

  assert.match(toolContent, /# Caroline/);
  assert.match(toolContent, /## Art <!-- id: painting-parent -->/);
  assert.match(toolContent, /### Painting <!-- id: painting-leaf; refs: \[extraction:painting\] -->/);
  assert.match(toolContent, /### Music <!-- id: music-leaf; refs: \[extraction:music\] -->/);
  assert.doesNotMatch(toolContent, /Support group/);
});

test('runObserver applies a rootless leaf rewrite to its existing parent', async () => {
  const client = makeClient({
    contexts: existingCarolineContexts(),
    observations: [
      observationRow('support-leaf', 'Caroline / Support / Support group', ['pending-1']),
    ],
    extractions: [
      {
        ...extractionRow('pending-1', ['Entity: Caroline'], 'Caroline updated support group details.'),
        observationIds: ['support-leaf'],
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
        level: 3,
        heading: 'Support group',
        id: 'support-leaf',
        refs: ['pending-1'],
        delete: false,
        body: '',
        children: [],
      }],
    }),
  });

  assert.equal(client.writes.observationContexts[0].parentId, 'support-parent');
  assert.equal(client.writes.observationContexts[0].observingPath, 'Caroline / Support / Support group');
});

test('observeAnchor accepts rootless leaf markdown for exact leaf rewrites', async (t) => {
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
    rewriteContent: '',
    extractions: [{
      id: 'ext-a',
      status: 'changed',
      text: 'Caroline updated support details.',
      context: null,
      anchors: ['Entity: Caroline'],
      turnRefs: ['turn:1'],
    }],
    getObservation: () => '# Caroline',
    maxAttempts: 1,
    model: async () => ({
      type: 'final',
      text: `### Support group <!-- id: 11111111-1111-4111-8111-111111111111; refs: [ext-a] -->

Caroline updated support details.`,
    }),
  });

  assert.equal(result.title, 'Caroline');
  assert.equal(result.sections[0].level, 3);
  assert.equal(result.sections[0].heading, 'Support group');
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
        id: undefined,
        refs: [],
        delete: false,
        body: 'Caroline overview.',
        children: [{
          level: 3,
          heading: 'Support group',
          id: undefined,
          refs: [input.extractions[0].id],
          delete: false,
          body: 'Caroline attended a support group.',
          children: [],
        }],
      }],
    }),
  });

  const ids = client.writes.observations.map((row) => row.id);
  assert.equal(ids.length, new Set(ids).size);
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
        id: undefined,
        refs: [],
        delete: false,
        body: 'Parent overview should not enter leaf observation text.',
        children: [{
          level: 3,
          heading: 'Support group',
          id: undefined,
          refs: [input.extractions[0].id],
          delete: false,
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
      id: 'parent-1',
      observingPath: 'Caroline / Who is Caroline?',
      parentId: null,
      position: 0,
      content: 'Parent overview.',
      observer: 'test-observer',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    }],
    observations: [{
      id: 'parent-1',
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
        id: 'parent-1',
        refs: [],
        delete: false,
        body: 'Parent overview.',
        children: [{
          level: 3,
          heading: 'Support group',
          id: undefined,
          refs: [input.extractions[0].id],
          delete: false,
          body: 'Caroline attended a support group.',
          children: [],
        }],
      }],
    }),
  });

  assert.deepEqual(client.writes.deletedObservationIds, ['parent-1']);
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
    rewriteContent: '',
    extractions: [{
      id: 'ext-a',
      status: 'new',
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
  assert.match(trace.prompt.system, /observer that rewrites part of a cross-session observation document/);
  assert.match(trace.prompt.user, /Observation outline:/);
  assert.match(trace.prompt.user, /Rewrite content:/);
  assert.match(trace.prompt.user, /Extraction units:/);
  assert.match(trace.finalText, /# Mock entity/);
  assert.equal(trace.document.title, 'Mock entity');
  assert.equal(trace.document.sections[0].children[0].refs[0], 'ext-a');
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
    outline: '# Caroline\n- ### Support group <!-- id: 11111111-1111-4111-8111-111111111111; leaf -->',
    rewriteContent: '',
    extractions: [{
      id: 'ext-a',
      status: 'new',
      text: 'Caroline attended an LGBTQ support group.',
      context: null,
      anchors: ['Entity: Caroline'],
      turnRefs: ['turn:1'],
    }],
    getObservation: (id) => `# Caroline

### Support group <!-- id: ${id}; refs: [ext-old] -->

Caroline previously attended a support group.`,
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
            arguments: { id: '11111111-1111-4111-8111-111111111111' },
          }],
        };
      }
      return {
        type: 'final',
        text: `# Caroline

## Support <!-- id: 11111111-1111-4111-8111-111111111111; refs: [ext-old, ext-a] -->

Caroline attended an LGBTQ support group.`,
      };
    },
  });

  assert.deepEqual([...new Set(toolNames)], ['get_observation']);
  assert.equal(result.sections[0].refs.includes('ext-a'), true);
});

function makeClient({ extractions, contexts = [], observations = [], extractionVersion = 1 }) {
  const writes = {
    observationContexts: [],
    observations: [],
    extractions: [],
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
      delta: async ({ baselineVersion }) => (
        baselineVersion < extractionVersion ? extractions : []
      ),
      upsert: async ({ rows }) => {
        writes.extractions.push(...rows);
      },
    },
    observationContextTable: {
      list: async () => contexts,
      upsert: async ({ rows }) => {
        writes.observationContexts.push(...rows);
      },
      delete: async () => ({ deleted: 0 }),
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

function extractionRow(id, anchors, text) {
  return {
    id,
    text,
    context: null,
    anchors,
    vector: [0.1, 0.2],
    importance: 0.5,
    category: 'Fact',
    turnRefs: ['turn:1'],
    observationIds: [],
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
    observationIds: [],
    observedRootAnchors: options.observed ? ['Caroline'] : [],
  }));
}

function existingCarolineContexts() {
  return [
    {
      id: 'support-parent',
      observingPath: 'Caroline / Support',
      parentId: null,
      position: 0,
      content: 'Support overview.',
      observer: 'test-observer',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
    {
      id: 'support-leaf',
      observingPath: 'Caroline / Support / Support group',
      parentId: 'support-parent',
      position: 0,
      content: 'Caroline attended a support group.',
      observer: 'test-observer',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
    {
      id: 'painting-parent',
      observingPath: 'Caroline / Art',
      parentId: null,
      position: 1,
      content: 'Art overview.',
      observer: 'test-observer',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
    {
      id: 'painting-leaf',
      observingPath: 'Caroline / Art / Painting',
      parentId: 'painting-parent',
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
