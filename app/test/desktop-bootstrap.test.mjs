import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('api client reads macOS desktop bootstrap and sends bearer token', async () => {
  const source = await readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8');

  assert.match(source, /__MUNINN_DESKTOP__/);
  assert.match(source, /apiToken/);
  assert.match(source, /Authorization/);
  assert.match(source, /Bearer/);
});
