import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveServeEnv } from '../dist/serve.js';

test('resolveServeEnv applies serve defaults', () => {
  assert.deepEqual(resolveServeEnv({}), {
    HOST: '127.0.0.1',
    PORT: '8080',
    MUNINN_HOME: `${process.env.HOME}/.muninn`,
  });
});

test('resolveServeEnv applies explicit options', () => {
  assert.deepEqual(resolveServeEnv({
    host: '0.0.0.0',
    port: 8081,
    home: '/tmp/muninn-home',
  }), {
    HOST: '0.0.0.0',
    PORT: '8081',
    MUNINN_HOME: '/tmp/muninn-home',
  });
});
