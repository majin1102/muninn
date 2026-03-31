import test from 'node:test';
import assert from 'node:assert/strict';

import { __testing } from '../dist/client.js';

test('waitForPromiseOrTimeout returns false when the promise does not settle in time', async () => {
  const startedAt = Date.now();
  const completed = await __testing.waitForPromiseOrTimeout(
    new Promise(() => {}),
    25,
  );

  assert.equal(completed, false);
  assert.ok(Date.now() - startedAt < 250);
});

test('waitForPromiseOrTimeout returns true when the promise settles before the timeout', async () => {
  const completed = await __testing.waitForPromiseOrTimeout(
    Promise.resolve(null),
    25,
  );

  assert.equal(completed, true);
});

test('waitForPromiseOrTimeout treats rejected promises as settled', async () => {
  const completed = await __testing.waitForPromiseOrTimeout(
    Promise.reject(new Error('shutdown failed')),
    25,
  );

  assert.equal(completed, true);
});
