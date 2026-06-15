import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function loadPipelineModel() {
  const source = await readFile(new URL('../src/lib/pipeline-model.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

function task(patch) {
  return {
    id: patch.id,
    kind: patch.kind ?? 'observation',
    title: patch.title ?? 'Observation',
    target: patch.target ?? 'Entity: Memory',
    status: patch.status,
    statusText: patch.statusText ?? 'processing memory work',
    startedAt: patch.startedAt,
    endedAt: patch.endedAt,
    updatedAt: patch.updatedAt,
    input: patch.input ?? { bytes: 1024, tokens: 320 },
    output: patch.output,
    toolCalls: patch.toolCalls ?? [],
    inputDetails: patch.inputDetails ?? [],
    outputDetails: patch.outputDetails ?? [],
    trace: patch.trace ?? [],
    errors: patch.errors ?? [],
  };
}

test('summarizes pipeline task status counts and newest update', async () => {
  const { summarizePipelineTasks } = await loadPipelineModel();
  const summary = summarizePipelineTasks([
    task({ id: 'a', status: 'running', updatedAt: '2026-06-04T10:00:00.000Z' }),
    task({ id: 'b', status: 'queued', updatedAt: '2026-06-04T10:02:00.000Z' }),
    task({ id: 'c', status: 'queued', updatedAt: '2026-06-04T10:01:00.000Z' }),
    task({ id: 'd', status: 'failed', updatedAt: '2026-06-04T10:03:00.000Z' }),
    task({ id: 'e', status: 'done', updatedAt: '2026-06-04T09:00:00.000Z' }),
  ]);

  assert.deepEqual(summary, {
    running: 1,
    queued: 2,
    failed: 1,
    updatedAt: '2026-06-04T10:03:00.000Z',
  });
});

test('filters pipeline tasks by kind, status, and time', async () => {
  const { filterPipelineTasks } = await loadPipelineModel();
  const nowMs = new Date('2026-06-04T12:00:00.000Z').getTime();
  const tasks = [
    task({ id: 'running-observation', kind: 'observation', status: 'running', updatedAt: '2026-06-04T11:00:00.000Z' }),
    task({ id: 'queued-observation', kind: 'observation', status: 'queued', updatedAt: '2026-06-04T10:00:00.000Z' }),
    task({ id: 'done-observation', kind: 'observation', status: 'done', updatedAt: '2026-06-04T09:00:00.000Z' }),
    task({ id: 'old-session', kind: 'session-observing', status: 'running', updatedAt: '2026-06-02T09:00:00.000Z' }),
  ];

  assert.deepEqual(
    filterPipelineTasks(tasks, 'observation', 'active', 'last_24h', { from: null, to: null }, nowMs).map((item) => item.id),
    ['running-observation', 'queued-observation'],
  );
});

test('selects running task before failed, queued, and done tasks', async () => {
  const { defaultSelectedPipelineTaskId } = await loadPipelineModel();
  const tasks = [
    task({ id: 'done', status: 'done', updatedAt: '2026-06-04T12:00:00.000Z' }),
    task({ id: 'failed', status: 'failed', updatedAt: '2026-06-04T11:00:00.000Z' }),
    task({ id: 'running', status: 'running', updatedAt: '2026-06-04T10:00:00.000Z' }),
    task({ id: 'queued', status: 'queued', updatedAt: '2026-06-04T09:00:00.000Z' }),
  ];

  assert.equal(defaultSelectedPipelineTaskId(tasks), 'running');
});

test('shifts pipeline task times relative to the newest update', async () => {
  const { shiftPipelineTaskTimes } = await loadPipelineModel();
  const tasks = [
    task({
      id: 'older',
      status: 'done',
      startedAt: '2026-06-04T08:00:00.000Z',
      endedAt: '2026-06-04T08:10:00.000Z',
      updatedAt: '2026-06-04T08:10:00.000Z',
    }),
    task({
      id: 'latest',
      status: 'running',
      startedAt: '2026-06-04T08:20:00.000Z',
      updatedAt: '2026-06-04T08:40:00.000Z',
    }),
  ];

  const shifted = shiftPipelineTaskTimes(tasks, new Date('2026-06-05T08:40:00.000Z').getTime());

  assert.equal(shifted[0].startedAt, '2026-06-05T08:00:00.000Z');
  assert.equal(shifted[0].endedAt, '2026-06-05T08:10:00.000Z');
  assert.equal(shifted[0].updatedAt, '2026-06-05T08:10:00.000Z');
  assert.equal(shifted[1].startedAt, '2026-06-05T08:20:00.000Z');
  assert.equal(shifted[1].updatedAt, '2026-06-05T08:40:00.000Z');
});
