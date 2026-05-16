import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import core from '@muninn/core';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, '../../..');
const bridgePath = path.join(repoRoot, 'benchmark/locomo/dist/bridge.js');
const fixturePath = path.join(repoRoot, 'benchmark/locomo/test/fixtures/mini-locomo.json');

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runBridge(command, options) {
  const args = [bridgePath, command];
  for (const [key, value] of Object.entries(options)) {
    args.push(`--${key}`, String(value));
  }
  const { stdout } = await execFileAsync(process.execPath, args, {
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
    root.extraction = {
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
  t.after(async () => core.shutdownCoreForTests());

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
  assert.match(manifest.turns[0].turn_id, /^turn:/);
  assert.match(manifest.turns[1].turn_id, /^turn:/);
  assert.equal(manifest.turns[0].turn_id, manifest.turns[1].turn_id);
  assert.notEqual(manifest.turns[1].turn_id, manifest.turns[2].turn_id);
  assert.equal(manifest.turns[0].source_id, 'D1:1');
  assert.equal(manifest.turns[1].source_id, 'D1:2');
  assert.equal(manifest.turns[0].session_id, 'locomo:sample-a:session_1');
  assert.equal(manifest.turns[2].session_id, 'locomo:sample-a:session_2');
  assert.equal(copiedConfig.observer.llm, 'test_observer_llm');
  assert.equal(copiedConfig.storage, undefined);

  process.env.MUNINN_HOME = home;
  const importedTurns = await core.turns.list({
    mode: { type: 'recency', limit: 10 },
    sessionId: 'locomo:sample-a:session_1',
    agent: 'Caroline',
  });
  const firstTurn = importedTurns.find((turn) => turn.turnId === manifest.turns[0].turn_id);
  assert.ok(firstTurn);
  assert.match(firstTurn.prompt, /DATE: 1:56 pm on 8 May, 2023/);
  assert.match(firstTurn.prompt, /Caroline said:/);
  assert.match(firstTurn.response, /DATE: 1:56 pm on 8 May, 2023/);
  assert.match(firstTurn.response, /Melanie said:/);
  assert.doesNotMatch(firstTurn.prompt, /Recorded/);
  assert.doesNotMatch(firstTurn.response, /import placeholder/);
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

  const supportHit = recalled.hits.find((hit) => hit.evidence_ids.includes('D1:1'));
  assert.ok(supportHit);
  assert.equal('date_time' in supportHit, false);
  assert.equal('title' in supportHit, false);
  assert.equal('summary' in supportHit, false);
  assert.equal(typeof supportHit.matched_text, 'string');
  assert.ok(supportHit.matched_text.trim());
  assert.match(supportHit.detail, /^EXTRACTION: /);
  assert.match(supportHit.detail, new RegExp(escapeRegExp(supportHit.matched_text)));
  assert.doesNotMatch(supportHit.matched_text, /Recorded/);
  assert.equal(supportHit.extractionRatio ?? null, null);
  assert.ok(supportHit.references.some((reference) => /Caroline said:/.test(reference.text)));
  assert.ok(!('source_id' in recalled.hits[0]));

  const gatewayTracePath = path.join(home, 'locomo-gateway-trace.jsonl');
  if (await exists(gatewayTracePath)) {
    const gatewayTrace = await readFile(gatewayTracePath, 'utf8');
    const firstTrace = JSON.parse(gatewayTrace.trim().split('\n')[0]);
    assert.ok(Array.isArray(firstTrace.workItems));
    assert.equal('routingReason' in firstTrace.workItems[0], true);
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('recursive evidence resolution can walk session snapshot lineage back to turn ids', async () => {
  const bridgeModule = await import(bridgePath);
  const evidenceIds = bridgeModule.resolveEvidenceIdsFromGraph(
    'session:9',
    [
      {
        turn_id: 'turn:101',
        source_id: 'D1:1',
        sample_id: 'sample-a',
        session_id: 'locomo:sample-a:session_1',
        date_time: '1:56 pm on 8 May, 2023',
        import_order: 0,
      },
      {
        turn_id: 'turn:102',
        source_id: 'D2:1',
        sample_id: 'sample-a',
        session_id: 'locomo:sample-a:session_2',
        date_time: '1:14 pm on 25 May, 2023',
        import_order: 1,
      },
    ],
    {
      'session:9': ['session:7', 'turn:102'],
      'session:7': ['turn:101'],
    },
  );

  assert.deepEqual(evidenceIds, ['D1:1', 'D2:1']);
});

test('recursive evidence resolution can walk extraction lineage back to turn ids', async () => {
  const bridgeModule = await import(bridgePath);
  const evidenceIds = bridgeModule.resolveEvidenceIdsFromGraph(
    'extraction:memory-1',
    [
      {
        turn_id: 'session:101',
        source_id: 'D1:1',
        sample_id: 'sample-a',
        session_id: 'locomo:sample-a:session_1',
        date_time: '1:56 pm on 8 May, 2023',
        import_order: 0,
      },
    ],
    {
      'extraction:memory-1': ['session:101'],
    },
  );

  assert.deepEqual(evidenceIds, ['D1:1']);
});

test('recursive evidence resolution can walk observation lineage through extraction ids', async () => {
  const bridgeModule = await import(bridgePath);
  const evidenceIds = bridgeModule.resolveEvidenceIdsFromGraph(
    'observation:curated-1',
    [
      {
        turn_id: 'session:101',
        source_id: 'D2:8',
        sample_id: 'sample-a',
        session_id: 'locomo:sample-a:session_2',
        date_time: '1:14 pm on 25 May, 2023',
        import_order: 0,
      },
    ],
    {
      'observation:curated-1': ['extraction:raw-1'],
      'extraction:raw-1': ['session:101'],
    },
  );

  assert.deepEqual(evidenceIds, ['D2:8']);
});

test('withTransientRetry retries transient provider failures', async () => {
  const bridgeModule = await import(bridgePath);
  let attempts = 0;
  const result = await bridgeModule.withTransientRetry(
    async () => {
      attempts += 1;
      if (attempts < 2) {
        throw new Error('semanticIndex embedding request failed with status 503');
      }
      return 'ok';
    },
    { attempts: 3, delayMs: 0, label: 'test' },
  );

  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
});

test('withTransientRetry does not retry non-transient failures', async () => {
  const bridgeModule = await import(bridgePath);
  let attempts = 0;
  await assert.rejects(
    () => bridgeModule.withTransientRetry(
      async () => {
        attempts += 1;
        throw new Error('invalid query payload');
      },
      { attempts: 3, delayMs: 0, label: 'test' },
    ),
    /invalid query payload/,
  );

  assert.equal(attempts, 1);
});

test('waitForImportWatermark times out with pending turn ids when observer does not flush in time', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'muninn-locomo-watermark-timeout-'));
  t.after(async () => rm(home, { recursive: true, force: true }));
  t.after(async () => core.shutdownCoreForTests());
  t.after(() => {
    delete process.env.MUNINN_OBSERVER_POLL_MS;
  });

  await prepareSourceConfig(t, {
    observerProvider: 'openai',
    semanticIndexProvider: 'mock',
  });
  await runBridge('reset-home', { 'muninn-home': home });
  process.env.MUNINN_OBSERVER_POLL_MS = '60000';
  await runBridge('import-sample', {
    'data-file': fixturePath,
    'sample-id': 'sample-a',
    'muninn-home': home,
  });

  process.env.MUNINN_HOME = home;
  const bridgeModule = await import(bridgePath);
  const manifest = JSON.parse(await readFile(path.join(home, 'locomo-manifest.json'), 'utf8'));

  await assert.rejects(
    () => bridgeModule.waitForImportWatermark(manifest, {
      pollMs: 10,
      timeoutMs: 50,
    }),
    /memory watermark timeout.*pending turn ids/i,
  );
});

test('import only fails fast when extraction config is missing', async (t) => {
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
    /LoCoMo benchmark requires extraction\.embedding(?:\.provider)?/i,
  );
});

test('waitForImportWatermark emits a delayed unresolved-watermark warning', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'muninn-locomo-warning-'));
  t.after(async () => rm(home, { recursive: true, force: true }));
  t.after(async () => core.shutdownCoreForTests());
  t.after(() => {
    delete process.env.MUNINN_OBSERVER_POLL_MS;
  });

  await prepareSourceConfig(t, {
    observerProvider: 'openai',
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
      /memory watermark timeout.*pending turn ids/i,
    );
  } finally {
    console.error = originalError;
  }

  assert.ok(messages.some((message) => /no memory progress detected/i.test(message)));
});

test('waitForImportWatermark reads timeout and warning defaults from env', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'muninn-locomo-env-timeout-'));
  t.after(async () => rm(home, { recursive: true, force: true }));
  t.after(async () => core.shutdownCoreForTests());
  t.after(() => {
    delete process.env.MUNINN_LOCOMO_WATERMARK_TIMEOUT_MS;
    delete process.env.MUNINN_LOCOMO_WATERMARK_WARNING_DELAY_MS;
    delete process.env.MUNINN_OBSERVER_POLL_MS;
  });

  await prepareSourceConfig(t, {
    observerProvider: 'openai',
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
  process.env.MUNINN_LOCOMO_WATERMARK_TIMEOUT_MS = '50';
  process.env.MUNINN_LOCOMO_WATERMARK_WARNING_DELAY_MS = '0';
  const bridgeModule = await import(`${bridgePath}?env-timeout=${Date.now()}`);
  const manifest = JSON.parse(await readFile(path.join(home, 'locomo-manifest.json'), 'utf8'));

  await assert.rejects(
    () => bridgeModule.waitForImportWatermark(manifest, { pollMs: 10 }),
    /memory watermark timeout.*pending turn ids/i,
  );
});

test('waitForImportWatermark default timeout is thirty minutes', async () => {
  const bridgeModule = await import(`${bridgePath}?default-timeout=${Date.now()}`);

  assert.equal(bridgeModule.__testing.WATERMARK_TIMEOUT_MS, 30 * 60 * 1000);
});

test('waitForImportWatermark does not depend on repo-root cwd to load sidecar app', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'muninn-locomo-cwd-'));
  const originalCwd = process.cwd();
  t.after(async () => rm(home, { recursive: true, force: true }));
  t.after(async () => core.shutdownCoreForTests());
  t.after(() => {
    process.chdir(originalCwd);
    delete process.env.MUNINN_OBSERVER_POLL_MS;
  });

  await prepareSourceConfig(t, {
    observerProvider: 'openai',
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
  process.chdir(path.join(repoRoot, 'benchmark/locomo'));
  const bridgeModule = await import(bridgePath);
  const manifest = JSON.parse(await readFile(path.join(home, 'locomo-manifest.json'), 'utf8'));

  await assert.rejects(
    () => bridgeModule.waitForImportWatermark(manifest, {
      pollMs: 10,
      timeoutMs: 50,
    }),
    /memory watermark timeout.*pending turn ids/i,
  );
});
