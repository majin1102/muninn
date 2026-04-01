import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { __testing } from '../dist/client.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));

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

test('resolveDaemonLaunchSpec prefers an explicit daemon path', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'munnai-core-daemon-'));
  const daemonPath = path.join(dir, 'daemon');
  await writeFile(daemonPath, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(daemonPath, 0o755);

  process.env.MUNNAI_CORE_DAEMON_PATH = daemonPath;
  try {
    const spec = __testing.resolveDaemonLaunchSpec();
    assert.equal(spec.command, daemonPath);
    assert.deepEqual(spec.args, []);
    assert.equal(spec.source, 'path');
  } finally {
    delete process.env.MUNNAI_CORE_DAEMON_PATH;
  }
});

test('resolveDaemonLaunchSpec can target a named command on PATH', async () => {
  process.env.MUNNAI_CORE_DAEMON_COMMAND = 'munnai-core';
  try {
    const spec = __testing.resolveDaemonLaunchSpec();
    assert.equal(spec.command, 'munnai-core');
    assert.deepEqual(spec.args, []);
    assert.equal(spec.source, 'command');
  } finally {
    delete process.env.MUNNAI_CORE_DAEMON_COMMAND;
  }
});

test('resolveDaemonLaunchSpec prefers a bundled daemon before PATH lookup', async () => {
  const binDir = path.join(testDir, '..', 'bin');
  const bundledDaemonPath = path.join(binDir, __testing.resolveBundledDaemonExecutableName());

  await mkdir(binDir, { recursive: true });
  await writeFile(bundledDaemonPath, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(bundledDaemonPath, 0o755);

  try {
    const spec = __testing.resolveDaemonLaunchSpec();
    assert.equal(spec.command, bundledDaemonPath);
    assert.equal(spec.source, 'path');
  } finally {
    await rm(bundledDaemonPath, { force: true });
  }
});

test('resolveBundledDaemonExecutableName uses .exe on Windows', async () => {
  assert.equal(__testing.resolveBundledDaemonExecutableName('win32'), 'munnai-core.exe');
  assert.equal(__testing.resolveBundledDaemonExecutableName('darwin'), 'munnai-core');
});

test('resolveDaemonLaunchSpec only falls back to cargo when explicitly enabled', async () => {
  process.env.MUNNAI_CORE_ALLOW_CARGO_FALLBACK = '1';
  try {
    const spec = __testing.resolveDaemonLaunchSpec();
    assert.equal(spec.command, 'cargo');
    assert.deepEqual(spec.args.slice(0, 3), ['run', '--quiet', '--manifest-path']);
    assert.equal(spec.source, 'cargo-fallback');
  } finally {
    delete process.env.MUNNAI_CORE_ALLOW_CARGO_FALLBACK;
  }
});

test('formatDaemonStartError explains how to configure a missing daemon', async () => {
  const error = __testing.formatDaemonStartError(
    {
      command: 'munnai-core',
      args: [],
      cwd: undefined,
      description: 'munnai-core on PATH',
      source: 'command',
    },
    Object.assign(new Error('spawn munnai-core ENOENT'), { code: 'ENOENT' }),
  );

  assert.match(error.message, /MUNNAI_CORE_DAEMON_PATH/);
  assert.match(error.message, /MUNNAI_CORE_ALLOW_CARGO_FALLBACK/);
});
