import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import core from '../../../server/dist/memory/index.js';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, '../../..');
const bridgePath = path.join(repoRoot, 'benchmark/locomo/dist/bridge.js');
const fixturePath = path.join(repoRoot, 'benchmark/locomo/test/fixtures/mini-locomo.json');
let activeSidecarLogs = null;

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
  let stdout;
  try {
    ({ stdout } = await execFileAsync(process.execPath, args, {
      cwd: repoRoot,
      env: process.env,
    }));
  } catch (error) {
    if (activeSidecarLogs) {
      error.stderr = `${error.stderr ?? ''}\n[sidecar]\n${activeSidecarLogs.join('')}`;
    }
    throw error;
  }
  const envelope = JSON.parse(stdout);
  assert.equal(envelope.ok, true);
  return envelope.result;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port);
        } else {
          reject(new Error('failed to allocate port'));
        }
      });
    });
    server.on('error', reject);
  });
}

async function startSidecar(t, home) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const previousBaseUrl = process.env.MUNINN_SIDECAR_BASE_URL;
  process.env.MUNINN_SIDECAR_BASE_URL = baseUrl;
  const sidecar = spawn(process.execPath, [path.join(repoRoot, 'server/dist/index.js')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      MUNINN_HOME: home,
      MUNINN_OBSERVER_GATEWAY_TRACE_FILE: path.join(home, 'locomo-gateway-trace.jsonl'),
      MUNINN_THREAD_OBSERVING_TRACE_FILE: path.join(home, 'locomo-thread-observing-trace.jsonl'),
      MUNINN_OBSERVER_TRACE_FILE: path.join(home, 'locomo-observer-trace.jsonl'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  activeSidecarLogs = logs;
  sidecar.stdout.on('data', (chunk) => logs.push(String(chunk)));
  sidecar.stderr.on('data', (chunk) => logs.push(String(chunk)));
  t.after(async () => {
    if (previousBaseUrl === undefined) {
      delete process.env.MUNINN_SIDECAR_BASE_URL;
    } else {
      process.env.MUNINN_SIDECAR_BASE_URL = previousBaseUrl;
    }
    if (sidecar.exitCode === null) {
      sidecar.kill('SIGTERM');
      await new Promise((resolve) => sidecar.once('exit', resolve));
    }
    activeSidecarLogs = null;
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (sidecar.exitCode !== null) {
      throw new Error(`sidecar exited before health check: ${logs.join('')}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return baseUrl;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`sidecar health check timed out: ${logs.join('')}`);
}

async function mockWatermarkSidecar(t, responses) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const previousBaseUrl = process.env.MUNINN_SIDECAR_BASE_URL;
  process.env.MUNINN_SIDECAR_BASE_URL = baseUrl;
  const calls = [];
  const server = http.createServer(async (request, response) => {
    calls.push({ url: `${baseUrl}${request.url}`, method: request.method ?? 'GET' });
    const next = responses.shift() ?? {
      pending: { turns: ['turn:1'], extractions: [] },
      phases: { extractor: 'pending', observer: 'idle' },
    };
    if (next.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, next.delayMs));
    }
    const payload = next.payload ?? next;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', resolve);
    server.on('error', reject);
  });
  t.after(() => {
    if (previousBaseUrl === undefined) {
      delete process.env.MUNINN_SIDECAR_BASE_URL;
    } else {
      process.env.MUNINN_SIDECAR_BASE_URL = previousBaseUrl;
    }
    server.close();
  });
  return calls;
}

function watermarkManifest() {
  return {
    sample_id: 'sample-a',
    turns: [{
      turn_id: 'turn:1',
      source_id: 'D1:1',
      sample_id: 'sample-a',
      session_id: 'locomo:sample-a:session_1',
      date_time: '1:56 pm on 8 May, 2023',
      import_order: 0,
    }],
  };
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
      llmProvider: 'test_observer_llm',
    };
    root.extractor = {
      name: 'test-extractor',
      llmProvider: 'test_observer_llm',
      embeddingProvider: 'test_embedding',
    };
    root.providers = {
      ...(root.providers ?? {}),
      llm: {
        test_observer_llm: { type: observerProvider },
      },
    };
  }
  if (semanticIndexProvider) {
    root.extractor = {
      ...(root.extractor ?? {
        name: 'test-extractor',
        llmProvider: 'test_observer_llm',
      }),
      embeddingProvider: 'test_embedding',
    };
    root.providers = {
      ...(root.providers ?? {}),
      embedding: {
        test_embedding: {
          type: semanticIndexProvider,
          dimensions: 4,
        },
      },
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
  await startSidecar(t, home);
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
  assert.equal(copiedConfig.observer.llmProvider, 'test_observer_llm');
  assert.equal(copiedConfig.storage, undefined);

  process.env.MUNINN_HOME = home;
  const importedTurns = await core.turns.list({
    mode: { type: 'recency', limit: 10 },
    sessionId: 'locomo:sample-a:session_1',
    agent: 'Caroline',
    database: 'sample-a',
  });
  const firstTurn = importedTurns.find((turn) => turn.turnId === manifest.turns[0].turn_id);
  assert.ok(firstTurn);
  assert.match(firstTurn.prompt, /DATE: 1:56 pm on 8 May, 2023/);
  assert.match(firstTurn.prompt, /Caroline said:/);
  assert.match(firstTurn.response, /DATE: 1:56 pm on 8 May, 2023/);
  assert.match(firstTurn.response, /Melanie said:/);
  assert.deepEqual(firstTurn.events.map((event) => event.type), ['userMessage', 'assistantMessage']);
  assert.doesNotMatch(firstTurn.prompt, /Recorded/);
  assert.doesNotMatch(firstTurn.response, /import placeholder/);
});

test('recall returns body-only hits without leaking benchmark artifacts into muninn rows', async (t) => {
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
  await startSidecar(t, home);
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

  const supportHit = recalled.hits.find((hit) => /support group/i.test(hit.detail ?? hit.matched_text ?? ''));
  assert.ok(supportHit);
  assert.equal('date_time' in supportHit, false);
  assert.equal('title' in supportHit, false);
  assert.equal('summary' in supportHit, false);
  assert.equal('evidence_ids' in supportHit, false);
  assert.equal('references' in supportHit, false);
  assert.equal(typeof supportHit.matched_text, 'string');
  assert.ok(supportHit.matched_text.trim());
  assert.match(supportHit.detail, /^(EXTRACTION|OBSERVATION): /);
  assert.match(supportHit.detail, new RegExp(escapeRegExp(supportHit.matched_text)));
  assert.doesNotMatch(supportHit.matched_text, /Recorded/);
  assert.equal(supportHit.observationRatio ?? null, null);
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

test('bridge emits JSON error envelope for command failures', async () => {
  await assert.rejects(
    async () => {
      await execFileAsync(process.execPath, [bridgePath, 'unknown-command'], {
        cwd: repoRoot,
        env: process.env,
      });
    },
    (error) => {
      const envelope = JSON.parse(error.stdout);
      assert.equal(envelope.ok, false);
      assert.match(envelope.error.message, /unknown command: unknown-command/);
      assert.match(envelope.error.stack, /unknown command: unknown-command/);
      return true;
    },
  );
});

test('waitForImportWatermark times out with pending turn ids when observer does not flush in time', async (t) => {
  await mockWatermarkSidecar(t, [
    { pending: { turns: ['turn:1'], extractions: [] }, phases: { extractor: 'pending', observer: 'idle' } },
  ]);
  const bridgeModule = await import(bridgePath);

  await assert.rejects(
    () => bridgeModule.waitForImportWatermark(watermarkManifest(), {
      pollMs: 10,
      timeoutMs: 50,
    }),
    /memory watermark timeout.*pending/i,
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
    /LoCoMo benchmark requires providers\.(?:llm|embedding)\./i,
  );
});

test('waitForImportWatermark emits a delayed unresolved-watermark warning', async (t) => {
  await mockWatermarkSidecar(t, [
    { pending: { turns: ['turn:1'], extractions: [] }, phases: { extractor: 'pending', observer: 'idle' } },
  ]);
  const bridgeModule = await import(bridgePath);
  const originalError = console.error;
  const messages = [];
  console.error = (...args) => {
    messages.push(args.join(' '));
  };

  try {
    await assert.rejects(
      () => bridgeModule.waitForImportWatermark(watermarkManifest(), {
        pollMs: 10,
        timeoutMs: 60,
        warningDelayMs: 0,
      }),
      /memory watermark timeout.*pending/i,
    );
  } finally {
    console.error = originalError;
  }

  assert.ok(messages.some((message) => /no memory progress detected/i.test(message)));
});

test('waitForImportWatermark returns after async finalize resolves immediately', async (t) => {
  await mockWatermarkSidecar(t, [
    { delayMs: 30, payload: { pending: { turns: [], extractions: [] }, phases: { extractor: 'idle', observer: 'idle' } } },
  ]);
  const bridgeModule = await import(`${bridgePath}?finalize-progress=${Date.now()}`);
  const originalError = console.error;
  const messages = [];
  console.error = (...args) => {
    messages.push(args.join(' '));
  };

  try {
    await bridgeModule.waitForImportWatermark(watermarkManifest(), {
      pollMs: 5,
      timeoutMs: 200,
    });
  } finally {
    console.error = originalError;
  }

  assert.ok(messages.some((message) => /finalized memory/i.test(message)));
});

test('waitForImportWatermark reads timeout and warning defaults from env', async (t) => {
  await mockWatermarkSidecar(t, [
    { pending: { turns: ['turn:1'], extractions: [] }, phases: { extractor: 'pending', observer: 'idle' } },
  ]);
  t.after(() => {
    delete process.env.MUNINN_LOCOMO_WATERMARK_TIMEOUT_MS;
    delete process.env.MUNINN_LOCOMO_WATERMARK_WARNING_DELAY_MS;
  });
  process.env.MUNINN_LOCOMO_WATERMARK_TIMEOUT_MS = '50';
  process.env.MUNINN_LOCOMO_WATERMARK_WARNING_DELAY_MS = '0';
  const bridgeModule = await import(`${bridgePath}?env-timeout=${Date.now()}`);

  await assert.rejects(
    () => bridgeModule.waitForImportWatermark(watermarkManifest(), { pollMs: 10 }),
    /memory watermark timeout.*pending/i,
  );
});

test('waitForImportWatermark default timeout is thirty minutes', async () => {
  const bridgeModule = await import(`${bridgePath}?default-timeout=${Date.now()}`);

  assert.equal(bridgeModule.__testing.WATERMARK_TIMEOUT_MS, 30 * 60 * 1000);
});

test('waitForImportWatermark calls the configured persistent sidecar', async (t) => {
  const calls = await mockWatermarkSidecar(t, [{
    pending: { turns: [], extractions: [] },
    phases: { extractor: 'idle', observer: 'idle' },
  }]);

  const bridgeModule = await import(`${bridgePath}?persistent-sidecar=${Date.now()}`);
  await bridgeModule.waitForImportWatermark({
    sample_id: 'sample-a',
    turns: [{
      turn_id: 'turn:1',
      source_id: 'D1:1',
      sample_id: 'sample-a',
      session_id: 'locomo:sample-a:session_1',
      date_time: '1:56 pm on 8 May, 2023',
      import_order: 0,
    }],
  });

  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, '/api/v1/memory/finalize');
  assert.equal(calls[0].method, 'POST');
});

test('waitForImportWatermark does not depend on repo-root cwd', async (t) => {
  const originalCwd = process.cwd();
  t.after(() => {
    process.chdir(originalCwd);
  });
  await mockWatermarkSidecar(t, [
    { pending: { turns: ['turn:1'], extractions: [] }, phases: { extractor: 'pending', observer: 'idle' } },
  ]);
  process.chdir(path.join(repoRoot, 'benchmark/locomo'));
  const bridgeModule = await import(bridgePath);

  await assert.rejects(
    () => bridgeModule.waitForImportWatermark(watermarkManifest(), {
      pollMs: 10,
      timeoutMs: 50,
    }),
    /memory watermark timeout.*pending/i,
  );
});
