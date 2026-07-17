import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/lib/conversation-gap.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const { turnsBeforeGap } = await import(moduleUrl);

test('replacing the latest page removes every previously loaded disjoint tail', () => {
  const turns = [
    ...Array.from({ length: 16 }, (_, index) => ({ contextId: `prefix:${index}` })),
    ...Array.from({ length: 16 }, (_, index) => ({ contextId: `old-tail:${index}` })),
    ...Array.from({ length: 16 }, (_, index) => ({ contextId: `later-tail:${index}` })),
  ];

  const result = turnsBeforeGap(turns, 'old-tail:0');

  assert.deepEqual(result, turns.slice(0, 16));
});

test('turns remain unchanged when the gap anchor is absent', () => {
  const turns = [{ contextId: 'turn:1' }, { contextId: 'turn:2' }];

  assert.equal(turnsBeforeGap(turns, 'missing'), turns);
});
