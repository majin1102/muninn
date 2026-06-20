import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import core, { captureTurn, memoryPipeline, turns } from '../dist/backend.js';
import { __testing, previewCodexImport, runCodexImport } from '../dist/web/import.js';
import { codexAdapter } from '../dist/web/import.js';
import { importSelectedSessions } from '../dist/web/import.js';

const { shutdownCoreForTests } = core;

async function writeTestConfig(homeDir, { epochTurns, epochWindowMs } = {}) {
  await mkdir(homeDir, { recursive: true });
  await writeFile(path.join(homeDir, 'muninn.json'), JSON.stringify({
    extractor: {
      name: 'default',
      llmProvider: 'mock',
      embeddingProvider: 'mock',
      ...(epochTurns === undefined ? {} : { epochTurns }),
      ...(epochWindowMs === undefined ? {} : { epochWindowMs }),
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

async function artifactFilesRecursive(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...await artifactFilesRecursive(entryPath));
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
    return files;
  } catch {
    return [];
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

test('run import stores raw session id with project cwd and metadata', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'muninn-codex-import-raw-session-'));
  const previousHome = process.env.MUNINN_HOME;
  const previousExtractorPollMs = process.env.MUNINN_EXTRACTOR_POLL_MS;
  process.env.MUNINN_HOME = path.join(tempDir, 'muninn');
  process.env.MUNINN_EXTRACTOR_POLL_MS = '60000';
  try {
    await writeTestConfig(process.env.MUNINN_HOME);

    const sourceRoot = path.join(tempDir, 'codex');
    const cwd = path.join(tempDir, 'workspace', 'muninn');
    const sessionDir = path.join(sourceRoot, 'sessions', '2026', '06', '03');
    await mkdir(sessionDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeCodexSessionFile(sessionDir, {
      fileName: 'rollout-raw-session.jsonl',
      rawSessionId: '019e8632-raw-codex-session',
      cwd,
      timestamp: '2026-06-03T09:00:00.000Z',
      prompt: 'raw session prompt',
      response: 'raw session response',
    });

    const result = await runCodexImport({
      sourceRoot,
      projectLimit: 5,
      artifactStore: path.join(tempDir, 'artifacts'),
    }, 'req-run');

    assert.equal(result.importedTurns, 1);

    const persisted = await turns.list({
      mode: { type: 'page', offset: 0, limit: 20 },
      agent: 'codex',
    });
    const imported = persisted.find((turn) => turn.prompt === 'raw session prompt');
    assert.ok(imported);
    assert.equal(imported.sessionId, '019e8632-raw-codex-session');
    assert.equal(imported.project, await realpath(cwd));
    assert.equal(imported.cwd, cwd);
    assert.equal(imported.metadata?.ingest, 'codex-import');
    assert.equal(imported.metadata?.sourceSessionId, '019e8632-raw-codex-session');
    assert.equal(imported.metadata?.sourcePath, path.join(sessionDir, 'rollout-raw-session.jsonl'));
  } finally {
    await shutdownCoreForTests();
    if (previousHome === undefined) {
      delete process.env.MUNINN_HOME;
    } else {
      process.env.MUNINN_HOME = previousHome;
    }
    if (previousExtractorPollMs === undefined) {
      delete process.env.MUNINN_EXTRACTOR_POLL_MS;
    } else {
      process.env.MUNINN_EXTRACTOR_POLL_MS = previousExtractorPollMs;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('session import fails when firstTurnSequence is zero', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'muninn-codex-import-already-imported-'));
  const previousHome = process.env.MUNINN_HOME;
  const previousExtractorPollMs = process.env.MUNINN_EXTRACTOR_POLL_MS;
  process.env.MUNINN_HOME = path.join(tempDir, 'muninn');
  process.env.MUNINN_EXTRACTOR_POLL_MS = '60000';
  try {
    await writeTestConfig(process.env.MUNINN_HOME);

    const sourceRoot = path.join(tempDir, 'codex');
    const cwd = path.join(tempDir, 'workspace', 'already-imported');
    const sessionDir = path.join(sourceRoot, 'sessions', '2026', '06', '13');
    await mkdir(sessionDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const sourcePath = path.join(sessionDir, 'already-imported.jsonl');
    await writeCodexSessionFile(sessionDir, {
      fileName: path.basename(sourcePath),
      rawSessionId: 'already-imported-session',
      cwd,
      timestamp: '2026-06-13T01:00:00.000Z',
      prompt: 'already imported prompt',
      response: 'already imported response',
    });
    const project = await realpath(cwd);

    await captureTurn({
      sessionId: 'already-imported-session',
      project,
      cwd,
      agent: 'codex',
      turnSequence: 0,
      createdAt: '2026-06-13T01:01:00.000Z',
      updatedAt: '2026-06-13T01:02:00.000Z',
      prompt: 'already imported prompt',
      response: 'already imported old response',
      events: [
        { type: 'userMessage', text: 'already imported prompt', timestamp: '2026-06-13T01:01:00.000Z' },
        { type: 'assistantMessage', text: 'already imported old response', timestamp: '2026-06-13T01:02:00.000Z' },
      ],
    });

    const result = await importSelectedSessions(
      { ...codexAdapter, sourceRoot },
      [sourcePath],
      'req-already-imported',
    );

    assert.equal(result.importedTurns, 0);
    assert.equal(result.importedSessions, 0);
    assert.equal(result.failedSessions.length, 1);
    assert.equal(result.failedSessions[0].errorMessage, 'session already imported');

    const persisted = await turns.list({
      mode: { type: 'page', offset: 0, limit: 20 },
      agent: 'codex',
      sessionId: 'already-imported-session',
    });
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].response, 'already imported old response');
  } finally {
    await shutdownCoreForTests();
    if (previousHome === undefined) {
      delete process.env.MUNINN_HOME;
    } else {
      process.env.MUNINN_HOME = previousHome;
    }
    if (previousExtractorPollMs === undefined) {
      delete process.env.MUNINN_EXTRACTOR_POLL_MS;
    } else {
      process.env.MUNINN_EXTRACTOR_POLL_MS = previousExtractorPollMs;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('session import allows later hook coverage and skips duplicate source turn', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'muninn-codex-import-late-coverage-'));
  const previousHome = process.env.MUNINN_HOME;
  const previousExtractorPollMs = process.env.MUNINN_EXTRACTOR_POLL_MS;
  process.env.MUNINN_HOME = path.join(tempDir, 'muninn');
  process.env.MUNINN_EXTRACTOR_POLL_MS = '60000';
  try {
    await writeTestConfig(process.env.MUNINN_HOME);

    const sourceRoot = path.join(tempDir, 'codex');
    const cwd = path.join(tempDir, 'workspace', 'late-coverage');
    const sessionDir = path.join(sourceRoot, 'sessions', '2026', '06', '13');
    await mkdir(sessionDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const sourcePath = path.join(sessionDir, 'late-coverage.jsonl');
    const entries = [
      {
        timestamp: '2026-06-13T02:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'late-coverage-session',
          cwd,
          timestamp: '2026-06-13T02:00:00.000Z',
        },
      },
      {
        timestamp: '2026-06-13T02:01:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'first late prompt' }],
        },
      },
      {
        timestamp: '2026-06-13T02:02:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'first late response' }],
        },
      },
      {
        timestamp: '2026-06-13T02:03:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'second late prompt' }],
        },
      },
      {
        timestamp: '2026-06-13T02:04:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'second late response' }],
        },
      },
      {
        timestamp: '2026-06-13T02:05:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'third late prompt' }],
        },
      },
      {
        timestamp: '2026-06-13T02:06:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'third late response' }],
        },
      },
    ];
    await writeFile(sourcePath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    const project = await realpath(cwd);

    await captureTurn({
      sessionId: 'late-coverage-session',
      project,
      cwd,
      agent: 'codex',
      turnSequence: 2,
      createdAt: '2026-06-13T02:05:00.000Z',
      updatedAt: '2026-06-13T02:06:00.000Z',
      prompt: 'third late prompt',
      response: 'third live response',
      events: [
        { type: 'userMessage', text: 'third late prompt', timestamp: '2026-06-13T02:05:00.000Z' },
        { type: 'assistantMessage', text: 'third live response', timestamp: '2026-06-13T02:06:00.000Z' },
      ],
    });

    const result = await importSelectedSessions(
      { ...codexAdapter, sourceRoot },
      [sourcePath],
      'req-late-coverage',
    );

    assert.equal(result.importedTurns, 2);
    assert.equal(result.importedSessions, 1);
    assert.equal(result.failedSessions.length, 0, JSON.stringify(result.failedSessions));

    const persisted = await turns.list({
      mode: { type: 'page', offset: 0, limit: 20 },
      agent: 'codex',
      sessionId: 'late-coverage-session',
    });
    assert.deepEqual(
      persisted
        .filter((turn) => turn.project === project)
        .map((turn) => turn.turnSequence)
        .sort((left, right) => left - right),
      [0, 1, 2],
    );
    assert.equal(persisted.filter((turn) => turn.project === project && turn.turnSequence === 2).length, 1);
  } finally {
    await shutdownCoreForTests();
    if (previousHome === undefined) {
      delete process.env.MUNINN_HOME;
    } else {
      process.env.MUNINN_HOME = previousHome;
    }
    if (previousExtractorPollMs === undefined) {
      delete process.env.MUNINN_EXTRACTOR_POLL_MS;
    } else {
      process.env.MUNINN_EXTRACTOR_POLL_MS = previousExtractorPollMs;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('session import returns after batch write without flushing extraction', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'muninn-codex-import-async-'));
  const previousHome = process.env.MUNINN_HOME;
  const previousExtractorPollMs = process.env.MUNINN_EXTRACTOR_POLL_MS;
  process.env.MUNINN_HOME = path.join(tempDir, 'muninn');
  process.env.MUNINN_EXTRACTOR_POLL_MS = '60000';
  try {
    await writeTestConfig(process.env.MUNINN_HOME, {
      epochTurns: 100,
      epochWindowMs: 60_000,
    });

    const sourceRoot = path.join(tempDir, 'codex');
    const cwd = path.join(tempDir, 'workspace', 'async-import');
    const sessionDir = path.join(sourceRoot, 'sessions', '2026', '06', '13');
    await mkdir(sessionDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const sourcePath = path.join(sessionDir, 'async-import.jsonl');
    const entries = [
      {
        timestamp: '2026-06-13T03:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'async-import-session',
          cwd,
          timestamp: '2026-06-13T03:00:00.000Z',
        },
      },
      {
        timestamp: '2026-06-13T03:01:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'first async prompt' }],
        },
      },
      {
        timestamp: '2026-06-13T03:02:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'first async response' }],
        },
      },
      {
        timestamp: '2026-06-13T03:03:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'second async prompt' }],
        },
      },
      {
        timestamp: '2026-06-13T03:04:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'second async response' }],
        },
      },
    ];
    await writeFile(sourcePath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

    const result = await importSelectedSessions(
      { ...codexAdapter, sourceRoot },
      [sourcePath],
      'req-async-import',
    );

    assert.equal(result.importedTurns, 2);
    assert.equal(result.importedSessions, 1);
    assert.equal(result.failedSessions.length, 0, JSON.stringify(result.failedSessions));

    const persisted = await turns.list({
      mode: { type: 'page', offset: 0, limit: 20 },
      agent: 'codex',
      sessionId: 'async-import-session',
    });
    assert.equal(persisted.length, 2);

    const watermark = await memoryPipeline.watermark();
    assert.equal(watermark.pending.turns.length, 2);
    assert.equal(watermark.phases.extractor, 'pending');
  } finally {
    await shutdownCoreForTests();
    if (previousHome === undefined) {
      delete process.env.MUNINN_HOME;
    } else {
      process.env.MUNINN_HOME = previousHome;
    }
    if (previousExtractorPollMs === undefined) {
      delete process.env.MUNINN_EXTRACTOR_POLL_MS;
    } else {
      process.env.MUNINN_EXTRACTOR_POLL_MS = previousExtractorPollMs;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run import ignores unmarked legacy codex rows', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'muninn-codex-import-cleanup-'));
  const previousHome = process.env.MUNINN_HOME;
  const previousExtractorPollMs = process.env.MUNINN_EXTRACTOR_POLL_MS;
  process.env.MUNINN_HOME = path.join(tempDir, 'muninn');
  process.env.MUNINN_EXTRACTOR_POLL_MS = '60000';
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

    await captureTurn({
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

    const result = await runCodexImport({
      sourceRoot,
      projectLimit: 5,
      artifactStore: path.join(tempDir, 'artifacts'),
    }, 'req-test');

    assert.equal(result.deletedTurns, 0);
    assert.equal(result.importedTurns, 1);

    const persisted = await turns.list({
      mode: { type: 'page', offset: 0, limit: 20 },
      agent: 'codex',
    });
    const matching = persisted.filter((turn) => turn.prompt === 'legacy duplicated prompt');
    assert.equal(matching.length, 2);
    assert.ok(matching.some((turn) => turn.response === 'fresh response'));
    assert.ok(matching.some((turn) => turn.response === 'legacy response without marker'));
  } finally {
    await shutdownCoreForTests();
    if (previousHome === undefined) {
      delete process.env.MUNINN_HOME;
    } else {
      process.env.MUNINN_HOME = previousHome;
    }
    if (previousExtractorPollMs === undefined) {
      delete process.env.MUNINN_EXTRACTOR_POLL_MS;
    } else {
      process.env.MUNINN_EXTRACTOR_POLL_MS = previousExtractorPollMs;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run import only deletes existing marker turns for selected codex sessions', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'muninn-codex-import-marker-scope-'));
  const previousHome = process.env.MUNINN_HOME;
  const previousExtractorPollMs = process.env.MUNINN_EXTRACTOR_POLL_MS;
  process.env.MUNINN_HOME = path.join(tempDir, 'muninn');
  process.env.MUNINN_EXTRACTOR_POLL_MS = '60000';
  try {
	    await writeTestConfig(process.env.MUNINN_HOME);

	    const sourceRoot = path.join(tempDir, 'codex');
	    const selectedProjectRaw = path.join(tempDir, 'workspace', 'muninn');
	    const otherProjectRaw = path.join(tempDir, 'workspace', 'lance');
	    const sessionDir = path.join(sourceRoot, 'sessions', '2026', '06', '03');
	    await mkdir(sessionDir, { recursive: true });
	    await mkdir(selectedProjectRaw, { recursive: true });
	    await mkdir(otherProjectRaw, { recursive: true });
	    const selectedProject = await realpath(selectedProjectRaw);
	    const otherProject = await realpath(otherProjectRaw);
	    const entries = [
	      {
	        timestamp: '2026-06-03T01:00:00.000Z',
	        type: 'session_meta',
	        payload: {
	          id: 'raw-selected-session',
	          cwd: selectedProject,
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

	    await captureTurn({
	      sessionId: 'muninn/selected-prompt-raw-sele',
	      project: selectedProject,
	      cwd: selectedProject,
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
	    await captureTurn({
	      sessionId: 'lance/other-session-raw-othe',
	      project: otherProject,
	      cwd: otherProject,
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

    const result = await runCodexImport({
      sourceRoot,
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
    if (previousExtractorPollMs === undefined) {
      delete process.env.MUNINN_EXTRACTOR_POLL_MS;
    } else {
      process.env.MUNINN_EXTRACTOR_POLL_MS = previousExtractorPollMs;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('preview does not write artifacts but run imports relative and missing attachments safely', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'muninn-codex-import-preview-artifacts-'));
  const previousHome = process.env.MUNINN_HOME;
  const previousExtractorPollMs = process.env.MUNINN_EXTRACTOR_POLL_MS;
  process.env.MUNINN_HOME = path.join(tempDir, 'muninn');
  process.env.MUNINN_EXTRACTOR_POLL_MS = '60000';
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
    const preview = await previewCodexImport({
      sourceRoot,
      projectLimit: 5,
      artifactStore,
    }, 'req-preview');

    assert.equal(preview.artifactCount, 2);
    assert.equal(await artifactFileCount(artifactStore), 0);

    const result = await runCodexImport({
      sourceRoot,
      projectLimit: 5,
      artifactStore,
    }, 'req-run');

    assert.equal(result.failedSessions.length, 0, JSON.stringify(result.failedSessions));
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
    if (previousExtractorPollMs === undefined) {
      delete process.env.MUNINN_EXTRACTOR_POLL_MS;
    } else {
      process.env.MUNINN_EXTRACTOR_POLL_MS = previousExtractorPollMs;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run import skips invalid data URL artifacts without failing the session', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'muninn-codex-import-artifact-copy-failure-'));
  const previousHome = process.env.MUNINN_HOME;
  const previousExtractorPollMs = process.env.MUNINN_EXTRACTOR_POLL_MS;
  process.env.MUNINN_HOME = path.join(tempDir, 'muninn');
  process.env.MUNINN_EXTRACTOR_POLL_MS = '60000';
  try {
    await writeTestConfig(process.env.MUNINN_HOME);

    const sourceRoot = path.join(tempDir, 'codex');
    const workspaceDir = path.join(tempDir, 'muninn');
    const sessionDir = path.join(sourceRoot, 'sessions', '2026', '06', '03');
    await mkdir(sessionDir, { recursive: true });

    await writeCodexSessionFile(sessionDir, {
      fileName: 'rollout-good.jsonl',
      rawSessionId: 'raw-good-artifact-copy',
      cwd: workspaceDir,
      timestamp: '2026-06-03T06:00:00.000Z',
      prompt: 'good artifact copy prompt',
      response: 'good artifact copy response',
    });
    await writeCodexSessionFile(sessionDir, {
      fileName: 'rollout-bad.jsonl',
      rawSessionId: 'raw-bad-artifact-copy',
      cwd: workspaceDir,
      timestamp: '2026-06-03T05:00:00.000Z',
      prompt: 'bad artifact copy prompt',
      response: 'bad artifact copy response',
      imageUrl: 'data:broken-image-url',
    });

    const result = await runCodexImport({
      sourceRoot,
      projectLimit: 5,
      artifactStore: path.join(tempDir, 'artifacts'),
    }, 'req-run');

    assert.equal(result.importedTurns, 2);
    assert.equal(result.failedSessions.length, 0, JSON.stringify(result.failedSessions));

    const persisted = await turns.list({
      mode: { type: 'page', offset: 0, limit: 20 },
      agent: 'codex',
    });
    assert.ok(persisted.some((turn) => turn.prompt === 'good artifact copy prompt'));
    const badImport = persisted.find((turn) => turn.prompt === 'bad artifact copy prompt');
    assert.ok(badImport);
    assert.equal(badImport.artifacts.filter((artifact) => artifact.kind === 'image').length, 0);
  } finally {
    await shutdownCoreForTests();
    if (previousHome === undefined) {
      delete process.env.MUNINN_HOME;
    } else {
      process.env.MUNINN_HOME = previousHome;
    }
    if (previousExtractorPollMs === undefined) {
      delete process.env.MUNINN_EXTRACTOR_POLL_MS;
    } else {
      process.env.MUNINN_EXTRACTOR_POLL_MS = previousExtractorPollMs;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run import only copies artifacts for selected sessions', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'muninn-codex-import-selected-artifacts-'));
  const previousHome = process.env.MUNINN_HOME;
  const previousExtractorPollMs = process.env.MUNINN_EXTRACTOR_POLL_MS;
  process.env.MUNINN_HOME = path.join(tempDir, 'muninn');
  process.env.MUNINN_EXTRACTOR_POLL_MS = '60000';
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
    const result = await runCodexImport({
      sourceRoot,
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
    if (previousExtractorPollMs === undefined) {
      delete process.env.MUNINN_EXTRACTOR_POLL_MS;
    } else {
      process.env.MUNINN_EXTRACTOR_POLL_MS = previousExtractorPollMs;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run import stores tool image artifacts under the codex session directory', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'muninn-codex-import-tool-image-'));
  const previousHome = process.env.MUNINN_HOME;
  const previousExtractorPollMs = process.env.MUNINN_EXTRACTOR_POLL_MS;
  process.env.MUNINN_HOME = path.join(tempDir, 'muninn');
  process.env.MUNINN_EXTRACTOR_POLL_MS = '60000';
  try {
    await writeTestConfig(process.env.MUNINN_HOME);

    const sourceRoot = path.join(tempDir, 'codex');
    const workspaceDir = path.join(tempDir, 'workspace', 'muninn');
    const sessionDir = path.join(sourceRoot, 'sessions', '2026', '06', '08');
    await mkdir(sessionDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    const imagePath = path.join(workspaceDir, 'render output.png');
    const imageBytes = Buffer.from('89504e470d0a1a0a', 'hex');
    await writeFile(imagePath, imageBytes);

    const entries = [
      {
        timestamp: '2026-06-08T14:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'raw/tool session',
          cwd: workspaceDir,
          timestamp: '2026-06-08T14:00:00.000Z',
        },
      },
      {
        timestamp: '2026-06-08T14:01:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'render a screenshot' }],
        },
      },
      {
        timestamp: '2026-06-08T14:01:10.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'call-view',
          name: 'view_image',
          arguments: JSON.stringify({ path: imagePath }),
        },
      },
      {
        timestamp: '2026-06-08T14:01:20.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-view',
          output: [
            { type: 'input_text', text: 'Rendered image:' },
            { type: 'input_image', image_url: `file://${imagePath}` },
          ],
        },
      },
      {
        timestamp: '2026-06-08T14:02:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'rendered.' }],
        },
      },
    ];
    await writeFile(
      path.join(sessionDir, 'rollout-tool-image.jsonl'),
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    );

    const artifactStore = path.join(process.env.MUNINN_HOME, 'default', 'artifacts');
    const result = await runCodexImport({
      sourceRoot,
      projectLimit: 5,
    }, 'req-run');

    assert.equal(result.failedSessions.length, 0);
    assert.equal(result.importedTurns, 1);
    const files = await artifactFilesRecursive(artifactStore);
    assert.equal(files.length, 1);
    assert.match(files[0], /artifacts\/sessions\/codex-raw-tool-session\/render-output-20260608T140120Z\.png$/);

    const persisted = await turns.list({
      mode: { type: 'page', offset: 0, limit: 20 },
      agent: 'codex',
    });
    const imported = persisted.find((turn) => turn.prompt === 'render a screenshot');
    assert.ok(imported);
    const image = imported.artifacts.find((artifact) => artifact.source === 'tool' && artifact.kind === 'image');
    assert.ok(image);
    assert.equal(image.uri, 'artifact://sessions/codex-raw-tool-session/render-output-20260608T140120Z.png');
    assert.equal(image.name, 'render output.png');
    assert.deepEqual(await readFile(files[0]), imageBytes);
    const toolOutput = imported.events.find((event) => event.type === 'toolOutput');
    assert.equal(toolOutput.artifacts.length, 1);
    assert.equal(toolOutput.artifacts[0].uri, image.uri);
  } finally {
    await shutdownCoreForTests();
    if (previousHome === undefined) {
      delete process.env.MUNINN_HOME;
    } else {
      process.env.MUNINN_HOME = previousHome;
    }
    if (previousExtractorPollMs === undefined) {
      delete process.env.MUNINN_EXTRACTOR_POLL_MS;
    } else {
      process.env.MUNINN_EXTRACTOR_POLL_MS = previousExtractorPollMs;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run import captures markdown links and apply_patch files with safe conflicting names', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'muninn-codex-import-doc-artifacts-'));
  const previousHome = process.env.MUNINN_HOME;
  const previousExtractorPollMs = process.env.MUNINN_EXTRACTOR_POLL_MS;
  process.env.MUNINN_HOME = path.join(tempDir, 'muninn');
  process.env.MUNINN_EXTRACTOR_POLL_MS = '60000';
  try {
    await writeTestConfig(process.env.MUNINN_HOME);

    const sourceRoot = path.join(tempDir, 'codex');
    const workspaceDir = path.join(tempDir, 'workspace', 'muninn');
    const sessionDir = path.join(sourceRoot, 'sessions', '2026', '06', '08');
    await mkdir(sessionDir, { recursive: true });
    await mkdir(path.join(workspaceDir, 'docs'), { recursive: true });
    await writeFile(path.join(workspaceDir, 'docs', 'research note.md'), '# Research\n');
    await writeFile(path.join(workspaceDir, 'docs', 'design.md'), '# Design\n');

    const entries = [
      {
        timestamp: '2026-06-08T15:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'docs-session',
          cwd: workspaceDir,
          timestamp: '2026-06-08T15:00:00.000Z',
        },
      },
      {
        timestamp: '2026-06-08T15:01:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'import docs' }],
        },
      },
      {
        timestamp: '2026-06-08T15:01:20.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'call-patch',
          name: 'apply_patch',
          arguments: JSON.stringify({
            patch: [
              '*** Begin Patch',
              '*** Update File: docs/research note.md',
              '*** Update File: docs/design.md',
              '*** End Patch',
            ].join('\n'),
          }),
        },
      },
      {
        timestamp: '2026-06-08T15:01:20.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-patch',
          output: 'Success. Updated files.',
        },
      },
      {
        timestamp: '2026-06-08T15:01:20.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: 'See [research](docs/research note.md) and [design](docs/design.md).',
          }],
        },
      },
    ];
    await writeFile(
      path.join(sessionDir, 'rollout-docs.jsonl'),
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    );

    const artifactStore = path.join(process.env.MUNINN_HOME, 'default', 'artifacts');
    const result = await runCodexImport({
      sourceRoot,
      projectLimit: 5,
    }, 'req-run');

    assert.equal(result.failedSessions.length, 0);
    assert.equal(result.importedTurns, 1);
    const files = (await artifactFilesRecursive(artifactStore)).map((file) => path.relative(artifactStore, file)).sort();
    assert.deepEqual(files, [
      'sessions/codex-docs-session/design-20260608T150120Z-2c1f01.md',
      'sessions/codex-docs-session/design-20260608T150120Z.md',
      'sessions/codex-docs-session/research-note-20260608T150120Z-eb390b.md',
      'sessions/codex-docs-session/research-note-20260608T150120Z.md',
    ]);

    const persisted = await turns.list({
      mode: { type: 'page', offset: 0, limit: 20 },
      agent: 'codex',
    });
    const imported = persisted.find((turn) => turn.prompt === 'import docs');
    assert.ok(imported);
    const docs = imported.artifacts.filter((artifact) => artifact.kind === 'file');
    assert.equal(docs.length, 4);
    assert.ok(docs.every((artifact) => artifact.content?.startsWith('# ')));
    assert.ok(docs.every((artifact) => artifact.uri?.startsWith('artifact://sessions/codex-docs-session/')));
  } finally {
    await shutdownCoreForTests();
    if (previousHome === undefined) {
      delete process.env.MUNINN_HOME;
    } else {
      process.env.MUNINN_HOME = previousHome;
    }
    if (previousExtractorPollMs === undefined) {
      delete process.env.MUNINN_EXTRACTOR_POLL_MS;
    } else {
      process.env.MUNINN_EXTRACTOR_POLL_MS = previousExtractorPollMs;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run import replaces matching project agent session identity when raw session id is shared', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'muninn-codex-import-identity-'));
  const previousHome = process.env.MUNINN_HOME;
  const previousExtractorPollMs = process.env.MUNINN_EXTRACTOR_POLL_MS;
  process.env.MUNINN_HOME = path.join(tempDir, 'muninn');
  process.env.MUNINN_EXTRACTOR_POLL_MS = '60000';
  try {
    await writeTestConfig(process.env.MUNINN_HOME);

    const sourceRoot = path.join(tempDir, 'codex');
    const targetProjectRaw = path.join(tempDir, 'workspace', 'target');
    const targetWorktreeRaw = path.join(tempDir, '.codex', 'worktrees', 'abcd', 'target');
    const otherProjectRaw = path.join(tempDir, 'workspace', 'other');
    const sessionDir = path.join(sourceRoot, 'sessions', '2026', '06', '12');
    await mkdir(sessionDir, { recursive: true });
    await mkdir(targetProjectRaw, { recursive: true });
    await mkdir(targetWorktreeRaw, { recursive: true });
    await mkdir(otherProjectRaw, { recursive: true });
    const targetProject = await realpath(targetProjectRaw);
    const targetWorktree = await realpath(targetWorktreeRaw);
    const otherProject = await realpath(otherProjectRaw);

    const markerArtifact = (project, cwd) => ({
      key: 'codex.import',
      kind: 'metadata',
      source: 'import',
      content: JSON.stringify({
        marker: 'shared-session#1',
        project,
        cwd,
        sourceSessionId: 'shared-session',
      }),
    });

    await captureTurn({
      sessionId: 'shared-session',
      project: targetProject,
      cwd: targetProject,
      agent: 'codex',
      createdAt: '2026-06-12T01:00:00.000Z',
      updatedAt: '2026-06-12T01:01:00.000Z',
      prompt: 'old target',
      response: 'old target',
      events: [
        { type: 'userMessage', text: 'old target', timestamp: '2026-06-12T01:00:00.000Z' },
        { type: 'assistantMessage', text: 'old target', timestamp: '2026-06-12T01:01:00.000Z' },
      ],
      artifacts: [markerArtifact(targetProject, targetProject)],
    });
    await captureTurn({
      sessionId: 'shared-session',
      project: targetProject,
      cwd: targetWorktree,
      agent: 'codex',
      createdAt: '2026-06-12T01:10:00.000Z',
      updatedAt: '2026-06-12T01:11:00.000Z',
      prompt: 'old target worktree',
      response: 'old target worktree',
      events: [
        { type: 'userMessage', text: 'old target worktree', timestamp: '2026-06-12T01:10:00.000Z' },
        { type: 'assistantMessage', text: 'old target worktree', timestamp: '2026-06-12T01:11:00.000Z' },
      ],
      artifacts: [markerArtifact(targetProject, targetWorktree)],
    });
    await captureTurn({
      sessionId: 'shared-session',
      project: otherProject,
      cwd: otherProject,
      agent: 'codex',
      createdAt: '2026-06-12T01:00:00.000Z',
      updatedAt: '2026-06-12T01:01:00.000Z',
      prompt: 'other project',
      response: 'other project',
      events: [
        { type: 'userMessage', text: 'other project', timestamp: '2026-06-12T01:00:00.000Z' },
        { type: 'assistantMessage', text: 'other project', timestamp: '2026-06-12T01:01:00.000Z' },
      ],
      artifacts: [markerArtifact(otherProject, otherProject)],
    });

    await writeCodexSessionFile(sessionDir, {
      fileName: 'shared-session.jsonl',
      rawSessionId: 'shared-session',
      cwd: targetProject,
      timestamp: '2026-06-12T02:00:00.000Z',
      prompt: 'new target',
      response: 'new target',
    });

    const result = await runCodexImport({
      sourceRoot,
      projectLimit: 5,
    }, 'req-identity');

    assert.equal(result.failedSessions.length, 0, JSON.stringify(result.failedSessions));
    assert.equal(result.deletedTurns, 2);
    assert.equal(result.importedTurns, 1);

    const persisted = await turns.list({
      mode: { type: 'page', offset: 0, limit: 20 },
      agent: 'codex',
    });
    assert.equal(persisted.some((turn) => turn.project === targetProject && turn.prompt === 'old target'), false);
    assert.equal(persisted.some((turn) => turn.project === targetProject && turn.prompt === 'old target worktree'), false);
    assert.equal(persisted.some((turn) => turn.project === targetProject && turn.prompt === 'new target'), true);
    assert.equal(persisted.some((turn) => turn.project === otherProject && turn.prompt === 'other project'), true);
  } finally {
    await shutdownCoreForTests();
    if (previousHome === undefined) {
      delete process.env.MUNINN_HOME;
    } else {
      process.env.MUNINN_HOME = previousHome;
    }
    if (previousExtractorPollMs === undefined) {
      delete process.env.MUNINN_EXTRACTOR_POLL_MS;
    } else {
      process.env.MUNINN_EXTRACTOR_POLL_MS = previousExtractorPollMs;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('markdown artifact scan skips malformed file urls', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'muninn-codex-import-bad-file-url-'));
  try {
    const sessionPath = path.join(tempDir, 'bad-file-url.jsonl');
    const entries = [
      {
        timestamp: '2026-06-08T16:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'bad-file-url-session',
          cwd: tempDir,
          timestamp: '2026-06-08T16:00:00.000Z',
        },
      },
      {
        timestamp: '2026-06-08T16:01:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'import docs' }],
        },
      },
      {
        timestamp: '2026-06-08T16:01:20.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'call-bad-image',
          name: 'view_image',
          arguments: '{}',
        },
      },
      {
        timestamp: '2026-06-08T16:01:21.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-bad-image',
          output: [
            { type: 'input_image', image_url: 'file://%E0%A4%A' },
            { type: 'input_image', image_url: 'https://%' },
            { type: 'input_image', image_url: 'data:text/plain,%E0%A4%A' },
            { type: 'input_file', file_path: 'file://%E0%A4%A' },
            { type: 'input_file', file_path: 'https://%' },
          ],
        },
      },
      {
        timestamp: '2026-06-08T16:01:30.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: 'Ignore [bad](file://...`，所以：) and [encoded](bad%zz.md) but keep importing.',
          }],
        },
      },
    ];
    await writeFile(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

    const session = await __testing.readCodexSession(sessionPath, {
      artifactStore: path.join(tempDir, 'artifacts'),
    });

    assert.equal(session.turns.length, 1);
    assert.deepEqual(session.turns[0].artifacts, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
