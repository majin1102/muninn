import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/server-client.ts', import.meta.url), 'utf8');

test('MCP recall posts top_k through the MCP recall text endpoint', () => {
  assert.match(source, /recall\(request: RecallInput\): Promise<string>/);
  assert.match(source, /postText\('\/api\/v1\/mcp\/recall', request\)/);
  assert.doesNotMatch(source, /\/api\/v1\/recall/);
  assert.doesNotMatch(source, /\bqueryLimit\b/);
});
