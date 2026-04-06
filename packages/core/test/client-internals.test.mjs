import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';

import { __testing } from '../dist/client.js';

test('resolveNativeBindingPath points at the packaged addon', async () => {
  const bindingPath = __testing.resolveNativeBindingPath();
  assert.match(bindingPath, /muninn_native\.node$/);
  await access(bindingPath);
});
