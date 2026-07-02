import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('e2e recall helper serializes public mode query parameter', async () => {
  const source = await readFile(new URL('../../scripts/e2e/assertions.mjs', import.meta.url), 'utf8');

  assert.match(source, /params\.set\('mode', mode\)/);
  assert.doesNotMatch(source, /params\.set\('recallMode', mode\)/);
});
