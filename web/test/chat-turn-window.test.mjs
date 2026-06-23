import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

test('right chat view opens around the selected turn and expands by direction', async () => {
  const source = await readFile(new URL('../src/lib/chat-window.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
  const {
    chatTurnWindow,
    DEFAULT_CHAT_INITIAL_TURN_COUNT,
    INITIAL_CHAT_CONTEXT_RADIUS,
    CHAT_CONTEXT_STEP,
  } = await import(moduleUrl);
  const turns = Array.from({ length: 121 }, (_, index) => ({
    memoryId: `turn:${index + 1}`,
  }));

  const defaultWindow = chatTurnWindow(turns, null);
  assert.equal(DEFAULT_CHAT_INITIAL_TURN_COUNT, 16);
  assert.deepEqual(defaultWindow.turns.map((turn) => turn.memoryId), turns.slice(0, 16).map((turn) => turn.memoryId));
  assert.equal(defaultWindow.beforeCount, 0);
  assert.equal(defaultWindow.afterCount, 105);

  const expandedDefaultWindow = chatTurnWindow(turns, null, INITIAL_CHAT_CONTEXT_RADIUS, DEFAULT_CHAT_INITIAL_TURN_COUNT + CHAT_CONTEXT_STEP);
  assert.equal(CHAT_CONTEXT_STEP, 16);
  assert.deepEqual(expandedDefaultWindow.turns.map((turn) => turn.memoryId), turns.slice(0, 32).map((turn) => turn.memoryId));
  assert.equal(expandedDefaultWindow.beforeCount, 0);
  assert.equal(expandedDefaultWindow.afterCount, 89);

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
  assert.deepEqual(expandedBefore.turns.map((turn) => turn.memoryId), turns.slice(24, 81).map((turn) => turn.memoryId));
  assert.equal(expandedBefore.beforeCount, 24);
  assert.equal(expandedBefore.afterCount, 40);

  const expandedAfter = chatTurnWindow(
    turns,
    'turn:61',
    INITIAL_CHAT_CONTEXT_RADIUS,
    INITIAL_CHAT_CONTEXT_RADIUS + CHAT_CONTEXT_STEP,
  );
  assert.deepEqual(expandedAfter.turns.map((turn) => turn.memoryId), turns.slice(40, 97).map((turn) => turn.memoryId));
  assert.equal(expandedAfter.beforeCount, 40);
  assert.equal(expandedAfter.afterCount, 24);
});
