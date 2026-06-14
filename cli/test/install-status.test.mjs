import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { installHost, installTargets, uninstallHost } from '../dist/install.js';
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

test('installTargets confirms all hosts once before writing any config', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muninn-install-all-'));
  const cwd = path.join(root, 'project');
  let asked = 0;
  let summary = [];

  const result = await installTargets({
    target: 'all',
    action: 'install',
    parts: new Set(['mcp', 'hook']),
    scope: 'user',
    serverUrl: 'http://127.0.0.1:8080',
    dryRun: false,
    yes: false,
    home: root,
    cwd,
    commands,
    confirm: async (lines) => {
      asked += 1;
      summary = lines;
      return true;
    },
  });

  assert.equal(asked, 1);
  assert.deepEqual(summary, [
    'Configure Codex MCP server: muninn',
    'Configure Codex Stop hook: muninn-codex-hook',
    'Configure Claude Code MCP server: muninn',
    'Configure Claude Code Stop hook: muninn-claude-hook',
  ]);
  assert.equal(result.length, 3);

  const status = await readInstallStatus({ home: root, cwd, scope: 'user' });
  assert.deepEqual(status, {
    codex: { mcp: true, hook: true },
    claude: { mcp: true, hook: true },
  });
});

test('installTargets denied all confirmation writes neither host config', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muninn-install-all-denied-'));
  const cwd = path.join(root, 'project');
  let asked = 0;

  const result = await installTargets({
    target: 'all',
    action: 'install',
    parts: new Set(['mcp', 'hook']),
    scope: 'user',
    serverUrl: 'http://127.0.0.1:8080',
    dryRun: false,
    yes: false,
    home: root,
    cwd,
    commands,
    confirm: async () => {
      asked += 1;
      return false;
    },
  });

  assert.equal(asked, 1);
  assert.deepEqual(result, []);

  const status = await readInstallStatus({ home: root, cwd, scope: 'user' });
  assert.deepEqual(status, {
    codex: { mcp: false, hook: false },
    claude: { mcp: false, hook: false },
  });
});

test('installTargets preflights all changed plans before writing any config', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muninn-install-all-stale-'));
  const cwd = path.join(root, 'project');
  await mkdir(path.join(root, '.claude'), { recursive: true });

  await assert.rejects(
    () => installTargets({
      target: 'all',
      action: 'install',
      parts: new Set(['mcp', 'hook']),
      scope: 'user',
      serverUrl: 'http://127.0.0.1:8080',
      dryRun: false,
      yes: false,
      home: root,
      cwd,
      commands,
      confirm: async () => {
        await writeFile(path.join(root, '.claude.json'), '{"outside":true}\n');
        return true;
      },
    }),
    /config changed/i,
  );

  const status = await readInstallStatus({ home: root, cwd, scope: 'user' });
  assert.deepEqual(status, {
    codex: { mcp: false, hook: false },
    claude: { mcp: false, hook: false },
  });
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

test('readInstallStatus ignores comments status messages wrapper names and unrelated JSON fields', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muninn-status-false-positive-'));
  const cwd = path.join(root, 'project');

  await mkdir(path.join(root, '.codex'), { recursive: true });
  await mkdir(path.join(root, '.claude'), { recursive: true });
  await writeFile(path.join(root, '.codex', 'config.toml'), [
    '# [mcp_servers.muninn]',
    '[[hooks.Stop]]',
    '[[hooks.Stop.hooks]]',
    'type = "command"',
    'command = "muninn-codex-hook-wrapper"',
    'timeout = 30',
    'statusMessage = "mentions muninn-codex-hook"',
    '# command = "muninn-codex-hook"',
    '',
  ].join('\n'));
  await writeFile(path.join(root, '.claude.json'), JSON.stringify({
    mcpServers: {
      muninn: {
        type: 'stdio',
        command: 'muninn-mcp-wrapper',
      },
      other: {
        note: 'muninn-mcp',
      },
    },
    note: '"muninn"',
  }, null, 2));
  await writeFile(path.join(root, '.claude', 'settings.json'), JSON.stringify({
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: '/usr/local/bin/muninn-claude-hook-wrapper',
              statusMessage: 'mentions muninn-claude-hook',
            },
          ],
        },
      ],
    },
    note: 'muninn-claude-hook',
  }, null, 2));

  const status = await readInstallStatus({ home: root, cwd, scope: 'user' });
  assert.deepEqual(status, {
    codex: { mcp: false, hook: false },
    claude: { mcp: false, hook: false },
  });
});

test('readInstallStatus requires Codex muninn MCP table to use managed command', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muninn-status-codex-mcp-'));
  const cwd = path.join(root, 'project');
  await mkdir(path.join(root, '.codex'), { recursive: true });

  await writeFile(path.join(root, '.codex', 'config.toml'), [
    '[mcp_servers.muninn]',
    'command = "not-muninn-mcp"',
    '',
    '[mcp_servers.other]',
    'command = "muninn-mcp"',
    '',
  ].join('\n'));

  const wrongCommand = await readInstallStatus({ home: root, cwd, scope: 'user' });
  assert.equal(wrongCommand.codex.mcp, false);

  await writeFile(path.join(root, '.codex', 'config.toml'), [
    '[mcp_servers.muninn]',
    'command = "/opt/homebrew/bin/muninn-mcp"',
    '',
  ].join('\n'));

  const managedCommand = await readInstallStatus({ home: root, cwd, scope: 'user' });
  assert.equal(managedCommand.codex.mcp, true);
});
