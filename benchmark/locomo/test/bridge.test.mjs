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
    pipeline: 'oracle',
    mode: 'dialog',
    'muninn-home': home,
  });

  const recalled = await runBridge('recall', {
    pipeline: 'oracle',
    mode: 'dialog',
    query: 'support group',
    limit: 5,
    'muninn-home': home,
  });

  assert.ok(recalled.hits.some((hit) => hit.source_id === 'D1:1'));
  assert.ok(recalled.hits.every((hit) => hit.mode === 'dialog'));
  assert.ok(recalled.hits.some((hit) => hit.session_no === 1));
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
    pipeline: 'oracle',
    mode: 'observation',
    'muninn-home': observationHome,
  });
  const observationRecall = await runBridge('recall', {
    pipeline: 'oracle',
    mode: 'observation',
    query: 'charity race',
    limit: 5,
    'muninn-home': observationHome,
  });
  assert.ok(observationRecall.hits.some((hit) => hit.source_id === 'D2:1'));

  await runBridge('reset-home', { 'muninn-home': summaryHome });
  await runBridge('import-sample', {
    'data-file': fixturePath,
    'sample-id': 'sample-a',
    pipeline: 'oracle',
    mode: 'summary',
    'muninn-home': summaryHome,
  });
  const summaryRecall = await runBridge('recall', {
    pipeline: 'oracle',
    mode: 'summary',
    query: 'support group',
    limit: 5,
    'muninn-home': summaryHome,
  });
  assert.ok(summaryRecall.hits.some((hit) => hit.source_id === 'S1'));
});

test('generated observation recall resolves real observing hits back to dialog source ids', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'muninn-locomo-generated-observation-'));
  t.after(async () => rm(home, { recursive: true, force: true }));

  await runBridge('reset-home', { 'muninn-home': home });
  await runBridge('import-sample', {
    'data-file': fixturePath,
    'sample-id': 'sample-a',
    pipeline: 'generated',
    mode: 'observation',
    'muninn-home': home,
  });

  const recalled = await runBridge('recall', {
    pipeline: 'generated',
    mode: 'observation',
    query: 'charity race',
    limit: 5,
    'muninn-home': home,
  });

  assert.ok(recalled.hits.some((hit) => hit.source_id === 'D2:1'));
  assert.ok(recalled.hits.every((hit) => /^OBSERVING:/.test(hit.memory_id)));
  assert.ok(recalled.hits.some((hit) => hit.summary || hit.detail));
});

test('generated summary recall resolves to session summary ids', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'muninn-locomo-generated-summary-'));
  t.after(async () => rm(home, { recursive: true, force: true }));

  await runBridge('reset-home', { 'muninn-home': home });
  await runBridge('import-sample', {
    'data-file': fixturePath,
    'sample-id': 'sample-a',
    pipeline: 'generated',
    mode: 'summary',
    'muninn-home': home,
  });

  const recalled = await runBridge('recall', {
    pipeline: 'generated',
    mode: 'summary',
    query: 'support group',
    limit: 5,
    'muninn-home': home,
  });

  assert.ok(recalled.hits.some((hit) => hit.source_id === 'S1'));
  assert.ok(recalled.hits.every((hit) => /^SESSION:/.test(hit.memory_id)));
  assert.ok(recalled.hits.some((hit) => hit.summary || hit.detail));
});
