import test from 'node:test';
import assert from 'node:assert/strict';

import server from '../dist/index.js';

test('probeNativeAddon loads the native binding', () => {
  const { probeNativeAddon } = server;
  assert.equal(typeof probeNativeAddon, 'function');
  assert.doesNotThrow(() => probeNativeAddon());
});
