import test from 'node:test';
import assert from 'node:assert/strict';

import { runDoctorChecks } from '../dist/doctor.js';

test('runDoctorChecks reports missing cargo and protoc', async () => {
  const checks = await runDoctorChecks({
    platform: 'darwin',
    nodeVersion: 'v20.11.0',
    commandExists: (name) => name === 'node',
    fetchHealth: async () => ({ ok: false, detail: 'offline' }),
    loadNative: async () => ({ ok: false, detail: 'native addon not built' }),
  });

  assert.deepEqual(checks.map((check) => [check.name, check.ok]), [
    ['platform', true],
    ['node', true],
    ['cargo', false],
    ['protoc', false],
    ['native addon', false],
    ['server health', false],
  ]);
  assert.match(checks.find((check) => check.name === 'cargo').detail, /cargo not found/);
});

test('runDoctorChecks accepts linux and node 20+', async () => {
  const checks = await runDoctorChecks({
    platform: 'linux',
    nodeVersion: 'v22.0.0',
    commandExists: () => true,
    fetchHealth: async () => ({ ok: true, detail: 'ok' }),
    loadNative: async () => ({ ok: true, detail: 'ok' }),
  });

  assert.equal(checks.every((check) => check.ok), true);
});
