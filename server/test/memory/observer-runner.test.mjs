import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { __testing } from '../../dist/pipeline/observation.js';
import { generateObservationPatch } from '../../dist/llm/observer.js';

const { applyObservationBatch } = __testing;
const CWD = '/Users/Nathan/workspace/muninn';

test('observe queue groups by cwd and replaces duplicate extraction rows', async () => {
  const { enqueueChanges } = await import('../../dist/pipeline/observer.js');
  const first = extractionRow('so-1', { summary: 'old text' });
  const latest = extractionRow('so-1', { summary: 'latest text' });
  const queue = enqueueChanges({ cwdBuckets: [] }, [{ type: 'upsert', extraction: first }]);
  const next = enqueueChanges(queue, [{ type: 'upsert', extraction: latest }]);

  assert.equal(next.cwdBuckets.length, 1);
  assert.equal(next.cwdBuckets[0].key, CWD);
  assert.equal(next.cwdBuckets[0].extractionChanges.length, 1);
  assert.equal(next.cwdBuckets[0].extractionChanges[0].extraction.summary, 'latest text');
});

test('observe queue keeps old cwd bucket when a extraction moves cwd', async () => {
  const { enqueueChanges } = await import('../../dist/pipeline/observer.js');
  const oldRow = extractionRow('so-1', { cwd: '/repo/old', summary: 'old' });
  const newRow = extractionRow('so-1', { cwd: '/repo/new', summary: 'new' });
  const queue = enqueueChanges({ cwdBuckets: [] }, [{ type: 'upsert', extraction: oldRow }]);
  const next = enqueueChanges(queue, [{ type: 'upsert', extraction: newRow }]);

  assert.deepEqual(next.cwdBuckets.map((bucket) => bucket.key), ['/repo/old', '/repo/new']);
  assert.equal(next.cwdBuckets[0].extractionChanges[0].extraction.summary, 'new');
  assert.equal(next.cwdBuckets[1].extractionChanges[0].extraction.summary, 'new');
});

test('observe queue batches and acks one cwd bucket', async () => {
  const { enqueueChanges, readyBucket, ackBucket } = await import('../../dist/pipeline/observer.js');
  let queue = { cwdBuckets: [] };
  for (let index = 0; index < 9; index += 1) {
    queue = enqueueChanges(queue, [{
      type: 'upsert',
      extraction: extractionRow(`so-${index}`),
    }]);
  }

  const bucket = readyBucket(queue, { threshold: 8, batchSize: 4, finalize: false });
  assert.equal(bucket.cwd, CWD);
  assert.equal(bucket.extractionChanges.length, 4);

  const acked = ackBucket(queue, bucket.key, bucket.extractionChanges.map((change) => change.extraction.id));
  assert.equal(acked.cwdBuckets[0].extractionChanges.length, 5);
});

test('applyObservationBatch writes queued cwd extractions', async (t) => {
  await useMockHome(t, 'muninn-observer-runner-finalize-');
  let observedInput = null;
  const client = makeClient({ extractions: makeExtractions(2) });

  const result = await applyObservationBatch({
    client,
    observerName: 'test-observer',
    cwd: CWD,
    extractionChanges: makeExtractions(2).map((extraction) => ({ type: 'upsert', extraction })),
    generateObservationPatchImpl: async (input) => {
      observedInput = input;
      return observerResult(input.cwdScope, input.extractions.map((extraction) => extraction.id));
    },
  });

  assert.deepEqual(result, { observed: 1, skipped: 0 });
  assert.equal(observedInput.cwdScope, CWD);
  assert.deepEqual(observedInput.extractions.map((extraction) => extraction.id), ['so-1', 'so-2']);
  assert.equal(client.writes.observationContexts.length, 2);
  assert.equal(client.writes.observations.length, 1);
  assert.deepEqual(
    client.writes.extractions.map((row) => [row.id, row.observationPaths]),
    [['so-1', [`${CWD} / Work / Decision`]], ['so-2', [`${CWD} / Work / Decision`]]],
  );
});

test('applyObservationBatch preserves unrelated cwd observation branches', async (t) => {
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
    observations: [
      observationRow(oldPath, ['so-1']),
      observationRow(otherPath, ['other']),
    ],
    extractions: [
      extractionRow('so-1', { observationPaths: [oldPath] }),
    ],
  });

  await applyObservationBatch({
    client,
    observerName: 'test-observer',
    cwd: CWD,
    extractionChanges: [{ type: 'upsert', extraction: extractionRow('so-1', { observationPaths: [oldPath] }) }],
    generateObservationPatchImpl: async (input) => observerResult(input.cwdScope, [input.extractions[0].id]),
  });

  assert.equal(client.writes.deletedObservationIds.includes(otherPath), false);
  assert.equal(client.writes.deletedContextIds.includes(otherPath), false);
});

test('generateObservationPatch accepts slash-containing cwd as root title', async (t) => {
  await useMockHome(t, 'muninn-observer-cwd-title-');

  const result = await generateObservationPatch({
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
    getObservation: () => `# ${CWD}`,
    maxAttempts: 1,
    model: async () => ({
      type: 'final',
      text: `## Work

### Decision
The observer groups extractions by cwd.

Source extractions:
- [so-1]`,
    }),
  });

  assert.equal(result.title, CWD);
  assert.equal(result.sections[0].path, `${CWD} / Work`);
  assert.equal(result.sections[0].children[0].path, `${CWD} / Work / Decision`);
});

test('generateObservationPatch exposes get_observation tool without memory-get', async (t) => {
  await useMockHome(t, 'muninn-observer-tool-');

  const toolNames = [];
  let calls = 0;
  const result = await generateObservationPatch({
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
    getObservation: () => `# ${CWD}

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

test('generateObservationPatch rejects more than three get_observation calls', async (t) => {
  await useMockHome(t, 'muninn-observer-tool-steps-');

  let calls = 0;
  await assert.rejects(() => generateObservationPatch({
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
    getObservation: () => `# ${CWD}`,
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

test('generateObservationPatch writes observer trace with cwd input', async (t) => {
  const { tracePath } = await useMockHome(t, 'muninn-observer-trace-', true);

  const result = await generateObservationPatch({
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
    getObservation: () => `# ${CWD}`,
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
  assert.match(trace.prompt.system, /observer that maintains parts of a cross-extraction tree/);
  assert.match(trace.prompt.user, /Extraction units:/);
  assert.equal(trace.document.title, CWD);
});

function makeClient({
  extractions,
  contexts = [],
  observations = [],
  version = 1,
}) {
  const normalizedContexts = contexts.map((context) => {
    const observation = observations.find((row) => row.id === context.id);
    return {
      sourceRefs: observation?.extractionRefs ?? [],
      expandRefs: observation?.extractionRefs ?? [],
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
        version,
        fragmentCount: 1,
        rowCount: extractions.length,
      }),
      get: async ({ ids }) => extractions.filter((row) => ids.includes(row.id)),
      delta: async ({ baselineVersion }) => (
        baselineVersion < version ? extractions : []
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

function observerResult(cwdScope, refs) {
  return {
    title: cwdScope,
    sections: [{
      level: 2,
      heading: 'Work',
      path: `${cwdScope} / Work`,
      sourceRefs: [],
      expandRefs: [],
      body: '',
      children: [{
        level: 3,
        heading: 'Decision',
        path: `${cwdScope} / Work / Decision`,
        sourceRefs: refs,
        expandRefs: refs,
        body: 'The cwd scoped observer groups related extractions.',
        children: [],
      }],
    }],
  };
}

function makeExtractions(count, options = {}) {
  const offset = options.offset ?? 0;
  return Array.from({ length: count }, (_, index) =>
    extractionRow(`so-${offset + index + 1}`, {
      turnRefs: [`turn:${offset + index + 1}`],
      ...options,
    }));
}

function extractionRow(id, overrides = {}) {
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
    observationPaths: overrides.observationPaths ?? [],
    createdAt: overrides.createdAt ?? '2026-05-17T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-05-17T00:00:00.000Z',
  };
}

function contextRow(path, parentId, content, refs = []) {
  return {
    id: path,
    path,
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

function observationRow(path, refs) {
  return {
    id: path,
    path,
    text: `${path}\n\nObservation text.`,
    vector: [0.3, 0.4],
    extractionRefs: refs,
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
