import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planClaudeMcpJson,
  planClaudeSettings,
  renderClaudeMcpAddCommand,
} from '../dist/claude-config.js';

test('planClaudeSettings installs Stop hook into empty settings', () => {
  const plan = planClaudeSettings('', {
    path: '/home/dev/.claude/settings.json',
    action: 'install',
    hookCommand: 'muninn-claude-hook',
  });

  assert.equal(plan.changed, true);
  const parsed = JSON.parse(plan.after);
  assert.equal(parsed.hooks.Stop[0].hooks[0].type, 'command');
  assert.equal(parsed.hooks.Stop[0].hooks[0].command, 'muninn-claude-hook');
  assert.equal(parsed.hooks.Stop[0].hooks[0].timeout, 30);
});

test('planClaudeSettings preserves unrelated hooks', () => {
  const before = JSON.stringify({
    hooks: {
      Stop: [
        { hooks: [{ type: 'command', command: 'python3 ./existing.py', timeout: 10 }] },
      ],
    },
  }, null, 2);

  const plan = planClaudeSettings(before, {
    path: '/home/dev/.claude/settings.json',
    action: 'install',
    hookCommand: 'muninn-claude-hook',
  });

  const parsed = JSON.parse(plan.after);
  assert.equal(parsed.hooks.Stop.length, 2);
  assert.equal(parsed.hooks.Stop[0].hooks[0].command, 'python3 ./existing.py');
  assert.equal(parsed.hooks.Stop[1].hooks[0].command, 'muninn-claude-hook');
});

test('planClaudeSettings uninstall removes only muninn hook', () => {
  const installed = planClaudeSettings('', {
    path: '/home/dev/.claude/settings.json',
    action: 'install',
    hookCommand: 'muninn-claude-hook',
  }).after;

  const plan = planClaudeSettings(installed, {
    path: '/home/dev/.claude/settings.json',
    action: 'uninstall',
    hookCommand: 'muninn-claude-hook',
  });

  assert.equal(plan.changed, true);
  assert.doesNotMatch(plan.after, /muninn-claude-hook/);
});

test('planClaudeSettings removes muninn hook from mixed Stop entry only', () => {
  const before = JSON.stringify({
    hooks: {
      Stop: [
        {
          hooks: [
            { type: 'command', command: 'python3 ./existing.py', timeout: 10 },
            { type: 'command', command: '/opt/homebrew/bin/muninn-claude-hook', timeout: 30 },
          ],
        },
      ],
    },
  }, null, 2);

  const plan = planClaudeSettings(before, {
    path: '/home/dev/.claude/settings.json',
    action: 'uninstall',
    hookCommand: 'muninn-claude-hook',
  });

  const parsed = JSON.parse(plan.after);
  assert.equal(parsed.hooks.Stop.length, 1);
  assert.deepEqual(parsed.hooks.Stop[0].hooks, [
    { type: 'command', command: 'python3 ./existing.py', timeout: 10 },
  ]);
});

test('planClaudeSettings preserves hooks that only mention muninn hook outside command value', () => {
  const before = JSON.stringify({
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: 'muninn-claude-hook-wrapper',
              timeout: 10,
              statusMessage: 'mentions muninn-claude-hook',
            },
          ],
        },
      ],
    },
  }, null, 2);

  const uninstall = planClaudeSettings(before, {
    path: '/home/dev/.claude/settings.json',
    action: 'uninstall',
    hookCommand: 'muninn-claude-hook',
  });

  assert.equal(uninstall.changed, false);
  assert.equal(uninstall.after, before);
  assert.deepEqual(uninstall.summary, []);

  const install = planClaudeSettings(before, {
    path: '/home/dev/.claude/settings.json',
    action: 'install',
    hookCommand: 'muninn-claude-hook',
  });

  const parsed = JSON.parse(install.after);
  assert.equal(parsed.hooks.Stop.length, 2);
  assert.equal(parsed.hooks.Stop[0].hooks[0].command, 'muninn-claude-hook-wrapper');
  assert.equal(parsed.hooks.Stop[0].hooks[0].statusMessage, 'mentions muninn-claude-hook');
  assert.equal(parsed.hooks.Stop[1].hooks[0].command, 'muninn-claude-hook');
});

test('planClaudeSettings reinstalling exact hook has empty summary', () => {
  const before = planClaudeSettings('', {
    path: '/home/dev/.claude/settings.json',
    action: 'install',
    hookCommand: 'muninn-claude-hook',
  }).after;

  const plan = planClaudeSettings(before, {
    path: '/home/dev/.claude/settings.json',
    action: 'install',
    hookCommand: 'muninn-claude-hook',
  });

  assert.equal(plan.changed, false);
  assert.deepEqual(plan.summary, []);
});

test('planClaudeSettings uninstall from empty settings has empty summary', () => {
  const plan = planClaudeSettings('', {
    path: '/home/dev/.claude/settings.json',
    action: 'uninstall',
    hookCommand: 'muninn-claude-hook',
  });

  assert.equal(plan.changed, false);
  assert.deepEqual(plan.summary, []);
});

test('planClaudeMcpJson installs stdio muninn server', () => {
  const plan = planClaudeMcpJson('', {
    path: '/home/dev/.mcp.json',
    action: 'install',
    mcpCommand: 'muninn-mcp',
    serverUrl: 'http://127.0.0.1:8080',
  });

  const parsed = JSON.parse(plan.after);
  assert.deepEqual(parsed.mcpServers.muninn, {
    type: 'stdio',
    command: 'muninn-mcp',
    env: {
      MUNINN_SERVER_BASE_URL: 'http://127.0.0.1:8080',
    },
  });
});

test('planClaudeMcpJson preserves unrelated servers on uninstall', () => {
  const before = JSON.stringify({
    mcpServers: {
      context7: {
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp'],
      },
      muninn: {
        type: 'stdio',
        command: 'muninn-mcp',
      },
    },
  }, null, 2);

  const plan = planClaudeMcpJson(before, {
    path: '/home/dev/.mcp.json',
    action: 'uninstall',
    mcpCommand: 'muninn-mcp',
    serverUrl: 'http://127.0.0.1:8080',
  });

  const parsed = JSON.parse(plan.after);
  assert.deepEqual(Object.keys(parsed.mcpServers), ['context7']);
  assert.equal(parsed.mcpServers.context7.command, 'npx');
});

test('planClaudeMcpJson reinstalling exact server has empty summary', () => {
  const before = planClaudeMcpJson('', {
    path: '/home/dev/.mcp.json',
    action: 'install',
    mcpCommand: 'muninn-mcp',
    serverUrl: 'http://127.0.0.1:8080',
  }).after;

  const plan = planClaudeMcpJson(before, {
    path: '/home/dev/.mcp.json',
    action: 'install',
    mcpCommand: 'muninn-mcp',
    serverUrl: 'http://127.0.0.1:8080',
  });

  assert.equal(plan.changed, false);
  assert.deepEqual(plan.summary, []);
});

test('planClaudeMcpJson uninstall from empty config has empty summary', () => {
  const plan = planClaudeMcpJson('', {
    path: '/home/dev/.mcp.json',
    action: 'uninstall',
    mcpCommand: 'muninn-mcp',
    serverUrl: 'http://127.0.0.1:8080',
  });

  assert.equal(plan.changed, false);
  assert.deepEqual(plan.summary, []);
});

test('renderClaudeMcpAddCommand renders a user scoped stdio command', () => {
  assert.deepEqual(renderClaudeMcpAddCommand({
    scope: 'user',
    mcpCommand: 'muninn-mcp',
    serverUrl: 'http://127.0.0.1:8080',
  }), [
    'claude',
    'mcp',
    'add',
    '--scope',
    'user',
    '--transport',
    'stdio',
    'muninn',
    '--env',
    'MUNINN_SERVER_BASE_URL=http://127.0.0.1:8080',
    '--',
    'muninn-mcp',
  ]);
});
