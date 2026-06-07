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
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /<h2>State<\/h2>/);
  assert.doesNotMatch(source, /<h2>Usage<\/h2>/);
  assert.equal(source.indexOf('Running ${metrics.running}') < source.indexOf('Done ${metrics.done}'), true);
  assert.equal(source.indexOf('Done ${metrics.done}') < source.indexOf('Queued ${metrics.queued}'), true);
  assert.equal(source.indexOf('Queued ${metrics.queued}') < source.indexOf('Failed ${metrics.failed}'), true);
  assert.match(source, /\{label\} data/);
  assert.match(source, /\{label\} tokens/);
  assert.match(source, /pipeline-summary-usage-label/);
  assert.match(source, /pipeline-summary-usage-value/);
  assert.doesNotMatch(source, /pipeline-summary-usage-byte/);
  assert.doesNotMatch(source, /pipeline-summary-usage-token/);
  assert.match(styles, /grid-template-columns: minmax\(250px, 0\.9fr\) minmax\(0, 1px\) minmax\(260px, 1fr\) minmax\(0, 1px\) minmax\(260px, 1fr\)/);
  assert.match(styles, /padding: 22px 36px 22px 18px/);
  assert.match(styles, /padding: 16px 18px 17px/);
  assert.match(styles, /\.pipeline-summary-divider/);
});

test('pipeline header uses explicit updated time', async () => {
  const source = await readFile(new URL('../src/components/PipelinesPage.tsx', import.meta.url), 'utf8');

  assert.match(source, /Updated at \{formatTime\(updatedAt\)\}/);
  assert.match(source, /function formatTime/);
  assert.doesNotMatch(source, /relativeTime/);
});

test('pipeline task cards only open inspector from inspect button', async () => {
  const source = await readFile(new URL('../src/components/PipelinesPage.tsx', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  const start = source.indexOf('function PipelineCard');
  const end = source.indexOf('function PipelineLifecycleLine', start);
  const component = source.slice(start, end);
  const cardStyleStart = styles.indexOf('.pipeline-card {');
  const cardStyleEnd = styles.indexOf('.pipeline-card:hover', cardStyleStart);
  const cardStyles = styles.slice(cardStyleStart, cardStyleEnd);

  assert.doesNotMatch(component, /role="button"/);
  assert.doesNotMatch(component, /tabIndex=\{0\}/);
  assert.doesNotMatch(component, /<article[^>]*onClick/);
  assert.match(component, /className="pipeline-inspect-button"[\s\S]*onClick=\{onInspect\}/);
  assert.doesNotMatch(cardStyles, /cursor: pointer/);
  assert.match(source, /selected=\{inspectedTaskId === task\.id\}/);
  assert.doesNotMatch(source, /fallbackTaskId/);
});
