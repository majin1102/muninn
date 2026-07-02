import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');

test('MCP registers only new muninn tool names', () => {
  const toolNames = [...source.matchAll(/name:\s*['"]([^'"]+)['"]/g)]
    .map((match) => match[1])
    .filter((name) => name.startsWith('muninn-') && name !== 'muninn-mcp');

  assert.deepEqual(toolNames, [
    'muninn-recall',
    'muninn-list',
    'muninn-read',
    'muninn-explain',
  ]);

  for (const oldName of ['print', 'recall', 'list', 'get_timeline', 'get_detail']) {
    assert.equal(toolNames.includes(oldName), false);
  }
});

test('MCP schemas omit obsolete recall/list options', () => {
  for (const obsolete of ['recallMode', 'thinkingRatio', 'queryLimit', 'limit']) {
    assert.doesNotMatch(source, new RegExp(`\\b${obsolete}\\b`));
  }

  assert.match(source, /top_k/);
  assert.match(source, /context_ids/);
  assert.match(source, /context_id/);
  assert.match(source, /context_ids: z\.array\(z\.string\(\)\.min\(1\)\)\.min\(1\)/);
  assert.match(source, /context_id: z\.string\(\)\.min\(1\)/);
});
