import test from 'node:test';
import assert from 'node:assert/strict';

import { planCodexConfig } from '../dist/codex_config.js';

const commands = {
  mcpCommand: 'muninn-mcp',
  hookCommand: 'muninn-codex-hook',
};

test('planCodexConfig installs mcp and hook into empty config', () => {
  const plan = planCodexConfig('', {
    path: '/home/dev/.codex/config.toml',
    action: 'install',
    parts: new Set(['mcp', 'hook']),
    serverUrl: 'http://127.0.0.1:8080',
    commands,
  });

  assert.equal(plan.changed, true);
  assert.match(plan.after, /\[mcp_servers\.muninn\]/);
  assert.match(plan.after, /command = "muninn-mcp"/);
  assert.match(plan.after, /MUNINN_SERVER_BASE_URL = "http:\/\/127\.0\.0\.1:8080"/);
  assert.match(plan.after, /\[\[hooks\.Stop\]\]/);
  assert.match(plan.after, /command = "muninn-codex-hook"/);
  assert.match(plan.after, /statusMessage = "Syncing turn to Muninn"/);
});

test('planCodexConfig updates existing muninn mcp without duplicating it', () => {
  const before = [
    '[mcp_servers.muninn]',
    'command = "old-muninn-mcp"',
    'env = { MUNINN_SERVER_BASE_URL = "http://127.0.0.1:9999" }',
    '',
    '[mcp_servers.context7]',
    'command = "npx"',
    'args = ["-y", "@upstash/context7-mcp"]',
    '',
  ].join('\n');

  const plan = planCodexConfig(before, {
    path: '/home/dev/.codex/config.toml',
    action: 'install',
    parts: new Set(['mcp']),
    serverUrl: 'http://127.0.0.1:8081',
    commands,
  });

  assert.equal((plan.after.match(/\[mcp_servers\.muninn\]/g) ?? []).length, 1);
  assert.match(plan.after, /MUNINN_SERVER_BASE_URL = "http:\/\/127\.0\.0\.1:8081"/);
  assert.match(plan.after, /\[mcp_servers\.context7\]/);
});

test('planCodexConfig does not remove unrelated Stop hooks', () => {
  const before = [
    '[[hooks.Stop]]',
    '[[hooks.Stop.hooks]]',
    'type = "command"',
    'command = "python3 ./existing.py"',
    'timeout = 10',
    '',
  ].join('\n');

  const plan = planCodexConfig(before, {
    path: '/home/dev/.codex/config.toml',
    action: 'install',
    parts: new Set(['hook']),
    serverUrl: 'http://127.0.0.1:8080',
    commands,
  });

  assert.match(plan.after, /command = "python3 \.\/existing.py"/);
  assert.equal((plan.after.match(/muninn-codex-hook/g) ?? []).length, 1);
});

test('planCodexConfig uninstall removes only muninn entries', () => {
  const installed = planCodexConfig('', {
    path: '/home/dev/.codex/config.toml',
    action: 'install',
    parts: new Set(['mcp', 'hook']),
    serverUrl: 'http://127.0.0.1:8080',
    commands,
  }).after + [
    '',
    '[mcp_servers.context7]',
    'command = "npx"',
    '',
  ].join('\n');

  const plan = planCodexConfig(installed, {
    path: '/home/dev/.codex/config.toml',
    action: 'uninstall',
    parts: new Set(['mcp', 'hook']),
    serverUrl: 'http://127.0.0.1:8080',
    commands,
  });

  assert.equal(plan.changed, true);
  assert.doesNotMatch(plan.after, /\[mcp_servers\.muninn\]/);
  assert.doesNotMatch(plan.after, /muninn-codex-hook/);
  assert.match(plan.after, /\[mcp_servers\.context7\]/);
});
