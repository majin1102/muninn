import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import core from '../dist/backend.js';
import { memories as backendMemories } from '../dist/backend.js';
import { app } from '../dist/http.js';
import {
  Memories,
  contextIdForRecallHit,
  parseSessionContextId,
  parseTurnContextId,
  sessionContextId,
  turnContextId,
} from '../dist/api/memory.js';

const sessionIdentity = { project: 'project-a', agent: 'codex', sessionId: 'session-a' };
const sessionContext = sessionContextId(sessionIdentity);
const turnContext = turnContextId('turn:1');

test.afterEach(async () => {
  await core.shutdownCoreForTests();
});

test('context ids round trip through opaque prefixes', () => {
  assert.match(sessionContext, /^session_/);
  assert.doesNotMatch(sessionContext, /project-a|codex|session-a/);
  assert.deepEqual(parseSessionContextId(sessionContext), sessionIdentity);
  assert.equal(contextIdForRecallHit({ memoryId: 'session:1', content: '', references: [], ...sessionIdentity }), sessionContext);

  assert.match(turnContext, /^turn_/);
  assert.doesNotMatch(turnContext, /turn:1/);
  assert.equal(parseTurnContextId(turnContext), 'turn:1');
  assert.throws(() => turnContextId('extraction:1'), /invalid memory id layer/);
  assert.throws(() => turnContextId('turn:not-a-number'), /invalid memory id/);
  assert.throws(() => parseTurnContextId(rawTurnContextId('extraction:1')), /invalid memory id layer/);
  assert.throws(() => parseTurnContextId(rawTurnContextId('not a turn id')), /invalid memory id/);

  assert.throws(() => parseSessionContextId(turnContext), /unsupported context id/);
  assert.throws(() => parseSessionContextId(sessionContextId({ project: ' ', agent: 'codex', sessionId: 's' })), /invalid session context id/);
});

test('readContextIds resolves session and turn ids without source provenance', async () => {
  const memories = new Memories(makeContextClient());

  const contexts = await memories.readContextIds([
    sessionContext,
    turnContext,
    'invalid_context',
    turnContextId('turn:2'),
  ]);

  assert.equal(contexts[0].contextId, sessionContext);
  assert.equal(contexts[0].title, 'Session title');
  assert.equal(contexts[0].content, '# Session title\n\nSession summary');
  assert.doesNotMatch(contexts[0].content, /Source Provenance/);

  assert.equal(contexts[1].contextId, turnContext);
  assert.doesNotMatch(contexts[1].content, /^# turn:1$/m);
  assert.match(contexts[1].content, /Prompt: User asked about context ids/);
  assert.match(contexts[1].content, /Response: Assistant explained them/);
  assert.doesNotMatch(contexts[1].content, /Source Provenance/);

  assert.match(contexts[2].error, /unsupported context id/);
  assert.match(contexts[3].error, /not found/);
});

test('readContextIds rejects ordinary storage errors instead of returning per-id errors', async () => {
  await assert.rejects(
    () => new Memories({
      sessionTable: {
        get: async () => {
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

test('explainContextId resolves session provenance and rejects turn ids', async () => {
  const memories = new Memories(makeContextClient());

  const context = await memories.explainContextId(sessionContext);

  assert.equal(context.contextId, sessionContext);
  assert.equal(context.title, 'Session title');
  assert.match(context.content, /^# Muninn Explain/);
  assert.match(context.content, new RegExp(`Explained: ${escapeRegExp(sessionContext)}`));
  assert.match(context.content, /## Source Provenance/);
  assert.match(context.content, new RegExp(`### ${escapeRegExp(turnContext)}`));
  assert.match(context.content, /Prompt: User asked about context ids/);

  await assert.rejects(
    () => memories.explainContextId(turnContext),
    /muninn_explain only supports session_\* context ids/,
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

  const explainBadId = await app.request('/api/v1/context/explain', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ context_id: turnContext }),
  });
  assert.equal(explainBadId.status, 400);
  assert.match((await explainBadId.json()).errorMessage, /muninn_explain only supports session_\* context ids/);
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

test('context explain HTTP maps stale session context ids to not found', async (t) => {
  const originalExplainContextId = backendMemories.explainContextId;
  t.after(() => {
    backendMemories.explainContextId = originalExplainContextId;
  });
  backendMemories.explainContextId = async () => {
    throw new Error(`session context not found: ${sessionContext}`);
  };

  const response = await app.request('/api/v1/context/explain', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ context_id: sessionContext }),
  });

  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.errorCode, 'notFound');
  assert.match(body.errorMessage, /session context not found/);
});

function makeContextClient() {
  const sessionRow = {
    latestSnapshotId: 'session:1',
    sessionId: sessionIdentity.sessionId,
    project: sessionIdentity.project,
    cwd: '/workspace/project-a',
    agent: sessionIdentity.agent,
    title: 'Session title',
    summary: 'Session summary',
    searchText: 'Session title\n\nSession summary',
    vector: [],
    updatedAt: '2024-01-02T00:00:00Z',
  };
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
      get: async ({ identities }) => identities.some((identity) => (
        identity.project === sessionIdentity.project
        && identity.agent === sessionIdentity.agent
        && identity.sessionId === sessionIdentity.sessionId
      )) ? [sessionRow] : [],
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
            content: 'Session content',
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

function rawTurnContextId(memoryId) {
  return `turn_${Buffer.from(memoryId).toString('base64url')}`;
}
