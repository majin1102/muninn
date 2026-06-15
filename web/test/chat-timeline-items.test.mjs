import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function loadTimelineItems() {
  const source = await readFile(new URL('../src/lib/chat-timeline-items.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

test('folds total time into the preceding timeline item', async () => {
  const { chatTimelineItems } = await loadTimelineItems();
  const items = chatTimelineItems([
    {
      type: 'message',
      message: {
        role: 'agent',
        label: 'Agent',
        body: 'Done',
        timestamp: '2026-06-02T10:00:05.000Z',
        startedAt: '2026-06-02T10:00:00.000Z',
        completedAt: '2026-06-02T10:00:05.000Z',
      },
    },
    {
      type: 'totalTime',
      totalTime: {
        memoryId: 'turn:1',
        startedAt: '2026-06-02T10:00:00.000Z',
        completedAt: '2026-06-02T10:00:41.000Z',
      },
    },
  ], 5 * 60 * 1000);

  assert.equal(items.length, 2);
  assert.equal(items[0].type, 'time');
  assert.equal(items[1].type, 'entry');
  assert.equal(items[1].entry.type, 'message');
  assert.deepEqual(items[1].totalTime, {
    memoryId: 'turn:1',
    startedAt: '2026-06-02T10:00:00.000Z',
    completedAt: '2026-06-02T10:00:41.000Z',
  });
});
