import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { installHost, uninstallHost } from '../dist/install.js';
import { readInstallStatus } from '../dist/status.js';

const commands = {
  mcpCommand: 'muninn-mcp',
  codexHookCommand: 'muninn-codex-hook',
  claudeHookCommand: 'muninn-claude-hook',
};

test('installHost writes Codex config under temporary user HOME', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muninn-install-'));
  const result = await installHost({
    host: 'codex',
    action: 'install',
    parts: new Set(['mcp', 'hook']),
    scope: 'user',
    serverUrl: 'http://127.0.0.1:8080',
    dryRun: false,
    yes: true,
    home: root,
    cwd: path.join(root, 'project'),
    commands,
  });

  assert.equal(result.length, 1);
  const config = await readFile(path.join(root, '.codex', 'config.toml'), 'utf8');
  assert.match(config, /\[mcp_servers\.muninn\]/);
  assert.match(config, /muninn-codex-hook/);
});

test('installHost asks for confirmation when not dry-run and --yes is absent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muninn-confirm-'));
  let asked = 0;

  await installHost({
    host: 'codex',
    action: 'install',
    parts: new Set(['mcp']),
    scope: 'user',
    serverUrl: 'http://127.0.0.1:8080',
    dryRun: false,
    yes: false,
    home: root,
    cwd: path.join(root, 'project'),
    commands,
    confirm: async () => {
      asked += 1;
      return true;
    },
  });

  assert.equal(asked, 1);
  const config = await readFile(path.join(root, '.codex', 'config.toml'), 'utf8');
  assert.match(config, /\[mcp_servers\.muninn\]/);
});

test('installHost skips writes when confirmation is denied', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muninn-confirm-denied-'));

  const result = await installHost({
    host: 'codex',
    action: 'install',
    parts: new Set(['mcp']),
    scope: 'user',
    serverUrl: 'http://127.0.0.1:8080',
    dryRun: false,
    yes: false,
    home: root,
    cwd: path.join(root, 'project'),
    commands,
    confirm: async () => false,
  });

  assert.deepEqual(result, []);
});

test('installHost does not ask for confirmation when every plan is unchanged', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muninn-confirm-noop-'));
  const cwd = path.join(root, 'project');
  await installHost({
    host: 'codex',
    action: 'install',
    parts: new Set(['mcp']),
    scope: 'user',
    serverUrl: 'http://127.0.0.1:8080',
    dryRun: false,
    yes: true,
    home: root,
    cwd,
    commands,
  });

  let asked = 0;
  const result = await installHost({
    host: 'codex',
    action: 'install',
    parts: new Set(['mcp']),
    scope: 'user',
    serverUrl: 'http://127.0.0.1:8080',
    dryRun: false,
    yes: false,
    home: root,
    cwd,
    commands,
    confirm: async () => {
      asked += 1;
      return true;
    },
  });

  assert.equal(asked, 0);
  assert.equal(result.length, 1);
  assert.equal(result[0].wrote, false);
});

test('uninstallHost removes Codex muninn entries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muninn-uninstall-'));
  const cwd = path.join(root, 'project');
  await installHost({
    host: 'codex',
    action: 'install',
    parts: new Set(['mcp', 'hook']),
    scope: 'user',
    serverUrl: 'http://127.0.0.1:8080',
    dryRun: false,
    yes: true,
    home: root,
    cwd,
    commands,
  });
  await uninstallHost({
    host: 'codex',
    action: 'uninstall',
    parts: new Set(['mcp', 'hook']),
    scope: 'user',
    serverUrl: 'http://127.0.0.1:8080',
    dryRun: false,
    yes: true,
    home: root,
    cwd,
    commands,
  });

  const config = await readFile(path.join(root, '.codex', 'config.toml'), 'utf8');
  assert.doesNotMatch(config, /mcp_servers\.muninn/);
  assert.doesNotMatch(config, /muninn-codex-hook/);
});

test('readInstallStatus detects installed Codex and Claude entries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muninn-status-'));
  const cwd = path.join(root, 'project');
  await installHost({
    host: 'codex',
    action: 'install',
    parts: new Set(['mcp', 'hook']),
    scope: 'user',
    serverUrl: 'http://127.0.0.1:8080',
    dryRun: false,
    yes: true,
    home: root,
    cwd,
    commands,
  });
  await installHost({
    host: 'claude',
    action: 'install',
    parts: new Set(['mcp', 'hook']),
    scope: 'user',
    serverUrl: 'http://127.0.0.1:8080',
    dryRun: false,
    yes: true,
    home: root,
    cwd,
    commands,
  });

  const status = await readInstallStatus({ home: root, cwd, scope: 'user' });
  assert.equal(status.codex.mcp, true);
  assert.equal(status.codex.hook, true);
  assert.equal(status.claude.mcp, true);
  assert.equal(status.claude.hook, true);
});
