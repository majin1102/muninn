import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { applyExtractionChanges, __testing as extractionTesting } from '../../dist/pipeline/extraction.js';
import { parseSnapshotContent } from '../../dist/pipeline/snapshot.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function snapshotWithMetadata(metadata) {
  return [
    '# Parser Boundaries',
    '',
    '## Summary',
    'The parser validates public context ids.',
    '',
    '## Instruction Signals',
    '',
    '## Skill Signals',
    '',
    '## Skill Details',
    '',
    '## Extractions',
    metadata,
    '### Title',
    'Parser boundary',
    '',
    '### Summary',
    'Public context ids must use UUIDs.',
  ].join('\n');
}

test('snapshot parser rejects non-UUID extraction context ids', () => {
  assert.throws(
    () => parseSnapshotContent(
      snapshotWithMetadata('<!-- context_id: ext:memory-1; refs: [turn:13] -->'),
      new Set(['turn:13']),
    ),
    /invalid extraction context_id: ext:memory-1/i,
  );
});

test('extraction state rewrite generates UUID ids for added extractions and preserves update ids', () => {
  const existingId = '123e4567-e89b-42d3-a456-426614174000';
  const result = applyExtractionChanges([
    { id: existingId, title: 'Old career', text: 'old career memory', references: ['turn:1'] },
  ], {
    title: 'T',
    snapshotContent: 'S',
    extractions: [
      { id: existingId, title: 'Career plan', text: 'updated career memory', references: ['turn:1', 'turn:3'] },
      { title: 'Painting preference', text: 'new painting memory', references: ['turn:4'] },
    ],
    nextSteps: [],
    contextRefs: [],
  });

  assert.equal(result.extractions[0].id, existingId);
  assert.match(result.extractions[1].id, UUID_RE);
});

test('extraction indexing preserves snapshot UUID ids for added rows', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'muninn-context-id-'));
  const homeDir = path.join(dir, 'muninn');
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(homeDir, { recursive: true });
  await writeFile(path.join(homeDir, 'muninn.json'), `${JSON.stringify({
    extractor: {
      name: 'default-extractor',
      llmProvider: 'extractor_llm',
      embeddingProvider: 'default',
    },
    providers: {
      llm: {
        extractor_llm: { type: 'mock' },
      },
      embedding: {
        default: { type: 'mock', dimensions: 8 },
      },
    },
  }, null, 2)}\n`, 'utf8');
  process.env.MUNINN_HOME = homeDir;

  const extractionId = '123e4567-e89b-42d3-a456-426614174000';
  const rows = [];
  const threads = [{
    sessionId: 'session-a',
    project: 'alpha',
    cwd: '/workspace/alpha',
    agent: 'codex',
    snapshotId: 'snapshot-0',
    snapshotIds: ['snapshot-0'],
    extractionEpoch: 1,
    title: 'Title',
    summary: 'Summary',
    snapshots: [{
      project: 'alpha',
      cwd: '/workspace/alpha',
      agent: 'codex',
      snapshotContent: '',
      extractions: [{
        id: extractionId,
        title: 'Remember this',
        text: 'remember this',
        references: ['turn:1'],
      }],
      contextRefs: [],
      nextSteps: [],
      extractionChanges: [],
    }],
    references: [],
    indexedSnapshotSequence: null,
    extractor: 'default-extractor',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  }];

  await extractionTesting.indexPendingExtractions({
    sessionTable: {
      upsert: async () => undefined,
    },
    extractionTable: {
      get: async () => [],
      delete: async () => ({ deleted: 0 }),
      upsert: async ({ rows: nextRows }) => rows.push(...nextRows),
    },
  }, threads);

  assert.equal(rows[0]?.id, extractionId);
});
