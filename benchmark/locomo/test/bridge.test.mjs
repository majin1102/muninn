import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, '../../..');
const bridgePath = path.join(repoRoot, 'benchmark/locomo/dist/bridge.js');
const fixturePath = path.join(repoRoot, 'benchmark/locomo/test/fixtures/mini-locomo.json');

async function runBridge(command, options) {
  const args = [bridgePath, command];
  for (const [key, value] of Object.entries(options)) {
    args.push(`--${key}`, String(value));
  }
  const { stdout } = await execFileAsync('node', args, { cwd: repoRoot });
  return JSON.parse(stdout);
}

test('dialog import and recall expose structured source ids', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'muninn-locomo-dialog-'));
  t.after(async () => rm(home, { recursive: true, force: true }));

  await runBridge('reset-home', { 'muninn-home': home });
  await runBridge('import-sample', {
    'data-file': fixturePath,
    'sample-id': 'sample-a',
    mode: 'dialog',
    'muninn-home': home,
  });

  const recalled = await runBridge('recall', {
    query: 'support group',
    limit: 5,
    'muninn-home': home,
  });

  assert.equal(recalled.hits[0].source_id, 'D1:1');
  assert.equal(recalled.hits[0].mode, 'dialog');
  assert.equal(recalled.hits[0].session_no, 1);
});

test('observation and summary modes preserve their source ids', async (t) => {
  const observationHome = await mkdtemp(path.join(os.tmpdir(), 'muninn-locomo-observation-'));
  const summaryHome = await mkdtemp(path.join(os.tmpdir(), 'muninn-locomo-summary-'));
  t.after(async () => rm(observationHome, { recursive: true, force: true }));
  t.after(async () => rm(summaryHome, { recursive: true, force: true }));

  await runBridge('reset-home', { 'muninn-home': observationHome });
  await runBridge('import-sample', {
    'data-file': fixturePath,
    'sample-id': 'sample-a',
    mode: 'observation',
    'muninn-home': observationHome,
  });
  const observationRecall = await runBridge('recall', {
    query: 'charity race',
    limit: 5,
    'muninn-home': observationHome,
  });
  assert.equal(observationRecall.hits[0].source_id, 'D2:1');

  await runBridge('reset-home', { 'muninn-home': summaryHome });
  await runBridge('import-sample', {
    'data-file': fixturePath,
    'sample-id': 'sample-a',
    mode: 'summary',
    'muninn-home': summaryHome,
  });
  const summaryRecall = await runBridge('recall', {
    query: 'support group',
    limit: 5,
    'muninn-home': summaryHome,
  });
  assert.equal(summaryRecall.hits[0].source_id, 'S1');
});
