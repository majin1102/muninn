import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHookConfig } from '../dist/agent-hook.js';

test('hook config reads server base URL and trims trailing slashes', () => {
  const config = resolveHookConfig({
    MUNINN_SERVER_BASE_URL: 'http://127.0.0.1:9000///',
  });

  assert.equal(config.baseUrl, 'http://127.0.0.1:9000');
});

