import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import core, { addMessage, turns } from '@muninn/core';
import codexImport from '../dist-server/codex_import.js';

const { __testing } = codexImport;
const { shutdownCoreForTests } = core;

async function writeTestConfig(homeDir) {
  await mkdir(homeDir, { recursive: true });
  await writeFile(path.join(homeDir, 'muninn.json'), JSON.stringify({
    extractor: {
      name: 'default',
      llmProvider: 'mock',
      embeddingProvider: 'mock',
    },
    observer: {
      name: 'default',
      llmProvider: 'mock',
    },
    providers: {
      llm: {
        mock: {
          type: 'mock',
        },
      },
      embedding: {
        mock: {
          type: 'mock',
          dimensions: 4,
        },
      },
    },
  }));
}

async function artifactFileCount(dir) {
  try {
    return (await readdir(dir)).length;
  } catch {
    return 0;
  }
}

async function writeCodexSessionFile(sessionDir, {
  fileName,
  rawSessionId,
  cwd,
  timestamp,
  prompt,
  response,
  imageUrl,
}) {
  const entries = [
    {
      timestamp,
      type: 'session_meta',
      payload: {
        id: rawSessionId,
        cwd,
        timestamp,
      },
    },
    {
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          ...(imageUrl ? [{ type: 'input_image', image_url: imageUrl }] : []),
        ],
      },
    },
    {
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: response }],
      },
    },
  ];
  await writeFile(
    path.join(sessionDir, fileName),
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
  );
}

test('parses codex user, assistant, tool calls, and local image artifacts', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'muninn-codex-import-'));
  try {
    const imagePath = path.join(tempDir, 'shot.png');
    const imageBytes = Buffer.from('89504e470d0a1a0a', 'hex');
    await writeFile(imagePath, imageBytes);

    const entries = [
      {
        timestamp: '2026-06-02T01:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'session-1',
          cwd: '/Users/Nathan/workspace/muninn',
          timestamp: '2026-06-02T01:00:00.000Z',
        },
      },
      {
        timestamp: '2026-06-02T01:01:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '帮我看下这个截图' },
            { type: 'input_image', image_url: `file://${imagePath}` },
          ],
        },
      },
      {
        timestamp: '2026-06-02T01:01:10.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'call-1',
          name: 'shell',
          arguments: '{"cmd":"ls"}',
        },
      },
      {
        timestamp: '2026-06-02T01:01:20.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-1',
          output: 'README.md',
        },
      },
      {
        timestamp: '2026-06-02T01:02:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '截图和文件都看到了。' }],
        },
      },
    ];
    const sessionPath = path.join(tempDir, 'session-1.jsonl');
    await writeFile(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

    const artifactStore = path.join(tempDir, 'artifacts');
    const session = await __testing.readCodexSession(sessionPath, { artifactStore });

    assert.equal(session.turns.length, 1);
    assert.equal(session.turns[0].promptTimestamp, '2026-06-02T01:01:00.000Z');
    assert.equal(session.turns[0].responseTimestamp, '2026-06-02T01:02:00.000Z');
    assert.deepEqual(session.turns[0].events, [
      {
        type: 'userMessage',
        text: '帮我看下这个截图',
        timestamp: '2026-06-02T01:01:00.000Z',
        artifacts: [session.turns[0].artifacts[0]],
      },
      {
        type: 'toolCall',
        id: 'call-1',
        name: 'shell',
        input: '{"cmd":"ls"}',
        timestamp: '2026-06-02T01:01:10.000Z',
      },
      {
        type: 'toolOutput',
        id: 'call-1',
        output: 'README.md',
        timestamp: '2026-06-02T01:01:20.000Z',
      },
      {
        type: 'assistantMessage',
        text: '截图和文件都看到了。',
        timestamp: '2026-06-02T01:02:00.000Z',
      },
    ]);
    const image = session.turns[0].artifacts.find((artifact) => artifact.kind === 'image');
    assert.ok(image);
    assert.equal(image.source, 'prompt');
    assert.equal(image.mimeType, 'image/png');
    assert.equal(image.name, 'shot.png');
    assert.match(image.uri, /^artifact:\/\//);
    const saved = await readFile(path.join(artifactStore, image.uri.replace('artifact://', '')));
    assert.deepEqual(saved, imageBytes);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('preserves interleaved assistant and tool events in order', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'muninn-codex-import-timeline-'));
  try {
    const entries = [
      {
        timestamp: '2026-06-02T02:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'session-timeline',
          cwd: '/Users/Nathan/workspace/muninn',
          timestamp: '2026-06-02T02:00:00.000Z',
        },
      },
      {
        timestamp: '2026-06-02T02:01:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '按真实 timeline 展示' }],
        },
      },
      {
        timestamp: '2026-06-02T02:01:10.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '先说明 A' }],
        },
      },
      {
        timestamp: '2026-06-02T02:01:20.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'call-a',
          name: 'exec_command',
          arguments: '{"cmd":"pwd"}',
        },
      },
      {
        timestamp: '2026-06-02T02:01:30.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-a',
          output: '/repo',
        },
      },
      {
        timestamp: '2026-06-02T02:01:40.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '再说明 B' }],
        },
      },
      {
        timestamp: '2026-06-02T02:01:50.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'call-b',
          name: 'exec_command',
          arguments: '{"cmd":"ls"}',
        },
      },
      {
        timestamp: '2026-06-02T02:02:00.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-b',
          output: 'README.md',
        },
      },
      {
        timestamp: '2026-06-02T02:02:10.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '最后说明 C' }],
        },
      },
    ];
    const sessionPath = path.join(tempDir, 'session-timeline.jsonl');
    await writeFile(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

    const session = await __testing.readCodexSession(sessionPath, {
      artifactStore: path.join(tempDir, 'artifacts'),
    });

    assert.equal(session.turns.length, 1);
    assert.deepEqual(session.turns[0].events.map((event) => event.type), [
      'userMessage',
      'assistantMessage',
      'toolCall',
      'toolOutput',
      'assistantMessage',
      'toolCall',
      'toolOutput',
      'assistantMessage',
    ]);
    assert.equal(session.turns[0].events[2].id, 'call-a');
    assert.equal(session.turns[0].events[4].text, '再说明 B');
    assert.equal(session.turns[0].events[6].output, 'README.md');
    assert.equal(session.turns[0].response, '最后说明 C');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run import deletes legacy codex rows that predate import markers', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'muninn-codex-import-cleanup-'));
  const previousHome = process.env.MUNINN_HOME;
  const previousObserverPollMs = process.env.MUNINN_OBSERVER_POLL_MS;
  process.env.MUNINN_HOME = path.join(tempDir, 'muninn');
  process.env.MUNINN_OBSERVER_POLL_MS = '60000';
  try {
    await writeTestConfig(process.env.MUNINN_HOME);

    const sourceRoot = path.join(tempDir, 'codex');
    const sessionDir = path.join(sourceRoot, 'sessions', '2026', '06', '02');
    await mkdir(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, 'rollout-2026-06-02T01-00-00-session-cleanup.jsonl');
    const entries = [
      {
        timestamp: '2026-06-02T01:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'session-cleanup',
          cwd: '/Users/Nathan/workspace/muninn',
          timestamp: '2026-06-02T01:00:00.000Z',
        },
      },
      {
        timestamp: '2026-06-02T01:01:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'legacy duplicated prompt' }],
        },
      },
      {
        timestamp: '2026-06-02T01:02:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'fresh response' }],
        },
      },
    ];
    await writeFile(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

    await addMessage({
      sessionId: 'muninn/legacy-duplicated-prompt-session-',
      agent: 'codex',
      createdAt: '2026-06-02T01:02:00.000Z',
      updatedAt: '2026-06-02T01:02:00.000Z',
      prompt: 'legacy duplicated prompt',
      response: 'legacy response without marker',
      events: [
        { type: 'userMessage', text: 'legacy duplicated prompt', timestamp: '2026-06-02T01:01:00.000Z' },
        { type: 'assistantMessage', text: 'legacy response without marker', timestamp: '2026-06-02T01:02:00.000Z' },
      ],
    });

    const result = await codexImport.runCodexImport({
      sourceRoot,
      projectKeys: ['muninn'],
      projectLimit: 5,
      artifactStore: path.join(tempDir, 'artifacts'),
    }, 'req-test');

    assert.equal(result.deletedTurns, 1);
    assert.equal(result.importedTurns, 1);

    const persisted = await turns.list({
      mode: { type: 'page', offset: 0, limit: 20 },
      agent: 'codex',
    });
    const matching = persisted.filter((turn) => turn.prompt === 'legacy duplicated prompt');
    assert.equal(matching.length, 1);
    assert.equal(matching[0]?.response, 'fresh response');
  } finally {
    await shutdownCoreForTests();
    if (previousHome === undefined) {
      delete process.env.MUNINN_HOME;
    } else {
      process.env.MUNINN_HOME = previousHome;
    }
    if (previousObserverPollMs === undefined) {
      delete process.env.MUNINN_OBSERVER_POLL_MS;
    } else {
      process.env.MUNINN_OBSERVER_POLL_MS = previousObserverPollMs;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run import only deletes existing marker turns for selected codex sessions', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'muninn-codex-import-marker-scope-'));
  const previousHome = process.env.MUNINN_HOME;
  const previousObserverPollMs = process.env.MUNINN_OBSERVER_POLL_MS;
  process.env.MUNINN_HOME = path.join(tempDir, 'muninn');
  process.env.MUNINN_OBSERVER_POLL_MS = '60000';
  try {
    await writeTestConfig(process.env.MUNINN_HOME);

    const sourceRoot = path.join(tempDir, 'codex');
    const sessionDir = path.join(sourceRoot, 'sessions', '2026', '06', '03');
    await mkdir(sessionDir, { recursive: true });
    const entries = [
      {
        timestamp: '2026-06-03T01:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'raw-selected-session',
          cwd: '/Users/Nathan/workspace/muninn',
          timestamp: '2026-06-03T01:00:00.000Z',
        },
      },
      {
        timestamp: '2026-06-03T01:01:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'selected prompt' }],
        },
      },
      {
        timestamp: '2026-06-03T01:02:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'selected fresh response' }],
        },
      },
    ];
    await writeFile(
      path.join(sessionDir, 'rollout-selected.jsonl'),
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    );

    await addMessage({
      sessionId: 'muninn/selected-prompt-raw-sele',
      agent: 'codex',
      createdAt: '2026-06-03T01:01:00.000Z',
      updatedAt: '2026-06-03T01:02:00.000Z',
      prompt: 'selected prompt',
      response: 'selected stale response',
      events: [
        { type: 'userMessage', text: 'selected prompt', timestamp: '2026-06-03T01:01:00.000Z' },
        { type: 'assistantMessage', text: 'selected stale response', timestamp: '2026-06-03T01:02:00.000Z' },
      ],
      artifacts: [{
        key: 'codex.import',
        kind: 'metadata',
        source: 'import',
        content: JSON.stringify({ marker: 'raw-selected-session#1' }),
      }],
    });
    await addMessage({
      sessionId: 'lance/other-session-raw-othe',
      agent: 'codex',
      createdAt: '2026-06-03T02:01:00.000Z',
      updatedAt: '2026-06-03T02:02:00.000Z',
      prompt: 'other prompt',
      response: 'other response should remain',
      events: [
        { type: 'userMessage', text: 'other prompt', timestamp: '2026-06-03T02:01:00.000Z' },
        { type: 'assistantMessage', text: 'other response should remain', timestamp: '2026-06-03T02:02:00.000Z' },
      ],
      artifacts: [{
        key: 'codex.import',
        kind: 'metadata',
        source: 'import',
        content: JSON.stringify({ marker: 'raw-other-session#1' }),
      }],
    });

    const result = await codexImport.runCodexImport({
      sourceRoot,
      projectKeys: ['muninn'],
      projectLimit: 5,
      artifactStore: path.join(tempDir, 'artifacts'),
    }, 'req-test');

    assert.equal(result.deletedTurns, 1);
    assert.equal(result.importedTurns, 1);

    const persisted = await turns.list({
      mode: { type: 'page', offset: 0, limit: 20 },
      agent: 'codex',
    });
    assert.equal(persisted.filter((turn) => turn.prompt === 'selected prompt').length, 1);
    assert.ok(persisted.some((turn) => turn.prompt === 'other prompt' && turn.response === 'other response should remain'));
  } finally {
    await shutdownCoreForTests();
    if (previousHome === undefined) {
      delete process.env.MUNINN_HOME;
    } else {
      process.env.MUNINN_HOME = previousHome;
    }
    if (previousObserverPollMs === undefined) {
      delete process.env.MUNINN_OBSERVER_POLL_MS;
    } else {
      process.env.MUNINN_OBSERVER_POLL_MS = previousObserverPollMs;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('preview does not write artifacts but run imports relative and missing attachments safely', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'muninn-codex-import-preview-artifacts-'));
  const previousHome = process.env.MUNINN_HOME;
  const previousObserverPollMs = process.env.MUNINN_OBSERVER_POLL_MS;
  process.env.MUNINN_HOME = path.join(tempDir, 'muninn');
  process.env.MUNINN_OBSERVER_POLL_MS = '60000';
  try {
    await writeTestConfig(process.env.MUNINN_HOME);
    const workspaceDir = path.join(tempDir, 'workspace', 'muninn');
    await mkdir(workspaceDir, { recursive: true });
    const imageBytes = Buffer.from('89504e470d0a1a0a', 'hex');
    await writeFile(path.join(workspaceDir, 'shot.png'), imageBytes);

    const sourceRoot = path.join(tempDir, 'codex');
    const sessionDir = path.join(sourceRoot, 'sessions', '2026', '06', '03');
    await mkdir(sessionDir, { recursive: true });
    const entries = [
      {
        timestamp: '2026-06-03T03:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'raw-artifact-session',
          cwd: workspaceDir,
          timestamp: '2026-06-03T03:00:00.000Z',
        },
      },
      {
        timestamp: '2026-06-03T03:01:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'relative image prompt' },
            { type: 'input_image', image_url: 'shot.png' },
            { type: 'input_image', image_url: 'missing.png' },
          ],
        },
      },
      {
        timestamp: '2026-06-03T03:02:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'relative image response' }],
        },
      },
    ];
    await writeFile(
      path.join(sessionDir, 'rollout-artifact.jsonl'),
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    );

    const artifactStore = path.join(tempDir, 'artifacts');
    const preview = await codexImport.previewCodexImport({
      sourceRoot,
      projectKeys: ['muninn'],
      projectLimit: 5,
      artifactStore,
    }, 'req-preview');

    assert.equal(preview.artifactCount, 2);
    assert.equal(await artifactFileCount(artifactStore), 0);

    const result = await codexImport.runCodexImport({
      sourceRoot,
      projectKeys: ['muninn'],
      projectLimit: 5,
      artifactStore,
    }, 'req-run');

    assert.equal(result.failedSessions.length, 0);
    assert.equal(result.importedTurns, 1);
    assert.equal(await artifactFileCount(artifactStore), 1);

    const persisted = await turns.list({
      mode: { type: 'page', offset: 0, limit: 20 },
      agent: 'codex',
    });
    const imported = persisted.find((turn) => turn.prompt === 'relative image prompt');
    assert.ok(imported);
    const image = imported.artifacts.find((artifact) => artifact.kind === 'image');
    assert.ok(image);
    assert.match(image.uri, /^artifact:\/\//);
    const saved = await readFile(path.join(artifactStore, image.uri.replace('artifact://', '')));
    assert.deepEqual(saved, imageBytes);
  } finally {
    await shutdownCoreForTests();
    if (previousHome === undefined) {
      delete process.env.MUNINN_HOME;
    } else {
      process.env.MUNINN_HOME = previousHome;
    }
    if (previousObserverPollMs === undefined) {
      delete process.env.MUNINN_OBSERVER_POLL_MS;
    } else {
      process.env.MUNINN_OBSERVER_POLL_MS = previousObserverPollMs;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run import only copies artifacts for selected sessions', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'muninn-codex-import-selected-artifacts-'));
  const previousHome = process.env.MUNINN_HOME;
  const previousObserverPollMs = process.env.MUNINN_OBSERVER_POLL_MS;
  process.env.MUNINN_HOME = path.join(tempDir, 'muninn');
  process.env.MUNINN_OBSERVER_POLL_MS = '60000';
  try {
    await writeTestConfig(process.env.MUNINN_HOME);
    const workspaceDir = path.join(tempDir, 'workspace', 'muninn');
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(path.join(workspaceDir, 'selected.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    await writeFile(path.join(workspaceDir, 'unselected.png'), Buffer.from('89504e470d0a1a0b', 'hex'));

    const sourceRoot = path.join(tempDir, 'codex');
    const sessionDir = path.join(sourceRoot, 'sessions', '2026', '06', '03');
    await mkdir(sessionDir, { recursive: true });
    await writeCodexSessionFile(sessionDir, {
      fileName: 'rollout-selected.jsonl',
      rawSessionId: 'raw-selected-artifact',
      cwd: workspaceDir,
      timestamp: '2026-06-03T05:00:00.000Z',
      prompt: 'selected artifact prompt',
      response: 'selected artifact response',
      imageUrl: 'selected.png',
    });
    await writeCodexSessionFile(sessionDir, {
      fileName: 'rollout-unselected.jsonl',
      rawSessionId: 'raw-unselected-artifact',
      cwd: workspaceDir,
      timestamp: '2026-06-03T04:00:00.000Z',
      prompt: 'unselected artifact prompt',
      response: 'unselected artifact response',
      imageUrl: 'unselected.png',
    });

    const artifactStore = path.join(tempDir, 'artifacts');
    const result = await codexImport.runCodexImport({
      sourceRoot,
      projectKeys: ['muninn'],
      projectLimit: 1,
      artifactStore,
    }, 'req-run');

    assert.equal(result.importedTurns, 1);
    assert.equal(await artifactFileCount(artifactStore), 1);

    const persisted = await turns.list({
      mode: { type: 'page', offset: 0, limit: 20 },
      agent: 'codex',
    });
    assert.ok(persisted.some((turn) => turn.prompt === 'selected artifact prompt'));
    assert.ok(!persisted.some((turn) => turn.prompt === 'unselected artifact prompt'));
  } finally {
    await shutdownCoreForTests();
    if (previousHome === undefined) {
      delete process.env.MUNINN_HOME;
    } else {
      process.env.MUNINN_HOME = previousHome;
    }
    if (previousObserverPollMs === undefined) {
      delete process.env.MUNINN_OBSERVER_POLL_MS;
    } else {
      process.env.MUNINN_OBSERVER_POLL_MS = previousObserverPollMs;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});
