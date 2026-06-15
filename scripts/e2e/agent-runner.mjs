import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestJson, waitFor } from './http.mjs';
import {
  assertCaptureEnabled,
  assertNoRecallHit,
  assertProjectAbsent,
  assertRecallHit,
  assertSessionTurn,
  assertSessionAbsent,
  waitForSession,
} from './assertions.mjs';
import { PROJECT_ID, createWorkspace, stopPayload, writeMuninnConfig } from './fixtures.mjs';
import { startMuninnServer } from './server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function log(fields) {
  const text = Object.entries(fields).map(([key, value]) => `${key}=${String(value)}`).join(' ');
  console.log(`[muninn:e2e] ${text}`);
}

export async function commandExists(command) {
  const child = spawn(process.platform === 'win32' ? 'where' : 'command', process.platform === 'win32' ? [command] : ['-v', command], {
    shell: process.platform !== 'win32',
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  return code === 0;
}

async function runHook({ hookPath, payload, baseUrl, env }) {
  const child = spawn(process.execPath, [hookPath], {
    env: {
      ...process.env,
      ...env,
      MUNINN_SERVER_BASE_URL: baseUrl,
      MUNINN_HOOK_TIMEOUT_MS: '5000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(JSON.stringify(payload));
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  if (code !== 0) {
    throw new Error(`hook exited ${code}: stdout=${stdout} stderr=${stderr}`);
  }
  return { stdout, stderr };
}

async function importSession({ baseUrl, agent, sourcePath }) {
  return requestJson(baseUrl, `/api/v1/ui/import/${agent}/sessions`, {
    method: 'POST',
    body: JSON.stringify({ sourcePaths: [sourcePath] }),
  });
}

async function deleteSession({ baseUrl, agent, sessionId }) {
  return requestJson(baseUrl, `/api/v1/ui/import/${agent}/session`, {
    method: 'DELETE',
    body: JSON.stringify({ project: PROJECT_ID, sessionId }),
  });
}

async function deleteProject({ baseUrl, agent }) {
  return requestJson(baseUrl, `/api/v1/ui/import/${agent}/project`, {
    method: 'DELETE',
    body: JSON.stringify({ project: PROJECT_ID }),
  });
}

async function finalizeMemory(baseUrl) {
  await requestJson(baseUrl, '/api/v1/memory/finalize', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  await waitFor(async () => {
    const watermark = await requestJson(baseUrl, '/api/v1/memory/watermark');
    return watermark.pending.turns.length === 0
      && watermark.pending.extractions.length === 0
      && watermark.phases.extractor === 'idle'
      && watermark.phases.observer === 'idle'
      && !watermark.error;
  }, { timeoutMs: 10000, intervalMs: 100, label: 'memory finalize' });
}

async function runMockRound(config, workspace, server) {
  const baselineSessionId = `e2e-${config.shortName}-baseline`;
  const liveSessionId = `e2e-${config.shortName}-live`;
  const afterDeleteSessionId = `e2e-${config.shortName}-after-delete`;
  const baselineRelease = {
    prompt: `Record the Muninn E2E release policy for ${config.shortName}: npm packages must use dist-tag next until MVP1 exits beta.`,
    response: `Remembered for ${config.shortName}: Muninn E2E package releases use npm dist-tag next before MVP1 exits beta.`,
  };
  const baselineCapture = {
    prompt: `Record the Muninn E2E capture policy for ${config.shortName}: after project deletion, Stop hooks should exit successfully and write zero turns.`,
    response: `Remembered for ${config.shortName}: deleted project capture policy makes Stop hooks write zero turns while still exiting successfully.`,
  };
  const liveFact = {
    prompt: `Record the Muninn E2E live hook fact for ${config.shortName}: live capture is produced by the real ${config.hookIngest} hook binary.`,
    response: `Remembered for ${config.shortName}: live capture came through the real ${config.hookIngest} hook binary.`,
  };
  const disabledFact = {
    prompt: `Record the Muninn E2E disabled fact for ${config.shortName}: this turn must not be captured after project deletion.`,
    response: `This disabled ${config.shortName} fact should never appear in Muninn after project deletion.`,
  };

  const baselinePath = await config.writeTranscript(workspace.home, baselineSessionId, workspace.project, [
    baselineRelease,
    baselineCapture,
  ]);
  const importResult = await importSession({ baseUrl: server.baseUrl, agent: config.agent, sourcePath: baselinePath });
  assert.equal(importResult.importedSessions, 1);
  assert.equal(importResult.importedTurns, 2);
  await waitForSession(server.baseUrl, baselineSessionId);
  await assertSessionTurn(server.baseUrl, config.agent, PROJECT_ID, baselineSessionId, {
    prompt: baselineRelease.prompt,
    response: baselineRelease.response,
  });
  await finalizeMemory(server.baseUrl);
  await assertRecallHit(server.baseUrl, `${config.shortName} dist-tag next MVP1 beta`, {
    agent: config.agent,
    project: PROJECT_ID,
    sessionId: baselineSessionId,
    includes: ['dist-tag next', 'MVP1 exits beta'],
  });
  await assertRecallHit(server.baseUrl, `${config.shortName} Stop hooks zero turns project deletion`, {
    agent: config.agent,
    project: PROJECT_ID,
    sessionId: baselineSessionId,
    includes: ['Stop hooks', 'zero turns'],
  });
  await assertCaptureEnabled(server.baseUrl, config.agent, PROJECT_ID, true);
  log({ run: config.runId, agent: config.agent, driver: 'mock', phase: 'import', status: 'ok', sessions: 1, turns: 2, recall: 'ok', project: PROJECT_ID });

  const livePath = await config.writeTranscript(workspace.home, liveSessionId, workspace.project, [
    liveFact,
  ]);
  await runHook({
    hookPath: config.hookPath,
    payload: stopPayload(liveSessionId, livePath, workspace.project),
    baseUrl: server.baseUrl,
    env: { HOME: workspace.home, MUNINN_HOME: workspace.muninnHome },
  });
  await waitForSession(server.baseUrl, liveSessionId);
  await finalizeMemory(server.baseUrl);
  await assertSessionTurn(server.baseUrl, config.agent, PROJECT_ID, liveSessionId, {
    prompt: liveFact.prompt,
    response: liveFact.response,
  });
  await assertRecallHit(server.baseUrl, `${config.shortName} real ${config.hookIngest} hook binary`, {
    agent: config.agent,
    project: PROJECT_ID,
    sessionId: liveSessionId,
    includes: [config.hookIngest, 'hook binary'],
    allowUnscoped: true,
  });
  log({ run: config.runId, agent: config.agent, driver: 'mock', phase: 'capture', status: 'ok', session: liveSessionId, ingest: config.hookIngest, recall: 'ok' });

  const deletedSession = await deleteSession({ baseUrl: server.baseUrl, agent: config.agent, sessionId: liveSessionId });
  assert.equal(deletedSession.deletedSessions, 1);
  assert.equal(deletedSession.deletedTurns, 1);
  await assertSessionAbsent(server.baseUrl, liveSessionId);
  await assertNoRecallHit(server.baseUrl, `${config.shortName} real ${config.hookIngest} hook binary`, {
    includes: [config.hookIngest, 'hook binary'],
  });
  await assertCaptureEnabled(server.baseUrl, config.agent, PROJECT_ID, true);
  log({ run: config.runId, agent: config.agent, driver: 'mock', phase: 'delete-session', status: 'ok', deletedSessions: 1, deletedTurns: 1, recall: 'absent' });

  const deletedProject = await deleteProject({ baseUrl: server.baseUrl, agent: config.agent });
  assert.ok(deletedProject.deletedSessions >= 1);
  assert.ok(deletedProject.deletedTurns >= 2);
  await assertProjectAbsent(server.baseUrl, PROJECT_ID);
  await assertNoRecallHit(server.baseUrl, `${config.shortName} dist-tag next MVP1 beta`, {
    includes: ['dist-tag next', 'MVP1 exits beta'],
  });
  log({ run: config.runId, agent: config.agent, driver: 'mock', phase: 'delete-project', status: 'ok', deletedSessions: deletedProject.deletedSessions, deletedTurns: deletedProject.deletedTurns, captureEnabled: false, recall: 'absent' });

  const afterDeletePath = await config.writeTranscript(workspace.home, afterDeleteSessionId, workspace.project, [
    disabledFact,
  ]);
  await runHook({
    hookPath: config.hookPath,
    payload: stopPayload(afterDeleteSessionId, afterDeletePath, workspace.project),
    baseUrl: server.baseUrl,
    env: { HOME: workspace.home, MUNINN_HOME: workspace.muninnHome },
  });
  await assertSessionAbsent(server.baseUrl, afterDeleteSessionId);
  await assertNoRecallHit(server.baseUrl, `${config.shortName} disabled fact after project deletion`, {
    includes: ['disabled fact', 'must not be captured'],
  });
  log({ run: config.runId, agent: config.agent, driver: 'mock', phase: 'capture-after-delete', status: 'ok', captured: 0, recall: 'absent' });
}

async function runRealRound(config) {
  const result = await config.realDriver?.();
  if (!result || result.status === 'skip') {
    log({ run: config.runId, agent: config.agent, driver: 'real', phase: 'detect', status: 'skip', reason: result?.reason ?? 'real-driver-unavailable' });
    return;
  }
  throw new Error('real driver returned unsupported result');
}

export async function runAgentE2E(config) {
  const mode = config.mode ?? 'mock';
  const workspace = await createWorkspace(config.shortName);
  await writeMuninnConfig(workspace.muninnHome);
  const server = await startMuninnServer({
    repoRoot: REPO_ROOT,
    home: workspace.muninnHome,
    env: { HOME: workspace.home },
  });
  log({ run: config.runId, agent: config.agent, driver: mode, phase: 'prepare', status: 'ok', home: workspace.muninnHome, server: server.baseUrl });
  try {
    if (mode === 'real') {
      await runRealRound(config);
    } else {
      await runMockRound(config, workspace, server);
    }
  } finally {
    await server.stop();
    if (process.env.MUNINN_E2E_KEEP_TMP !== '1') {
      await rm(workspace.root, { recursive: true, force: true });
    } else {
      log({ run: config.runId, agent: config.agent, phase: 'cleanup', status: 'kept', root: workspace.root });
    }
  }
}
