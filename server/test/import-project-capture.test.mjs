import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import core from '../dist/backend.js';
import { app } from '../dist/http.js';
import { getCapturePolicy, isCaptureEnabled, setAgentCaptureEnabled } from '../dist/api/capture.js';

const { shutdownCoreForTests } = core;
const PROJECT = 'github.com/muninn/import-default-off';

async function writeTestConfig(home) {
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, 'muninn.json'), JSON.stringify({
    extractor: {
      name: 'default',
      llmProvider: 'mock',
      embeddingProvider: 'mock',
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
  }, null, 2));
}

test('project import registers project with capture disabled by default', async (t) => {
  const previousHome = process.env.MUNINN_HOME;
  const home = await mkdtemp(path.join(os.tmpdir(), 'muninn-import-project-capture-'));
  process.env.MUNINN_HOME = home;
  await writeTestConfig(home);
  t.after(async () => {
    await shutdownCoreForTests();
    if (previousHome === undefined) {
      delete process.env.MUNINN_HOME;
    } else {
      process.env.MUNINN_HOME = previousHome;
    }
  });

  await setAgentCaptureEnabled('codex', true);

  const importResponse = await app.request('/app/api/import/codex/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projects: [PROJECT] }),
  });
  assert.equal(importResponse.status, 200);

  const policy = await getCapturePolicy('codex');
  assert.equal(policy[PROJECT], false);
  assert.equal(await isCaptureEnabled('codex', PROJECT), false);

  const listResponse = await app.request('/app/api/import/projects');
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  const project = list.projects.find((entry) => entry.project === PROJECT);
  assert.ok(project);
  assert.equal(project.sessionCount, 0);
  assert.equal(project.importedCount, 0);
  assert.equal(project.agents[0]?.agent, 'codex');
  assert.equal(project.agents[0]?.captureEnabled, false);
});
