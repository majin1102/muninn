import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { hasPendingObserverWork, __testing } from '../dist/observer/runner.js';
import { observeCwdScope } from '../dist/llm/observing.js';

const { getObserverWorkStatus, runObserver } = __testing;
const CWD = '/Users/Nathan/workspace/muninn';

test('observe queue groups by cwd and replaces duplicate session observation rows', async () => {
  const { enqueueChanges } = await import('../dist/observer/queue.js');
  const first = sessionObservationRow('so-1', { summary: 'old text' });
  const latest = sessionObservationRow('so-1', { summary: 'latest text' });
  const queue = enqueueChanges({ cwdBuckets: [] }, [{ type: 'upsert', sessionObservation: first }]);
  const next = enqueueChanges(queue, [{ type: 'upsert', sessionObservation: latest }]);

  assert.equal(next.cwdBuckets.length, 1);
  assert.equal(next.cwdBuckets[0].key, CWD);
  assert.equal(next.cwdBuckets[0].sessionObservationChanges.length, 1);
  assert.equal(next.cwdBuckets[0].sessionObservationChanges[0].sessionObservation.summary, 'latest text');
});

test('observe queue keeps old cwd bucket when a session observation moves cwd', async () => {
  const { enqueueChanges } = await import('../dist/observer/queue.js');
  const oldRow = sessionObservationRow('so-1', { cwd: '/repo/old', summary: 'old' });
  const newRow = sessionObservationRow('so-1', { cwd: '/repo/new', summary: 'new' });
  const queue = enqueueChanges({ cwdBuckets: [] }, [{ type: 'upsert', sessionObservation: oldRow }]);
  const next = enqueueChanges(queue, [{ type: 'upsert', sessionObservation: newRow }]);

  assert.deepEqual(next.cwdBuckets.map((bucket) => bucket.key), ['/repo/old', '/repo/new']);
  assert.equal(next.cwdBuckets[0].sessionObservationChanges[0].sessionObservation.summary, 'new');
  assert.equal(next.cwdBuckets[1].sessionObservationChanges[0].sessionObservation.summary, 'new');
});

test('observe queue batches and acks one cwd bucket', async () => {
  const { enqueueChanges, readyBucket, ackBucket } = await import('../dist/observer/queue.js');
  let queue = { cwdBuckets: [] };
  for (let index = 0; index < 9; index += 1) {
    queue = enqueueChanges(queue, [{
      type: 'upsert',
      sessionObservation: sessionObservationRow(`so-${index}`),
    }]);
  }

  const bucket = readyBucket(queue, { threshold: 8, batchSize: 4, finalize: false });
  assert.equal(bucket.cwd, CWD);
  assert.equal(bucket.sessionObservationChanges.length, 4);

  const acked = ackBucket(queue, bucket.key, bucket.sessionObservationChanges.map((change) => change.sessionObservation.id));
  assert.equal(acked.cwdBuckets[0].sessionObservationChanges.length, 5);
});

test('hasPendingObserverWork waits for cwd threshold without advancing baseline', async () => {
  const client = makeClient({ sessionObservations: makeSessionObservations(4) });

  assert.equal(await hasPendingObserverWork({ client, baselineVersion: 0, cwdThreshold: 5 }), false);
  assert.deepEqual(
    await getObserverWorkStatus({ client, baselineVersion: 0, cwdThreshold: 5 }),
    { changed: true, pending: false, groupCount: 1, baselineVersion: 1 },
  );
});

test('hasPendingObserverWork reports pending when cwd threshold is reached', async () => {
  const client = makeClient({ sessionObservations: makeSessionObservations(5) });

  assert.equal(await hasPendingObserverWork({ client, baselineVersion: 0, cwdThreshold: 5 }), true);
});

test('getObserverWorkStatus ignores session observations without cwd', async () => {
  const client = makeClient({
    sessionObservations: makeSessionObservations(2).map((row) => ({ ...row, cwd: '' })),
  });

  assert.deepEqual(
    await getObserverWorkStatus({ client, baselineVersion: 0, cwdThreshold: 5 }),
    { changed: true, pending: false, groupCount: 0, baselineVersion: 1 },
  );
});

test('runObserver finalizes pending session observations below threshold', async (t) => {
  await useMockHome(t, 'muninn-observer-runner-finalize-');
  let observedInput = null;
  const client = makeClient({ sessionObservations: makeSessionObservations(2) });

  const result = await runObserver({
    client,
    observerName: 'test-observer',
    baselineVersion: 0,
    cwdThreshold: 5,
    finalize: true,
    observeCwdScopeImpl: async (input) => {
      observedInput = input;
      return observerResult(input.cwdScope, input.extractions.map((extraction) => extraction.id));
    },
  });

  assert.deepEqual(result, { observed: 1, skipped: 0, baselineVersion: 1 });
  assert.equal(observedInput.cwdScope, CWD);
  assert.deepEqual(observedInput.extractions.map((extraction) => extraction.id), ['so-1', 'so-2']);
  assert.equal(client.writes.globalObservationContexts.length, 2);
  assert.equal(client.writes.globalObservations.length, 1);
  assert.deepEqual(
    client.writes.sessionObservations.map((row) => [row.id, row.globalObservationPaths]),
    [['so-1', [`${CWD} / Work / Decision`]], ['so-2', [`${CWD} / Work / Decision`]]],
  );
});

test('runObserver skips until cwd threshold is reached', async () => {
  const client = makeClient({ sessionObservations: makeSessionObservations(4) });

  const result = await runObserver({
    client,
    observerName: 'test-observer',
    baselineVersion: 0,
    cwdThreshold: 5,
    observeCwdScopeImpl: async () => {
      throw new Error('observeCwdScopeImpl should not be called before threshold');
    },
  });

  assert.deepEqual(result, { observed: 0, skipped: 1, baselineVersion: 0 });
});

test('runObserver preserves unrelated cwd global observation branches', async (t) => {
  await useMockHome(t, 'muninn-observer-runner-cwd-scope-');
  const oldPath = `${CWD} / Existing / Leaf`;
  const otherPath = '/Users/Nathan/workspace/lance / Existing / Leaf';
  const client = makeClient({
    contexts: [
      contextRow(`${CWD} / Existing`, null, ''),
      contextRow(oldPath, `${CWD} / Existing`, 'Old content.', ['so-1']),
      contextRow('/Users/Nathan/workspace/lance / Existing', null, ''),
      contextRow(otherPath, '/Users/Nathan/workspace/lance / Existing', 'Other cwd content.', ['other']),
    ],
    globalObservations: [
      globalObservationRow(oldPath, ['so-1']),
      globalObservationRow(otherPath, ['other']),
    ],
    sessionObservations: [
      sessionObservationRow('so-1', { globalObservationPaths: [oldPath] }),
    ],
  });

  await runObserver({
    client,
    observerName: 'test-observer',
    baselineVersion: 0,
    cwdThreshold: 5,
    finalize: true,
    observeCwdScopeImpl: async (input) => observerResult(input.cwdScope, [input.extractions[0].id]),
  });

  assert.equal(client.writes.deletedGlobalObservationIds.includes(otherPath), false);
  assert.equal(client.writes.deletedContextIds.includes(otherPath), false);
});

test('observeCwdScope accepts slash-containing cwd as root title', async (t) => {
  await useMockHome(t, 'muninn-observer-cwd-title-');

  const result = await observeCwdScope({
    cwdScope: CWD,
    outline: `# ${CWD}\n\n(empty)`,
    observedDocument: '',
    extractions: [{
      id: 'so-1',
      status: 'new',
      text: 'The project should use cwd-scoped observer grouping.',
      context: null,
      cwd: CWD,
      turnRefs: ['turn:1'],
    }],
    getGlobalObservation: () => `# ${CWD}`,
    maxAttempts: 1,
    model: async () => ({
      type: 'final',
      text: `## Work

### Decision
The observer groups session observations by cwd.

Source extractions:
- [so-1]`,
    }),
  });

  assert.equal(result.title, CWD);
  assert.equal(result.sections[0].globalPath, `${CWD} / Work`);
  assert.equal(result.sections[0].children[0].globalPath, `${CWD} / Work / Decision`);
});

test('observeCwdScope exposes get_observation tool without memory-get', async (t) => {
  await useMockHome(t, 'muninn-observer-tool-');

  const toolNames = [];
  let calls = 0;
  const result = await observeCwdScope({
    cwdScope: CWD,
    outline: `# ${CWD}\n- leaf: ${CWD} / Work / Decision`,
    observedDocument: '',
    extractions: [{
      id: 'so-1',
      status: 'changed',
      text: 'Decision was updated.',
      context: null,
      cwd: CWD,
      turnRefs: ['turn:1'],
    }],
    getGlobalObservation: () => `# ${CWD}

## Work

### Decision
Previous decision content.

Source extractions:
- [so-old]`,
    validRefs: ['so-old'],
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
            arguments: { paths: [`${CWD} / Work / Decision`] },
          }],
        };
      }
      return {
        type: 'final',
        text: `## Work

### Decision
Updated decision content.

Source extractions:
- [so-old]
- [so-1]`,
      };
    },
  });

  assert.deepEqual([...new Set(toolNames)], ['get_observation']);
  assert.equal(result.sections[0].children[0].sourceRefs.includes('so-1'), true);
});

test('observeCwdScope rejects more than three get_observation calls', async (t) => {
  await useMockHome(t, 'muninn-observer-tool-steps-');

  let calls = 0;
  await assert.rejects(() => observeCwdScope({
    cwdScope: CWD,
    outline: `# ${CWD}\n- leaf: ${CWD} / Work / Decision`,
    observedDocument: '',
    extractions: [{
      id: 'so-1',
      status: 'changed',
      text: 'Decision was updated.',
      context: null,
      cwd: CWD,
      turnRefs: ['turn:1'],
    }],
    getGlobalObservation: () => `# ${CWD}`,
    validRefs: ['so-old'],
    maxAttempts: 1,
    model: async () => {
      calls += 1;
      if (calls <= 4) {
        return {
          type: 'tool_calls',
          toolCalls: [{
            id: `call-${calls}`,
            name: 'get_observation',
            arguments: { paths: [`${CWD} / Work / Decision`] },
          }],
        };
      }
      return {
        type: 'final',
        text: `## Work

### Decision
Updated decision content.

Source extractions:
- [so-1]`,
      };
    },
  }), /get_observation exceeded max calls=3/);

  assert.equal(calls, 4);
});

test('observeCwdScope writes observer trace with cwd input', async (t) => {
  const { tracePath } = await useMockHome(t, 'muninn-observer-trace-', true);

  const result = await observeCwdScope({
    cwdScope: CWD,
    outline: `# ${CWD}\n\n(empty)`,
    observedDocument: '',
    extractions: [{
      id: 'so-1',
      status: 'new',
      text: 'Trace should include cwd scoped observer input.',
      context: null,
      cwd: CWD,
      turnRefs: ['turn:1'],
    }],
    getGlobalObservation: () => `# ${CWD}`,
    maxAttempts: 1,
    model: async () => ({
      type: 'final',
      text: `## Work

### Trace
Trace includes cwd scope.

Source extractions:
- [so-1]`,
    }),
  });

  assert.equal(result.title, CWD);
  const trace = JSON.parse(await readFile(tracePath, 'utf8'));
  assert.equal(trace.input.cwdScope, CWD);
  assert.match(trace.prompt.system, /observer that maintains parts of a cross-session observation tree/);
  assert.match(trace.prompt.user, /SessionObservation units:/);
  assert.equal(trace.document.title, CWD);
});

function makeClient({
  sessionObservations,
  contexts = [],
  globalObservations = [],
  version = 1,
}) {
  const normalizedContexts = contexts.map((context) => {
    const observation = globalObservations.find((row) => row.id === context.id);
    return {
      sourceRefs: observation?.sessionObservationRefs ?? [],
      expandRefs: observation?.sessionObservationRefs ?? [],
      ...context,
    };
  });
  const writes = {
    globalObservationContexts: [],
    globalObservations: [],
    sessionObservations: [],
    deletedContextIds: [],
    deletedGlobalObservationIds: [],
  };
  return {
    writes,
    sessionObservationTable: {
      stats: async () => ({
        version,
        fragmentCount: 1,
        rowCount: sessionObservations.length,
      }),
      get: async ({ ids }) => sessionObservations.filter((row) => ids.includes(row.id)),
      delta: async ({ baselineVersion }) => (
        baselineVersion < version ? sessionObservations : []
      ),
      upsert: async ({ rows }) => {
        writes.sessionObservations.push(...rows);
      },
    },
    globalObservationContextTable: {
      list: async () => normalizedContexts,
      get: async ({ ids }) => normalizedContexts.filter((row) => ids.includes(row.id)),
      upsert: async ({ rows }) => {
        writes.globalObservationContexts.push(...rows);
      },
      delete: async ({ ids }) => {
        writes.deletedContextIds.push(...ids);
        return { deleted: ids.length };
      },
    },
    globalObservationTable: {
      get: async ({ ids }) => globalObservations.filter((row) => ids.includes(row.id)),
      upsert: async ({ rows }) => {
        writes.globalObservations.push(...rows);
      },
      delete: async ({ ids }) => {
        writes.deletedGlobalObservationIds.push(...ids);
        return { deleted: ids.length };
      },
    },
  };
}

function observerResult(cwdScope, refs) {
  return {
    title: cwdScope,
    sections: [{
      level: 2,
      heading: 'Work',
      globalPath: `${cwdScope} / Work`,
      sourceRefs: [],
      expandRefs: [],
      body: '',
      children: [{
        level: 3,
        heading: 'Decision',
        globalPath: `${cwdScope} / Work / Decision`,
        sourceRefs: refs,
        expandRefs: refs,
        body: 'The cwd scoped observer groups related session observations.',
        children: [],
      }],
    }],
  };
}

function makeSessionObservations(count, options = {}) {
  const offset = options.offset ?? 0;
  return Array.from({ length: count }, (_, index) =>
    sessionObservationRow(`so-${offset + index + 1}`, {
      turnRefs: [`turn:${offset + index + 1}`],
      ...options,
    }));
}

function sessionObservationRow(id, overrides = {}) {
  const title = overrides.title ?? `Session observation ${id}`;
  const summary = overrides.summary ?? `${title}: compact summary.`;
  return {
    id,
    title,
    summary,
    content: overrides.content ?? [
      '## Title',
      '',
      title,
      '',
      '## Summary',
      '',
      summary,
      '',
      '## Content',
      '',
      '- Detailed content.',
    ].join('\n'),
    cwd: overrides.cwd ?? CWD,
    vector: overrides.vector ?? [0.1, 0.2],
    turnRefs: overrides.turnRefs ?? ['turn:1'],
    globalObservationPaths: overrides.globalObservationPaths ?? [],
    createdAt: overrides.createdAt ?? '2026-05-17T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-05-17T00:00:00.000Z',
  };
}

function contextRow(globalPath, parentId, content, refs = []) {
  return {
    id: globalPath,
    globalPath,
    parentId,
    position: 0,
    content,
    sourceRefs: refs,
    expandRefs: refs,
    observer: 'test-observer',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };
}

function globalObservationRow(globalPath, refs) {
  return {
    id: globalPath,
    globalPath,
    text: `${globalPath}\n\nGlobal observation text.`,
    vector: [0.3, 0.4],
    sessionObservationRefs: refs,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };
}

async function useMockHome(t, prefix, trace = false) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const homeDir = path.join(dir, 'home');
  const tracePath = path.join(dir, 'observer-trace.jsonl');
  await mkdir(homeDir, { recursive: true });
  await writeFile(path.join(homeDir, 'muninn.json'), JSON.stringify(mockConfig(), null, 2));

  const previousHome = process.env.MUNINN_HOME;
  const previousTrace = process.env.MUNINN_OBSERVER_TRACE_FILE;
  process.env.MUNINN_HOME = homeDir;
  if (trace) {
    process.env.MUNINN_OBSERVER_TRACE_FILE = tracePath;
  }
  t.after(async () => {
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
    await rm(dir, { recursive: true, force: true });
  });
  return { homeDir, tracePath };
}

function mockConfig() {
  return {
    version: 1,
    storage: { type: 'lance', uri: 'memory' },
    defaults: {
      agent: 'test-agent',
      observer: 'test-observer',
      sessionId: 'test-session',
    },
    extractor: {
      name: 'test-extractor',
      llmProvider: 'extractor_llm',
      embeddingProvider: 'default',
    },
    observer: {
      enabled: true,
      name: 'test-observer',
      llmProvider: 'observer_llm',
      cwdThreshold: 5,
    },
    providers: {
      llm: {
        extractor_llm: { type: 'mock' },
        observer_llm: { type: 'mock' },
      },
      embedding: {
        default: {
          type: 'mock',
          dimensions: 4,
        },
      },
    },
  };
}
