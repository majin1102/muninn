import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('MCP default surface exposes only Muninn context tools', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');

  for (const toolName of ['muninn-recall', 'muninn-list', 'muninn-read', 'muninn-explain']) {
    assert.match(source, new RegExp(`name: '${toolName}'`));
  }
  for (const oldToolName of ['print', 'recall', 'list', 'get_timeline', 'get_detail', 'project_signals']) {
    assert.doesNotMatch(source, new RegExp(`name: '${oldToolName}'`));
  }
});
