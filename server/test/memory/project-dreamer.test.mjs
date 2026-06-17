import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { buildProjectDreamPrompt, mergeProjectDream } from '../../dist/dreaming/project-dreamer.js';

test('buildProjectDreamPrompt omits session ids and includes parent plus incremental signals', () => {
  const prompt = buildProjectDreamPrompt({
    project: '/repo/muninn',
    parentDream: '# Project Dream\n\n## Signals\n\n### Guidance\n- [2] Keep schemas minimal.\n\n### Skills\n\n### Open Questions',
    incrementalSignals: '- [1] Keep schemas small.',
  });
  assert.match(prompt, /## Parent Dream/);
  assert.match(prompt, /Keep schemas minimal/);
  assert.match(prompt, /## Incremental Signals/);
  assert.match(prompt, /Keep schemas small/);
  assert.doesNotMatch(prompt, /session:<rowid>/);
  assert.doesNotMatch(prompt, /### session:/);
});

test('mergeProjectDream validates and retries LLM Markdown output', async (t) => {
  await withTempMuninnHome(t, {
    providers: {
      llm: { dreamer: { type: 'openai', apiKey: 'test-key' } },
      embedding: { mock: { type: 'mock', dimensions: 8 } },
    },
  });
  const prompts = [];
  const result = await mergeProjectDream({
    project: '/repo/muninn',
    parentDream: '(none)',
    incrementalSignals: '- [1] Keep schemas minimal.',
    model: async (request) => {
      prompts.push(request.prompt);
      return prompts.length === 1
        ? '# Not A Project Dream'
        : '# Project Dream\n\n## Signals\n\n### Guidance\n- [1] Keep schemas minimal.\n\n### Skills\n\n### Open Questions';
    },
  });
  assert.match(result, /# Project Dream/);
  assert.match(result, /Keep schemas minimal/);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Previous output was invalid\. Validation error: project dream content must start with # Project Dream/);
});

async function withTempMuninnHome(t, overrides = {}) {
  const previousHome = process.env.MUNINN_HOME;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'muninn-project-dreamer-'));
  const homeDir = path.join(dir, 'muninn');
  await mkdir(homeDir, { recursive: true });
  await writeFile(path.join(homeDir, 'muninn.json'), JSON.stringify(config(overrides), null, 2));
  process.env.MUNINN_HOME = homeDir;
  t.after(async () => {
    if (previousHome === undefined) {
      delete process.env.MUNINN_HOME;
    } else {
      process.env.MUNINN_HOME = previousHome;
    }
    await rm(dir, { recursive: true, force: true });
  });
}

function config(overrides = {}) {
  return {
    extractor: {
      name: 'extractor',
      llmProvider: 'dreamer',
      embeddingProvider: 'mock',
      maxAttempts: 2,
    },
    observer: {
      enabled: false,
    },
    providers: {
      llm: { dreamer: { type: 'openai', apiKey: 'test-key' } },
      embedding: { mock: { type: 'mock', dimensions: 8 } },
    },
    ...overrides,
  };
}
