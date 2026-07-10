import assert from 'node:assert/strict';
import test from 'node:test';

import core from '../dist/backend.js';
import { memories as backendMemories } from '../dist/backend.js';
import { app } from '../dist/http.js';
import {
  Memories,
  extractionContextId,
  parseContextId,
  turnContextId,
} from '../dist/api/memory.js';

const sessionIdentity = { project: 'project-a', agent: 'codex', sessionId: 'session-a' };
const sessionContext = 'session:1';
const turnContext = turnContextId('turn:1');
const extractionContext = extractionContextId('123e4567-e89b-42d3-a456-426614174000');

test.afterEach(async () => {
  await core.shutdownCoreForTests();
});

test('context ids use public context handles directly', () => {
  assert.deepEqual(parseContextId(sessionContext), {
    kind: 'session',
    contextId: sessionContext,
    id: '1',
  });

  assert.equal(turnContext, 'turn:1');
  assert.deepEqual(parseContextId(turnContext), {
    kind: 'turn',
    contextId: 'turn:1',
    id: '1',
  });
  assert.throws(() => turnContextId('extraction:1'), /invalid turn context id/);
  assert.throws(() => turnContextId('turn:'), /invalid turn context id/);

  assert.equal(extractionContext, 'ext:123e4567-e89b-42d3-a456-426614174000');
  assert.deepEqual(parseContextId(extractionContext), {
    kind: 'extraction',
    contextId: extractionContext,
    id: '123e4567-e89b-42d3-a456-426614174000',
  });

  assert.throws(() => parseContextId('session_WyJwcm9qZWN0LWEiLCJjb2RleCIsInNlc3Npb24tYSJd'), /unsupported context id/);
  assert.throws(() => parseContextId('session:123e4567-e89b-42d3-a456-426614174000'), /invalid session context id/);
  assert.throws(() => parseContextId('turn_MQ'), /unsupported context id/);
});

test('readContextIds resolves session and turn ids without source provenance', async () => {
  const memories = new Memories(makeContextClient());

  const contexts = await memories.readContextIds([
    sessionContext,
    turnContext,
    'invalid_context',
    'turn:2',
  ]);

  assert.equal(contexts[0].contextId, sessionContext);
  assert.equal(contexts[0].title, 'Session title');
  assert.match(contexts[0].content, /^# Session title$/m);
  assert.match(contexts[0].content, /^Session summary$/m);
  assert.match(contexts[0].content, /^## Extractions$/m);
  assert.match(contexts[0].content, /context_id: ext:123e4567-e89b-42d3-a456-426614174000/);
  assert.match(contexts[0].content, /summary: Caroline compared adoption agency options/);
  assert.doesNotMatch(contexts[0].content, /Hidden detailed content/);
  assert.doesNotMatch(contexts[0].content, /Source Provenance/);

  assert.equal(contexts[1].contextId, turnContext);
  assert.match(contexts[1].content, /^# turn:1$/m);
  assert.match(contexts[1].content, /Prompt: User asked about context ids/);
  assert.match(contexts[1].content, /Response: Assistant explained them/);
  assert.doesNotMatch(contexts[1].content, /Source Provenance/);

  assert.match(contexts[2].error, /unsupported context id/);
  assert.match(contexts[3].error, /not found/);
});

test('readContextIds rejects ordinary storage errors instead of returning per-id errors', async () => {
  await assert.rejects(
    () => new Memories({
      sessionSnapshotTable: {
        getSnapshot: async () => {
          throw new Error('storage connection failed');
        },
      },
    }).readContextIds([sessionContext]),
    /storage connection failed/,
  );

  await assert.rejects(
    () => new Memories({
      turnTable: {
        getTurn: async () => {
          throw new Error('turn table unavailable');
        },
      },
    }).readContextIds([turnContext]),
    /turn table unavailable/,
  );
});

test('context HTTP routes reject invalid bodies before backend lookup', async () => {
  const readMissingBody = await app.request('/api/v1/context/read', { method: 'POST' });
  assert.equal(readMissingBody.status, 400);
  assert.match((await readMissingBody.json()).errorMessage, /Invalid JSON body/);

  const readBadIds = await app.request('/api/v1/context/read', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ context_ids: [] }),
  });
  assert.equal(readBadIds.status, 400);
  assert.match((await readBadIds.json()).errorMessage, /context_ids must be a non-empty array/);

  const readNonStringIds = await app.request('/api/v1/context/read', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ context_ids: [sessionContext, 123] }),
  });
  assert.equal(readNonStringIds.status, 400);
  assert.match((await readNonStringIds.json()).errorMessage, /context_ids must contain only strings/);

  const explainResponse = await app.request('/api/v1/context/explain', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ context_id: turnContext }),
  });
  assert.notEqual(explainResponse.status, 200);
});

test('context read HTTP allows mixed valid and invalid ids as partial success', async (t) => {
  const originalReadContextIds = backendMemories.readContextIds;
  t.after(() => {
    backendMemories.readContextIds = originalReadContextIds;
  });
  backendMemories.readContextIds = async (contextIds) => contextIds.map((contextId) => (
    contextId === sessionContext
      ? { contextId, title: 'Session title', content: '# Session title\n\nSession summary' }
      : { contextId, error: `unsupported context id: ${contextId}` }
  ));

  const response = await app.request('/api/v1/context/read', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ context_ids: [sessionContext, 'invalid_context'] }),
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.contexts[0].contextId, sessionContext);
  assert.equal(body.contexts[0].content, '# Session title\n\nSession summary');
  assert.equal(body.contexts[1].contextId, 'invalid_context');
  assert.match(body.contexts[1].error, /unsupported context id/);
});

test('context read HTTP returns non-200 when backend read fails unexpectedly', async (t) => {
  const originalReadContextIds = backendMemories.readContextIds;
  t.after(() => {
    backendMemories.readContextIds = originalReadContextIds;
  });
  backendMemories.readContextIds = async () => {
    throw new Error('storage connection failed');
  };

  const response = await app.request('/api/v1/context/read', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ context_ids: [sessionContext] }),
  });

  assert.notEqual(response.status, 200);
  const body = await response.json();
  assert.equal(body.errorCode, 'internalError');
  assert.equal(body.contexts, undefined);
});

function makeContextClient() {
  const turn = {
    turnId: 'turn:1',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    sessionId: sessionIdentity.sessionId,
    turnSequence: 1,
    project: sessionIdentity.project,
    cwd: '/workspace/project-a',
    agent: sessionIdentity.agent,
    observer: 'default-extractor',
    events: [{ type: 'toolCall', name: 'muninn_read' }],
    artifacts: [],
    metadata: null,
    prompt: 'User asked about context ids',
    response: 'Assistant explained them',
  };
  return {
    sessionTable: {
      get: async () => {
        throw new Error('session read should not call sessionTable.get');
      },
    },
    sessionSnapshotTable: {
      getSnapshot: async (snapshotId) => snapshotId === 'session:1'
        ? {
            snapshotId: 'session:1',
            sessionId: sessionIdentity.sessionId,
            project: sessionIdentity.project,
            cwd: '/workspace/project-a',
            agent: sessionIdentity.agent,
            snapshotSequence: 1,
            createdAt: '2024-01-02T00:00:00Z',
            updatedAt: '2024-01-02T00:00:00Z',
            extractor: 'default-extractor',
            title: 'Session title',
            summary: 'Session summary',
            memorySignals: [],
            skillSignals: [],
            skillDetails: '{}',
            content: [
              '# Session title',
              '',
              '## Summary',
              'Session summary',
              '',
              '## Instruction Signals',
              '',
              '## Skill Signals',
              '',
              '## Skill Details',
              '',
              '## Extractions',
              '<!-- context_id: ext:123e4567-e89b-42d3-a456-426614174000; refs: [turn:1] -->',
              '### Title',
              'Adoption agencies',
              '',
              '### Summary',
              'Caroline compared adoption agency options across cost, wait time, and LGBT friendliness while keeping enough detail for later follow-up.',
              '',
              '### Content',
              'Hidden detailed content that should only be loaded through ext:*.',
            ].join('\n'),
            references: ['turn:1'],
          }
        : null,
    },
    turnTable: {
      getTurn: async (turnId) => turnId === 'turn:1' ? turn : null,
    },
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
