import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

test('import writes an external manifest aligned to locomo sessions', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'muninn-locomo-import-'));
  t.after(async () => rm(home, { recursive: true, force: true }));

  await runBridge('reset-home', { 'muninn-home': home });
  const imported = await runBridge('import-sample', {
    'data-file': fixturePath,
    'sample-id': 'sample-a',
    'muninn-home': home,
  });

  const manifest = JSON.parse(await readFile(imported.manifest_path, 'utf8'));
  assert.equal(imported.imported_count, 3);
  assert.equal(manifest.turns.length, 3);
  assert.equal(manifest.turns[0].source_id, 'D1:1');
  assert.equal(manifest.turns[0].session_id, 'locomo:sample-a:session_1');
  assert.equal(manifest.turns[2].session_id, 'locomo:sample-a:session_2');
});

test('recall returns evidence ids without leaking benchmark artifacts into muninn rows', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'muninn-locomo-recall-'));
  t.after(async () => rm(home, { recursive: true, force: true }));

  await runBridge('reset-home', { 'muninn-home': home });
  await runBridge('import-sample', {
    'data-file': fixturePath,
    'sample-id': 'sample-a',
    'muninn-home': home,
  });

  const recalled = await runBridge('recall', {
    query: 'support group',
    limit: 5,
    'muninn-home': home,
  });

  assert.equal(recalled.hits[0].evidence_ids[0], 'D1:1');
  assert.equal(recalled.hits[0].date_time, '1:56 pm on 8 May, 2023');
  assert.ok(!('source_id' in recalled.hits[0]));
});

test('recursive evidence resolution can walk observing lineage back to turn ids', async () => {
  const bridgeModule = await import(bridgePath);
  const evidenceIds = bridgeModule.resolveEvidenceIdsFromGraph(
    'observing:9',
    [
      {
        turn_id: 'session:101',
        source_id: 'D1:1',
        sample_id: 'sample-a',
        session_id: 'locomo:sample-a:session_1',
        date_time: '1:56 pm on 8 May, 2023',
        import_order: 0,
      },
      {
        turn_id: 'session:102',
        source_id: 'D2:1',
        sample_id: 'sample-a',
        session_id: 'locomo:sample-a:session_2',
        date_time: '1:14 pm on 25 May, 2023',
        import_order: 1,
      },
    ],
    {
      'observing:9': ['observing:7', 'session:102'],
      'observing:7': ['session:101'],
    },
  );

  assert.deepEqual(evidenceIds, ['D1:1', 'D2:1']);
});
