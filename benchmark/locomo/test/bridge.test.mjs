import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import core from '@muninn/core';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, '../../..');
const bridgePath = path.join(repoRoot, 'benchmark/locomo/dist/bridge.js');
const fixturePath = path.join(repoRoot, 'benchmark/locomo/test/fixtures/mini-locomo.json');

process.env.MUNINN_CORE_ALLOW_CARGO_FALLBACK ??= '1';

async function runBridge(command, options) {
  const args = [bridgePath, command];
  for (const [key, value] of Object.entries(options)) {
    args.push(`--${key}`, String(value));
  }
  const { stdout } = await execFileAsync('node', args, {
    cwd: repoRoot,
    env: process.env,
  });
  return JSON.parse(stdout);
}

async function writeMuninnConfig(
  home,
  { observerProvider, semanticIndexProvider, storageUri } = {},
) {
  const root = {};
  if (storageUri) {
    root.storage = {
      uri: storageUri,
    };
  }
  if (observerProvider) {
    root.observer = {
      name: 'test-observer',
      llm: 'test_observer_llm',
    };
    root.llm = {
      test_observer_llm: { provider: observerProvider },
    };
  }
  if (semanticIndexProvider) {
    root.semanticIndex = {
      embedding: {
        provider: semanticIndexProvider,
        dimensions: 4,
      },
      defaultImportance: 0.7,
    };
  }
  await writeFile(
    path.join(home, 'muninn.json'),
    `${JSON.stringify(root, null, 2)}\n`,
    'utf8',
  );
}

async function prepareSourceConfig(
  t,
  { observerProvider, semanticIndexProvider, storageUri } = {},
) {
  const sourceHome = await mkdtemp(path.join(os.tmpdir(), 'muninn-locomo-source-'));
  t.after(async () => rm(sourceHome, { recursive: true, force: true }));
  t.after(() => {
    delete process.env.MUNINN_HOME;
  });
  await writeMuninnConfig(sourceHome, {
    observerProvider,
    semanticIndexProvider,
    storageUri,
  });
  process.env.MUNINN_HOME = sourceHome;
}

test('import writes an external manifest aligned to locomo sessions', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'muninn-locomo-import-'));
  t.after(async () => rm(home, { recursive: true, force: true }));

  await prepareSourceConfig(t, {
    observerProvider: 'mock',
    semanticIndexProvider: 'mock',
    storageUri: 'file-object-store:///tmp/muninn-shared-storage',
  });
  await runBridge('reset-home', { 'muninn-home': home });
  const imported = await runBridge('import-sample', {
    'data-file': fixturePath,
    'sample-id': 'sample-a',
    'muninn-home': home,
  });

  const copiedConfig = JSON.parse(await readFile(path.join(home, 'muninn.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(imported.manifest_path, 'utf8'));
  assert.equal(imported.imported_count, 3);
  assert.equal(manifest.turns.length, 3);
  assert.equal(manifest.turns[0].source_id, 'D1:1');
  assert.equal(manifest.turns[0].session_id, 'locomo:sample-a:session_1');
  assert.equal(manifest.turns[2].session_id, 'locomo:sample-a:session_2');
  assert.equal(copiedConfig.observer.llm, 'test_observer_llm');
  assert.equal(copiedConfig.storage, undefined);
});

test('recall returns evidence ids without leaking benchmark artifacts into muninn rows', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'muninn-locomo-recall-'));
  t.after(async () => rm(home, { recursive: true, force: true }));
  t.after(() => {
    delete process.env.MUNINN_OBSERVER_POLL_MS;
  });

  await prepareSourceConfig(t, {
    observerProvider: 'mock',
    semanticIndexProvider: 'mock',
  });
  await runBridge('reset-home', { 'muninn-home': home });
  process.env.MUNINN_OBSERVER_POLL_MS = '20';
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

  assert.ok(recalled.hits[0].evidence_ids.includes('D1:1'));
  assert.match(recalled.hits[0].date_time ?? '', /1:56 pm on 8 May, 2023/);
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

test('waitForImportWatermark times out with pending turn ids when observer does not flush in time', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'muninn-locomo-watermark-timeout-'));
  t.after(async () => rm(home, { recursive: true, force: true }));
  t.after(async () => core.shutdownCoreForTests());
  t.after(() => {
    delete process.env.MUNINN_OBSERVER_POLL_MS;
  });

  await prepareSourceConfig(t, {
    observerProvider: 'mock',
    semanticIndexProvider: 'mock',
  });
  await runBridge('reset-home', { 'muninn-home': home });
  await runBridge('import-sample', {
    'data-file': fixturePath,
    'sample-id': 'sample-a',
    'muninn-home': home,
  });

  process.env.MUNINN_HOME = home;
  process.env.MUNINN_OBSERVER_POLL_MS = '60000';
  const bridgeModule = await import(bridgePath);
  const manifest = JSON.parse(await readFile(path.join(home, 'locomo-manifest.json'), 'utf8'));

  await assert.rejects(
    () => bridgeModule.waitForImportWatermark(manifest, {
      pollMs: 10,
      timeoutMs: 50,
    }),
    /observer watermark timeout.*pending turn ids/i,
  );
});

test('import only fails fast when semantic index config is missing', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'muninn-locomo-missing-config-'));
  t.after(async () => rm(home, { recursive: true, force: true }));

  await prepareSourceConfig(t, {});
  await runBridge('reset-home', { 'muninn-home': home });

  await assert.rejects(
    () => runBridge('import-sample', {
      'data-file': fixturePath,
      'sample-id': 'sample-a',
      'muninn-home': home,
    }),
    /LoCoMo benchmark requires semanticIndex\.embedding(?:\.provider)?/i,
  );
});

test('waitForImportWatermark emits a delayed warning when observer is not configured', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'muninn-locomo-warning-'));
  t.after(async () => rm(home, { recursive: true, force: true }));
  t.after(async () => core.shutdownCoreForTests());
  t.after(() => {
    delete process.env.MUNINN_OBSERVER_POLL_MS;
  });

  await prepareSourceConfig(t, {
    semanticIndexProvider: 'mock',
  });
  await runBridge('reset-home', { 'muninn-home': home });
  await runBridge('import-sample', {
    'data-file': fixturePath,
    'sample-id': 'sample-a',
    'muninn-home': home,
  });

  process.env.MUNINN_HOME = home;
  process.env.MUNINN_OBSERVER_POLL_MS = '60000';
  const bridgeModule = await import(bridgePath);
  const manifest = JSON.parse(await readFile(path.join(home, 'locomo-manifest.json'), 'utf8'));
  const originalError = console.error;
  const messages = [];
  console.error = (...args) => {
    messages.push(args.join(' '));
  };

  try {
    await assert.rejects(
      () => bridgeModule.waitForImportWatermark(manifest, {
        pollMs: 10,
        timeoutMs: 60,
        warningDelayMs: 0,
      }),
      /observer watermark timeout.*pending turn ids/i,
    );
  } finally {
    console.error = originalError;
  }

  assert.ok(messages.some((message) => /observer is not configured/i.test(message)));
});
