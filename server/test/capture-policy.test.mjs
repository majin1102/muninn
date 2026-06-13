import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  getCapturePolicy,
  isAgentCaptureEnabled,
  isCaptureEnabled,
  removeCapturePolicy,
  setAgentCaptureEnabled,
  setCaptureEnabled,
} from '../dist/web/capture_policy.js';

function baseConfig() {
  return {
    extractor: {
      name: 'default-extractor',
      llmProvider: 'default',
      embeddingProvider: 'default',
      recallMode: 'hybrid',
    },
    observer: {
      name: 'default-observer',
      llmProvider: 'default',
    },
    providers: {
      llm: {
        default: {
          type: 'mock',
        },
      },
      embedding: {
        default: {
          type: 'mock',
          dimensions: 8,
        },
      },
    },
  };
}

test('capture policy is stored in muninn.json and ignores legacy policy files', async (t) => {
  const previousHome = process.env.MUNINN_HOME;
  const home = await mkdtemp(path.join(os.tmpdir(), 'muninn-capture-policy-'));
  process.env.MUNINN_HOME = home;
  t.after(() => {
    if (previousHome === undefined) {
      delete process.env.MUNINN_HOME;
    } else {
      process.env.MUNINN_HOME = previousHome;
    }
  });

  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, 'muninn.json'), `${JSON.stringify(baseConfig(), null, 2)}\n`);
  await writeFile(path.join(home, 'capture-policy.json'), JSON.stringify({
    codex: {
      'github.com/legacy/repo': true,
    },
  }));

  assert.equal(await isCaptureEnabled('codex', 'github.com/legacy/repo'), false);
  assert.equal(await isAgentCaptureEnabled('codex'), true);
  await setAgentCaptureEnabled('codex', false);
  assert.equal(await isAgentCaptureEnabled('codex'), false);
  await setCaptureEnabled('codex', 'github.com/lance-format/lance', true);
  assert.equal(await isCaptureEnabled('codex', 'github.com/lance-format/lance'), false);
  await setAgentCaptureEnabled('codex', true);
  assert.equal(await isCaptureEnabled('codex', 'github.com/lance-format/lance'), true);
  assert.deepEqual(await getCapturePolicy('codex'), {
    'github.com/lance-format/lance': true,
  });

  const stored = JSON.parse(await readFile(path.join(home, 'muninn.json'), 'utf8'));
  assert.deepEqual(stored.capture.projects.codex, {
    'github.com/lance-format/lance': true,
  });

  await assert.rejects(
    () => setCaptureEnabled('codex', 'amoro', true),
    /project must be a canonical project identity/,
  );

  await removeCapturePolicy('codex', 'github.com/lance-format/lance');
  assert.equal(await isCaptureEnabled('codex', 'github.com/lance-format/lance'), false);
});
