import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

test('right chat view opens around the selected turn and expands by direction', async () => {
  const source = await readFile(new URL('../src/lib/chat_window.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
  const { chatTurnWindow, INITIAL_CHAT_CONTEXT_RADIUS, CHAT_CONTEXT_STEP } = await import(moduleUrl);
  const turns = Array.from({ length: 121 }, (_, index) => ({
    memoryId: `turn:${index + 1}`,
  }));

  const initial = chatTurnWindow(turns, 'turn:61');
  assert.deepEqual(initial.turns.map((turn) => turn.memoryId), turns.slice(40, 81).map((turn) => turn.memoryId));
  assert.equal(initial.beforeCount, 40);
  assert.equal(initial.afterCount, 40);

  const expandedBefore = chatTurnWindow(
    turns,
    'turn:61',
    INITIAL_CHAT_CONTEXT_RADIUS + CHAT_CONTEXT_STEP,
    INITIAL_CHAT_CONTEXT_RADIUS,
  );
  assert.deepEqual(expandedBefore.turns.map((turn) => turn.memoryId), turns.slice(0, 81).map((turn) => turn.memoryId));
  assert.equal(expandedBefore.beforeCount, 0);
  assert.equal(expandedBefore.afterCount, 40);

  const expandedAfter = chatTurnWindow(
    turns,
    'turn:61',
    INITIAL_CHAT_CONTEXT_RADIUS,
    INITIAL_CHAT_CONTEXT_RADIUS + CHAT_CONTEXT_STEP,
  );
  assert.deepEqual(expandedAfter.turns.map((turn) => turn.memoryId), turns.slice(40, 121).map((turn) => turn.memoryId));
  assert.equal(expandedAfter.beforeCount, 40);
  assert.equal(expandedAfter.afterCount, 0);
});
