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

test('pipeline summary separates state counts from usage metrics', async () => {
  const source = await readFile(new URL('../src/components/PipelinesPage.tsx', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /<h2>State<\/h2>/);
  assert.doesNotMatch(source, /<h2>Usage<\/h2>/);
  assert.match(source, /<PipelineSummary tasks=\{visibleTasks\} \/>/);
  assert.match(source, /<PipelineStatusStrip tasks=\{visibleTasks\} \/>/);
  assert.equal(source.indexOf('running ${metrics.running}') < source.indexOf('done ${metrics.done}'), true);
  assert.equal(source.indexOf('done ${metrics.done}') < source.indexOf('queued ${metrics.queued}'), true);
  assert.equal(source.indexOf('queued ${metrics.queued}') < source.indexOf('failed ${metrics.failed}'), true);
  assert.match(source, /\{label\} Data/);
  assert.match(source, /\{label\} Tokens/);
  assert.match(source, /pipeline-summary-usage-metric/);
  assert.match(source, /pipeline-summary-usage-label/);
  assert.match(source, /pipeline-summary-usage-value/);
  assert.doesNotMatch(source, /pipeline-summary-usage-separator/);
  assert.doesNotMatch(source, /pipeline-summary-usage-byte/);
  assert.doesNotMatch(source, /pipeline-summary-usage-token/);
  assert.match(styles, /grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1px\) minmax\(0, 1fr\)/);
  assert.match(styles, /row-gap: 13px/);
  assert.match(styles, /height: 1px/);
  assert.match(styles, /\.pipeline-status-strip/);
  assert.match(styles, /display: inline-flex/);
  assert.match(styles, /justify-items: center/);
  assert.match(styles, /justify-content: center/);
  assert.match(styles, /background: #ffffff/);
  assert.match(styles, /background: #fbfcfd/);
  assert.match(styles, /padding: 16px 18px 17px/);
  assert.match(styles, /\.pipeline-summary-divider/);
});

test('pipeline header uses explicit updated time', async () => {
  const source = await readFile(new URL('../src/components/PipelinesPage.tsx', import.meta.url), 'utf8');

  assert.match(source, /Updated at \{formatTime\(updatedAt\)\}/);
  assert.match(source, /function formatTime/);
  assert.doesNotMatch(source, /relativeTime/);
});

test('pipeline task titles use product labels and project session context', async () => {
  const source = await readFile(new URL('../src/components/PipelinesPage.tsx', import.meta.url), 'utf8');
  const demo = await readFile(new URL('../src/demo/data.ts', import.meta.url), 'utf8');

  assert.match(source, /return 'Extraction'/);
  assert.match(source, /return 'Observation'/);
  assert.match(source, /return 'Dreaming'/);
  assert.match(demo, /Project: muninn Session:/);
  assert.match(demo, /Project: app-mvp Session:/);
  assert.doesNotMatch(demo, /Project: .*· Session:/);
});

test('pipeline task cards only open inspector from inspect button', async () => {
  const source = await readFile(new URL('../src/components/PipelinesPage.tsx', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  const start = source.indexOf('function PipelineCard');
  const end = source.indexOf('function PipelineLifecycleLine', start);
  const component = source.slice(start, end);
  const lifecycleStart = source.indexOf('function PipelineLifecycleLine');
  const lifecycleEnd = source.indexOf('function PipelineMetricBox', lifecycleStart);
  const lifecycleComponent = source.slice(lifecycleStart, lifecycleEnd);
  const cardStyleStart = styles.indexOf('.pipeline-card {');
  const cardStyleEnd = styles.indexOf('.pipeline-card:hover', cardStyleStart);
  const cardStyles = styles.slice(cardStyleStart, cardStyleEnd);

  assert.doesNotMatch(component, /role="button"/);
  assert.doesNotMatch(component, /tabIndex=\{0\}/);
  assert.doesNotMatch(component, /<article[^>]*onClick/);
  assert.match(component, /className="pipeline-inspect-button"[\s\S]*onClick=\{onInspect\}/);
  assert.doesNotMatch(component, /task\.statusText/);
  assert.doesNotMatch(source, /pipeline-status-line/);
  assert.doesNotMatch(source, /function capitalizeSentence/);
  assert.match(lifecycleComponent, /Created at \{formatCreatedTime\(createdAt\)\}/);
  assert.match(lifecycleComponent, /Duration \{durationForTask\(task\)\}/);
  assert.doesNotMatch(lifecycleComponent, /, Duration:/);
  assert.doesNotMatch(lifecycleComponent, /Duration:/);
  assert.doesNotMatch(lifecycleComponent, /Tool calls: \{toolCallItems/);
  assert.doesNotMatch(cardStyles, /cursor: pointer/);
  assert.match(source, /selected=\{inspectedTaskId === task\.id\}/);
  assert.doesNotMatch(source, /fallbackTaskId/);
  assert.match(styles, /grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/);
  assert.match(styles, /\.pipeline-metric-value:has\(span \+ span\)::before/);
  assert.match(styles, /left: 50%/);
  assert.match(styles, /white-space: nowrap/);
});
