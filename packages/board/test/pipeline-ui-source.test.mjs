import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('pipelines page uses demo tasks without global demo mode', async () => {
  const source = await readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  const start = source.indexOf('getPipelineTasks() {');
  const end = source.indexOf('saveSettingsConfig', start);
  const method = source.slice(start, end);

  assert.match(method, /return getDemoPipelineTasks\(\)/);
  assert.doesNotMatch(method, /usesDemoData/);
  assert.doesNotMatch(method, /fetchJson<PipelineTasksResponse>\('\/api\/v1\/ui\/pipelines'\)/);
});

test('pipeline summary removes headings and stacks usage values', async () => {
  const source = await readFile(new URL('../src/components/PipelinesPage.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /<h2>State<\/h2>/);
  assert.doesNotMatch(source, /<h2>Usage<\/h2>/);
  assert.match(source, /pipeline-summary-usage-values/);
  assert.match(source, /pipeline-summary-usage-byte/);
  assert.match(source, /pipeline-summary-usage-token/);
});
