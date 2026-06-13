import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function loadChatTimeline() {
  const source = await readFile(new URL('../src/lib/chat_timeline.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

test('splits imported summary fallback into user and agent messages', async () => {
  const { entriesFromFallback } = await loadChatTimeline();
  const entries = entriesFromFallback({
    memoryId: 'turn:338',
    agent: 'codex',
    createdAt: '2026-06-02T13:21:08.176Z',
    updatedAt: '2026-06-02T13:22:09.108Z',
    title: '改下看看',
    summary: [
      '改下看看，另外切到 Json 下的 tip 就不要了',
      '',
      '我把选中 tab 改成浅蓝底深蓝字。',
      '',
      '我现在改两处：提示渲染条件、tab active 颜色。',
    ].join('\n'),
  });

  assert.deepEqual(entries.slice(0, 2).map((entry) => ({
    type: entry.type,
    role: entry.message?.role,
    body: entry.message?.body,
  })), [
    {
      type: 'message',
      role: 'user',
      body: '改下看看，另外切到 Json 下的 tip 就不要了',
    },
    {
      type: 'message',
      role: 'agent',
      body: '我把选中 tab 改成浅蓝底深蓝字。\n\n我现在改两处：提示渲染条件、tab active 颜色。',
    },
  ]);
});
