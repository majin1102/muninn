import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, realpath, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { handleStop, isStopEvent } from '../dist/hook.js';
import { readCodexSession, readCodexSessionSummary, resolveProjectIdentity } from '../dist/mapping.js';

const execFileAsync = promisify(execFile);
const LEGACY_SEQUENCE_KEY = 'source' + 'TurnSequence';

// Minimal Codex rollout transcript: one turn with a tool call.
const TRANSCRIPT_LINES = [
  { type: 'session_meta', payload: { id: '019eabcd-codex-session', cwd: '/Users/dev/workspace/muninn', timestamp: '2026-06-10T03:00:00.000Z' } },
  { type: 'response_item', timestamp: '2026-06-10T03:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list the files' }] } },
  { type: 'response_item', timestamp: '2026-06-10T03:00:02.000Z', payload: { type: 'function_call', call_id: 'call-1', name: 'shell', arguments: '{"command":"ls"}' } },
  { type: 'response_item', timestamp: '2026-06-10T03:00:03.000Z', payload: { type: 'function_call_output', call_id: 'call-1', output: 'README.md' } },
  { type: 'response_item', timestamp: '2026-06-10T03:00:04.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'There is one file: README.md' }] } },
];

const SECOND_TURN_LINES = [
  { type: 'response_item', timestamp: '2026-06-10T03:01:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'read the file' }] } },
  { type: 'response_item', timestamp: '2026-06-10T03:01:02.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'README.md says muninn.' }] } },
];

const THIRD_TURN_LINES = [
  { type: 'response_item', timestamp: '2026-06-10T03:02:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'summarize it' }] } },
  { type: 'response_item', timestamp: '2026-06-10T03:02:02.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'It describes Muninn.' }] } },
];

async function writeFixtureTranscript(lines = TRANSCRIPT_LINES) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-hook-'));
  process.env.MUNINN_HOME = path.join(dir, 'muninn-home');
  const file = path.join(dir, 'rollout-2026-06-10-019eabcd-codex-session.jsonl');
  await writeFile(file, lines.map((line) => JSON.stringify(line)).join('\n'));
  return file;
}

async function writeFixtureTranscriptWithTwoTurns() {
  return writeFixtureTranscript([...TRANSCRIPT_LINES, ...SECOND_TURN_LINES]);
}

async function appendThirdTurn(transcriptPath) {
  await appendFile(transcriptPath, `\n${THIRD_TURN_LINES.map((line) => JSON.stringify(line)).join('\n')}`);
}

function codexSessionLines(sessionId, cwd, turns) {
  const lines = [
    { type: 'session_meta', payload: { id: sessionId, cwd, timestamp: '2026-06-10T03:00:00.000Z' } },
  ];
  for (const [index, turn] of turns.entries()) {
    const minute = String(index).padStart(2, '0');
    lines.push(
      { type: 'response_item', timestamp: `2026-06-10T03:${minute}:01.000Z`, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: turn.prompt }] } },
      { type: 'response_item', timestamp: `2026-06-10T03:${minute}:02.000Z`, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: turn.response }] } },
    );
  }
  return lines;
}

async function appendCodexTurn(transcriptPath, prompt, response, index) {
  const minute = String(index).padStart(2, '0');
  const lines = [
    { type: 'response_item', timestamp: `2026-06-10T03:${minute}:01.000Z`, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } },
    { type: 'response_item', timestamp: `2026-06-10T03:${minute}:02.000Z`, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: response }] } },
  ];
  await appendFile(transcriptPath, `\n${lines.map((line) => JSON.stringify(line)).join('\n')}`);
}

function captureClient() {
  const captured = [];
  return {
    captured,
    client: {
      async captureTurn(request) {
        captured.push(request);
        return true;
      },
    },
  };
}

test('isStopEvent matches Stop case-insensitively and rejects others', () => {
  assert.equal(isStopEvent({ hook_event_name: 'Stop' }), true);
  assert.equal(isStopEvent({ hook_event_name: 'stop' }), true);
  assert.equal(isStopEvent({ hook_event_name: 'UserPromptSubmit' }), false);
  assert.equal(isStopEvent({}), false);
});

test('handleStop maps the latest transcript turn to TurnContent and captures it', async () => {
  const transcriptPath = await writeFixtureTranscript();
  const { captured, client } = captureClient();

  const ok = await handleStop(
    { hook_event_name: 'Stop', transcript_path: transcriptPath, session_id: '019eabcd-codex-session' },
    { client },
  );

  assert.equal(ok, true);
  assert.equal(captured.length, 1);
  const { turn } = captured[0];

  assert.equal(turn.sessionId, '019eabcd-codex-session');
  assert.equal(turn.agent, 'codex');
  assert.equal(turn.project, '/Users/dev/workspace/muninn');
  assert.equal(turn.cwd, '/Users/dev/workspace/muninn');
  assert.equal(turn.prompt, 'list the files');
  assert.equal(turn.response, 'There is one file: README.md');
  assert.equal(turn.metadata.ingest, 'codex-hook');
  assert.equal(turn.turnSequence, 0);
  assert.equal(turn.metadata[LEGACY_SEQUENCE_KEY], undefined);

  assert.deepEqual(turn.events.map((event) => event.type), [
    'userMessage',
    'toolCall',
    'toolOutput',
    'assistantMessage',
  ]);

  const marker = turn.artifacts.find((artifact) => artifact.key === 'codex.import');
  assert.ok(marker, 'expected codex.import marker artifact');
  const markerContent = JSON.parse(marker.content);
  assert.equal(markerContent.marker, '019eabcd-codex-session#1');
  assert.equal(markerContent[LEGACY_SEQUENCE_KEY], undefined);
});

test('handleStop full parses once but captures only latest turn with turn sequence', async () => {
  const transcriptPath = await writeFixtureTranscriptWithTwoTurns();
  const { captured, client } = captureClient();

  const ok = await handleStop(
    { hook_event_name: 'Stop', transcript_path: transcriptPath, session_id: '019eabcd-codex-session' },
    { client },
  );

  assert.equal(ok, true);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].turn.prompt, 'read the file');
  assert.equal(captured[0].turn.turnSequence, 1);
});

test('handleStop uses transcript cache for appended turns', async () => {
  const transcriptPath = await writeFixtureTranscriptWithTwoTurns();
  const { captured, client } = captureClient();

  await handleStop(
    { hook_event_name: 'Stop', transcript_path: transcriptPath, session_id: '019eabcd-codex-session' },
    { client },
  );
  await appendThirdTurn(transcriptPath);
  await handleStop(
    { hook_event_name: 'Stop', transcript_path: transcriptPath, session_id: '019eabcd-codex-session' },
    { client },
  );

  assert.equal(captured.length, 2);
  assert.equal(captured[0].turn.turnSequence, 1);
  assert.equal(captured[1].turn.prompt, 'summarize it');
  assert.equal(captured[1].turn.turnSequence, 2);
});

test('handleStop returns false when transcript is missing', async () => {
  const { captured, client } = captureClient();
  const ok = await handleStop(
    { hook_event_name: 'Stop', transcript_path: '/nonexistent/path.jsonl' },
    { client, sessionsRoot: path.join(os.tmpdir(), 'codex-hook-empty-root') },
  );
  assert.equal(ok, false);
  assert.equal(captured.length, 0);
});

test('handleStop resolves and caches multiple Codex transcript files independently', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-hook-multiple-'));
  process.env.MUNINN_HOME = path.join(root, 'muninn-home');
  const sessionsRoot = path.join(root, 'sessions');
  const sessionDir = path.join(sessionsRoot, '2026', '06', '10');
  await mkdir(sessionDir, { recursive: true });
  const sessionA = path.join(sessionDir, 'rollout-2026-06-10-codex-session-a.jsonl');
  const sessionB = path.join(sessionDir, 'rollout-2026-06-10-codex-session-b.jsonl');
  await writeFile(sessionA, codexSessionLines('codex-session-a', '/Users/dev/workspace/alpha', [
    { prompt: 'alpha first prompt', response: 'alpha first response' },
  ]).map((line) => JSON.stringify(line)).join('\n'));
  await writeFile(sessionB, codexSessionLines('codex-session-b', '/Users/dev/workspace/beta', [
    { prompt: 'beta first prompt', response: 'beta first response' },
    { prompt: 'beta second prompt', response: 'beta second response' },
  ]).map((line) => JSON.stringify(line)).join('\n'));
  const { captured, client } = captureClient();

  assert.equal(await handleStop({ hook_event_name: 'Stop', session_id: 'codex-session-b' }, { client, sessionsRoot }), true);
  assert.equal(await handleStop({ hook_event_name: 'Stop', session_id: 'codex-session-a' }, { client, sessionsRoot }), true);
  await appendCodexTurn(sessionA, 'alpha second prompt', 'alpha second response', 1);
  assert.equal(await handleStop({ hook_event_name: 'Stop', session_id: 'codex-session-a' }, { client, sessionsRoot }), true);

  assert.equal(captured.length, 3);
  assert.deepEqual(captured.map(({ turn }) => [turn.sessionId, turn.prompt, turn.turnSequence]), [
    ['codex-session-b', 'beta second prompt', 1],
    ['codex-session-a', 'alpha first prompt', 0],
    ['codex-session-a', 'alpha second prompt', 1],
  ]);
});

test('handleStop resolves transcript by exact session id suffix', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-hook-overlap-'));
  process.env.MUNINN_HOME = path.join(root, 'muninn-home');
  const sessionsRoot = path.join(root, 'sessions');
  const sessionDir = path.join(sessionsRoot, '2026', '06', '10');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path.join(sessionDir, 'rollout-2026-06-10-codex-session-extra.jsonl'), codexSessionLines(
    'codex-session-extra',
    '/Users/dev/workspace/wrong',
    [{ prompt: 'wrong prompt', response: 'wrong response' }],
  ).map((line) => JSON.stringify(line)).join('\n'));
  await writeFile(path.join(sessionDir, 'rollout-2026-06-10-codex-session.jsonl'), codexSessionLines(
    'codex-session',
    '/Users/dev/workspace/right',
    [{ prompt: 'right prompt', response: 'right response' }],
  ).map((line) => JSON.stringify(line)).join('\n'));
  const { captured, client } = captureClient();

  const ok = await handleStop({ hook_event_name: 'Stop', session_id: 'codex-session' }, { client, sessionsRoot });

  assert.equal(ok, true);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].turn.sessionId, 'codex-session');
  assert.equal(captured[0].turn.prompt, 'right prompt');
});

test('readCodexSession resolves linked worktrees to the GitHub project identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-worktree-project-'));
  process.env.MUNINN_HOME = path.join(root, 'muninn-home');
  const mainRepo = path.join(root, 'muninn');
  const linkedWorktree = path.join(root, 'muninn-import-ui');
  await mkdir(mainRepo);
  await execFileAsync('git', ['-C', mainRepo, 'init']);
  await execFileAsync('git', ['-C', mainRepo, 'config', 'user.email', 'test@example.com']);
  await execFileAsync('git', ['-C', mainRepo, 'config', 'user.name', 'Test User']);
  await writeFile(path.join(mainRepo, 'README.md'), 'muninn\n');
  await execFileAsync('git', ['-C', mainRepo, 'add', 'README.md']);
  await execFileAsync('git', ['-C', mainRepo, 'commit', '-m', 'init']);
  await execFileAsync('git', ['-C', mainRepo, 'remote', 'add', 'origin', 'git@github.com:majin1102/muninn.git']);
  await execFileAsync('git', ['-C', mainRepo, 'worktree', 'add', linkedWorktree]);
  const nestedWorktreeDir = path.join(linkedWorktree, 'src');
  await mkdir(nestedWorktreeDir);

  const transcript = path.join(root, 'worktree-session.jsonl');
  const lines = [
    { type: 'session_meta', payload: { id: 'worktree-session', cwd: nestedWorktreeDir, timestamp: '2026-06-10T03:00:00.000Z' } },
    { type: 'response_item', timestamp: '2026-06-10T03:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'check worktree' }] } },
    { type: 'response_item', timestamp: '2026-06-10T03:00:02.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } },
  ];
  await writeFile(transcript, lines.map((line) => JSON.stringify(line)).join('\n'));

  const session = await readCodexSession(transcript, { artifactStore: path.join(root, 'artifacts'), artifactMode: 'preview' });

  assert.ok(session);
  assert.equal(session.cwd, nestedWorktreeDir);
  assert.equal(session.project, 'github.com/majin1102/muninn');
});

test('readCodexSession resolves repo subdirectories to the GitHub project identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-subdir-project-'));
  process.env.MUNINN_HOME = path.join(root, 'muninn-home');
  const repo = path.join(root, 'muninn');
  const nestedDir = path.join(repo, 'server');
  await mkdir(nestedDir, { recursive: true });
  await execFileAsync('git', ['-C', repo, 'init']);
  await execFileAsync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  await execFileAsync('git', ['-C', repo, 'config', 'user.name', 'Test User']);
  await writeFile(path.join(repo, 'README.md'), 'muninn\n');
  await execFileAsync('git', ['-C', repo, 'add', 'README.md']);
  await execFileAsync('git', ['-C', repo, 'commit', '-m', 'init']);
  await execFileAsync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/majin1102/muninn.git']);

  const transcript = path.join(root, 'subdir-session.jsonl');
  const lines = [
    { type: 'session_meta', payload: { id: 'subdir-session', cwd: nestedDir, timestamp: '2026-06-10T03:00:00.000Z' } },
    { type: 'response_item', timestamp: '2026-06-10T03:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'check subdir' }] } },
    { type: 'response_item', timestamp: '2026-06-10T03:00:02.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } },
  ];
  await writeFile(transcript, lines.map((line) => JSON.stringify(line)).join('\n'));

  const session = await readCodexSession(transcript, { artifactStore: path.join(root, 'artifacts'), artifactMode: 'preview' });

  assert.ok(session);
  assert.equal(session.cwd, nestedDir);
  assert.equal(session.project, 'github.com/majin1102/muninn');
});

test('readCodexSession resolves deleted worktrees from transcript GitHub repository metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-archived-worktree-project-'));
  process.env.MUNINN_HOME = path.join(root, 'muninn-home');
  const deletedWorktree = path.join(os.homedir(), '.codex', 'worktrees', '40fd', 'muninn');
  const transcript = path.join(root, 'archived-worktree-session.jsonl');
  const lines = [
    {
      type: 'session_meta',
      payload: {
        id: 'archived-worktree-session',
        cwd: deletedWorktree,
        timestamp: '2026-06-10T03:00:00.000Z',
        git: {
          commit_hash: '5036899f54a71ee61074416f32392863a6111349',
          repository_url: 'https://github.com/majin1102/muninn',
        },
      },
    },
    { type: 'response_item', timestamp: '2026-06-10T03:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'check archived worktree' }] } },
    { type: 'response_item', timestamp: '2026-06-10T03:00:02.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } },
  ];
  await writeFile(transcript, lines.map((line) => JSON.stringify(line)).join('\n'));

  const session = await readCodexSession(transcript, { artifactStore: path.join(root, 'artifacts'), artifactMode: 'preview' });
  const summary = await readCodexSessionSummary(transcript);

  assert.ok(session);
  assert.equal(session.cwd, deletedWorktree);
  assert.equal(session.project, 'github.com/majin1102/muninn');
  assert.ok(summary);
  assert.equal(summary.project, 'github.com/majin1102/muninn');
});

test('readCodexSessionSummary skips injected context when deriving the title', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-summary-title-'));
  process.env.MUNINN_HOME = path.join(root, 'muninn-home');
  const transcript = path.join(root, 'summary-session.jsonl');
  const lines = [
    { type: 'session_meta', payload: { id: 'summary-session', cwd: root, timestamp: '2026-06-12T03:00:00.000Z' } },
    {
      type: 'response_item',
      timestamp: '2026-06-12T03:00:01.000Z',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `# AGENTS.md instructions for ${root}\n\n<environment_context>\n  <cwd>${root}</cwd>\n</environment_context>` }],
      },
    },
    {
      type: 'response_item',
      timestamp: '2026-06-12T03:00:02.000Z',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Fix the import sessions title logic' }],
      },
    },
    {
      type: 'response_item',
      timestamp: '2026-06-12T03:00:03.000Z',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Done' }],
      },
    },
  ];
  await writeFile(transcript, lines.map((line) => JSON.stringify(line)).join('\n'));

  const summary = await readCodexSessionSummary(transcript);

  assert.ok(summary);
  assert.equal(summary.title, 'Fix the import sessions title logic');
  assert.equal(summary.promptPreview, 'Fix the import sessions title logic');
});

test('readCodexSessionSummary uses the transcript latest timestamp instead of file mtime', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-summary-updated-at-'));
  process.env.MUNINN_HOME = path.join(root, 'muninn-home');
  const transcript = path.join(root, 'summary-session.jsonl');
  const lines = [
    { type: 'session_meta', payload: { id: 'summary-session', cwd: root, timestamp: '2026-06-12T03:00:00.000Z' } },
    {
      type: 'response_item',
      timestamp: '2026-06-12T03:00:01.000Z',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Sort import sessions by transcript time' }],
      },
    },
    {
      type: 'response_item',
      timestamp: '2026-06-12T03:00:02.000Z',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Done' }],
      },
    },
    {
      type: 'response_item',
      timestamp: '2026-06-12T03:45:00.000Z',
      payload: { type: 'function_call_output', call_id: 'call-1', output: 'late event' },
    },
  ];
  await writeFile(transcript, lines.map((line) => JSON.stringify(line)).join('\n'));
  await utimes(transcript, new Date('2026-06-13T00:00:00.000Z'), new Date('2026-06-13T00:00:00.000Z'));

  const summary = await readCodexSessionSummary(transcript);

  assert.ok(summary);
  assert.equal(summary.updatedAt, '2026-06-12T03:45:00.000Z');
});

test('resolveProjectIdentity reuses the v3 local project cache before git resolution', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-project-cache-'));
  const cwd = path.join(root, 'worktree');
  const muninnHome = path.join(root, 'muninn-home');
  await mkdir(cwd);
  await mkdir(muninnHome);
  process.env.MUNINN_HOME = muninnHome;

  const cwdRealpath = await realpath(cwd);
  const cachedProject = '/cached/main/project';
  await writeFile(path.join(muninnHome, 'project-cache.json'), `${JSON.stringify({
    version: 3,
    projectsByCwd: {
      [cwdRealpath]: {
        project: cachedProject,
        resolvedAt: '2026-06-11T00:00:00.000Z',
      },
    },
  })}\n`);

  const identity = await resolveProjectIdentity(cwd);

  assert.equal(identity.project, cachedProject);
});

test('resolveProjectIdentity uses an in-process cache and in-flight de-duplication', async () => {
  const source = await readFile(new URL('../src/mapping.ts', import.meta.url), 'utf8');

  assert.match(source, /const projectIdentityCache = new Map<string, ProjectIdentity>\(\)/);
  assert.match(source, /const projectIdentityInflight = new Map<string, Promise<ProjectIdentity>>\(\)/);
  assert.match(source, /projectIdentityInflight\.get\(fallback\)/);
  assert.match(source, /projectIdentityCache\.set\(fallback, identity\)/);
});

test('resolveProjectIdentity ignores stale v2 project cache and resolves GitHub remote identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-project-cache-v3-'));
  const repo = path.join(root, 'lance');
  const muninnHome = path.join(root, 'muninn-home');
  await mkdir(repo, { recursive: true });
  await mkdir(muninnHome, { recursive: true });
  process.env.MUNINN_HOME = muninnHome;
  await execFileAsync('git', ['-C', repo, 'init']);
  await execFileAsync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/lance-format/lance.git']);
  const repoRealpath = await realpath(repo);
  await writeFile(path.join(muninnHome, 'project-cache.json'), `${JSON.stringify({
    version: 2,
    projectsByCwd: {
      [repoRealpath]: {
        project: repoRealpath,
        resolvedAt: '2026-06-11T00:00:00.000Z',
      },
    },
  })}\n`);

  const identity = await resolveProjectIdentity(repo);

  assert.equal(identity.project, 'github.com/lance-format/lance');
  const cache = JSON.parse(await readFile(path.join(muninnHome, 'project-cache.json'), 'utf8'));
  assert.equal(cache.version, 3);
  assert.equal(cache.projectsByCwd[repoRealpath].project, 'github.com/lance-format/lance');
});

test('resolveProjectIdentity normalizes supported GitHub remote URL formats', async () => {
  const cases = [
    ['git@github.com:lance-format/lance.git', 'github.com/lance-format/lance'],
    ['https://github.com/lance-format/lance.git', 'github.com/lance-format/lance'],
    ['ssh://git@github.com/lance-format/lance.git', 'github.com/lance-format/lance'],
  ];

  for (const [remote, expected] of cases) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-github-remote-'));
    const repo = path.join(root, 'repo');
    process.env.MUNINN_HOME = path.join(root, 'muninn-home');
    await mkdir(repo, { recursive: true });
    await execFileAsync('git', ['-C', repo, 'init']);
    await execFileAsync('git', ['-C', repo, 'remote', 'add', 'origin', remote]);

    const identity = await resolveProjectIdentity(repo);

    assert.equal(identity.project, expected);
  }
});

test('resolveProjectIdentity falls back to upstream GitHub remote when origin is not GitHub', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-github-upstream-'));
  const repo = path.join(root, 'repo');
  process.env.MUNINN_HOME = path.join(root, 'muninn-home');
  await mkdir(repo, { recursive: true });
  await execFileAsync('git', ['-C', repo, 'init']);
  await execFileAsync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@example.com:private/repo.git']);
  await execFileAsync('git', ['-C', repo, 'remote', 'add', 'upstream', 'ssh://git@github.com/lance-format/lance.git']);

  const identity = await resolveProjectIdentity(repo);

  assert.equal(identity.project, 'github.com/lance-format/lance');
});

test('resolveProjectIdentity falls back to local path for non-GitHub remotes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-non-github-remote-'));
  const repo = path.join(root, 'repo');
  process.env.MUNINN_HOME = path.join(root, 'muninn-home');
  await mkdir(repo, { recursive: true });
  await execFileAsync('git', ['-C', repo, 'init']);
  await execFileAsync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@example.com:private/repo.git']);

  const identity = await resolveProjectIdentity(repo);

  assert.equal(identity.project, await realpath(repo));
});

test('resolveProjectIdentity maps deleted Codex worktrees to the matching workspace project', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-deleted-worktree-project-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  process.env.MUNINN_HOME = path.join(root, 'muninn-home');
  const repo = path.join(root, 'workspace', 'openclaw');
  await mkdir(repo, { recursive: true });
  await execFileAsync('git', ['-C', repo, 'init']);
  await execFileAsync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:majin1102/openclaw.git']);

  try {
    const identity = await resolveProjectIdentity(path.join(root, '.codex', 'worktrees', '02a9', 'openclaw'));

    assert.equal(identity.project, 'github.com/majin1102/openclaw');
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

test('resolveProjectIdentity refreshes fallback cache entries for deleted Codex worktrees', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-deleted-worktree-cache-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  process.env.MUNINN_HOME = path.join(root, 'muninn-home');
  const cwd = path.join(root, '.codex', 'worktrees', '02a9', 'openclaw');
  const repo = path.join(root, 'workspace', 'openclaw');
  await mkdir(repo, { recursive: true });
  await mkdir(process.env.MUNINN_HOME, { recursive: true });
  await execFileAsync('git', ['-C', repo, 'init']);
  await execFileAsync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:majin1102/openclaw.git']);
  await writeFile(path.join(process.env.MUNINN_HOME, 'project-cache.json'), `${JSON.stringify({
    version: 3,
    projectsByCwd: {
      [path.resolve(cwd)]: {
        project: path.resolve(cwd),
        resolvedAt: '2026-06-11T00:00:00.000Z',
      },
    },
  })}\n`);

  try {
    const identity = await resolveProjectIdentity(cwd);

    assert.equal(identity.project, 'github.com/majin1102/openclaw');
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});
