import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMuninnConfigContent } from '../dist/config.js';

test('parseMuninnConfigContent accepts server host and port config', () => {
  const config = parseMuninnConfigContent(JSON.stringify({
    server: {
      host: '0.0.0.0',
      port: 52423,
    },
  }));

  assert.deepEqual(config.server, {
    host: '0.0.0.0',
    port: 52423,
  });
});

test('parseMuninnConfigContent rejects invalid server port', () => {
  assert.throws(
    () => parseMuninnConfigContent(JSON.stringify({
      server: {
        host: '127.0.0.1',
        port: 70000,
      },
    })),
    /server\.port must be an integer from 1 to 65535/,
  );
});
