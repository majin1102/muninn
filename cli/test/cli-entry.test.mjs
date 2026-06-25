import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('CLI entry runs when invoked through an npm-style symlink', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muninn-cli-entry-'));
  const entry = path.resolve('dist', 'cli.js');
  const link = path.join(root, 'muninn');
  await symlink(entry, link);

  const result = spawnSync(process.execPath, [link, '--help'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /muninn run/);
  assert.match(result.stdout, /muninn start/);
  assert.match(result.stdout, /muninn restart/);
  assert.doesNotMatch(result.stdout, /muninn serve/);
});

test('CLI install writes package-local dependency bin paths for host commands', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muninn-cli-install-'));
  const entry = path.resolve('dist', 'cli.js');

  const result = spawnSync(process.execPath, [
    entry,
    'install',
    'codex',
    '--scope',
    'project',
    '--yes',
  ], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const config = await readFile(path.join(root, '.codex', 'config.toml'), 'utf8');
  assert.match(config, /node_modules\/(?:\.bin\/muninn-mcp|@muninn\/mcp\/dist\/index\.js)/);
  assert.match(config, /node_modules\/(?:\.bin\/muninn-codex-hook|@muninn\/codex\/dist\/cli\.js)/);
});
