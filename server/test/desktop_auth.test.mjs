import test from 'node:test';
import assert from 'node:assert/strict';

import { app } from '../dist/routes.js';

test.afterEach(() => {
  delete process.env.MUNINN_DESKTOP_TOKEN;
});

test('desktop token protects api routes when configured', async () => {
  process.env.MUNINN_DESKTOP_TOKEN = 'desktop-secret';

  const missing = await app.request('/api/v1/ui/recall/providers');
  assert.equal(missing.status, 401);

  const wrong = await app.request('/api/v1/ui/recall/providers', {
    headers: { authorization: 'Bearer wrong-secret' },
  });
  assert.equal(wrong.status, 401);
});

test('desktop token allows api routes with matching bearer token', async () => {
  process.env.MUNINN_DESKTOP_TOKEN = 'desktop-secret';

  const response = await app.request('/api/v1/ui/recall/providers', {
    headers: { authorization: 'Bearer desktop-secret' },
  });
  assert.equal(response.status, 200);
});
