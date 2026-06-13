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

test('planCodexConfig install dedupes muninn hook inside mixed Stop block', () => {
  const before = [
    '[[hooks.Stop]]',
    '[[hooks.Stop.hooks]]',
    'type = "command"',
    'command = "python3 ./existing.py"',
    'timeout = 10',
    '',
    '[[hooks.Stop.hooks]]',
    'type = "command"',
    'command = "muninn-codex-hook"',
    'timeout = 30',
    'statusMessage = "Syncing turn to Muninn"',
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

test('planCodexConfig uninstall removes muninn hook inside mixed Stop block only', () => {
  const before = [
    '[[hooks.Stop]]',
    '[[hooks.Stop.hooks]]',
    'type = "command"',
    'command = "python3 ./existing.py"',
    'timeout = 10',
    '',
    '[[hooks.Stop.hooks]]',
    'type = "command"',
    'command = "muninn-codex-hook"',
    'timeout = 30',
    'statusMessage = "Syncing turn to Muninn"',
    '',
  ].join('\n');

  const plan = planCodexConfig(before, {
    path: '/home/dev/.codex/config.toml',
    action: 'uninstall',
    parts: new Set(['hook']),
    serverUrl: 'http://127.0.0.1:8080',
    commands,
  });

  assert.match(plan.after, /command = "python3 \.\/existing.py"/);
  assert.doesNotMatch(plan.after, /muninn-codex-hook/);
  assert.match(plan.after, /\[\[hooks\.Stop\]\]/);
});

test('planCodexConfig matches muninn hook command with inline TOML comment', () => {
  const before = [
    '[[hooks.Stop]]',
    '[[hooks.Stop.hooks]]',
    'type = "command"',
    'command = "python3 ./existing.py"',
    'timeout = 10',
    '',
    '[[hooks.Stop.hooks]]',
    'type = "command"',
    'command = "muninn-codex-hook" # installed by muninn',
    'timeout = 30',
    'statusMessage = "Syncing turn to Muninn"',
    '',
  ].join('\n');

  const uninstall = planCodexConfig(before, {
    path: '/home/dev/.codex/config.toml',
    action: 'uninstall',
    parts: new Set(['hook']),
    serverUrl: 'http://127.0.0.1:8080',
    commands,
  });

  assert.match(uninstall.after, /command = "python3 \.\/existing.py"/);
  assert.doesNotMatch(uninstall.after, /muninn-codex-hook/);

  const install = planCodexConfig(before, {
    path: '/home/dev/.codex/config.toml',
    action: 'install',
    parts: new Set(['hook']),
    serverUrl: 'http://127.0.0.1:8080',
    commands,
  });

  assert.match(install.after, /command = "python3 \.\/existing.py"/);
  assert.equal((install.after.match(/^command = "muninn-codex-hook"/gm) ?? []).length, 1);
});

test('planCodexConfig preserves hook entries that only mention muninn hook outside command value', () => {
  const before = [
    '[[hooks.Stop]]',
    '[[hooks.Stop.hooks]]',
    'type = "command"',
    'command = "python3 ./existing.py"',
    'timeout = 10',
    'statusMessage = "mentions muninn-codex-hook"',
    '',
    '[[hooks.Stop.hooks]]',
    'type = "command"',
    'command = "muninn-codex-hook-wrapper"',
    'timeout = 10',
    '',
  ].join('\n');

  const uninstall = planCodexConfig(before, {
    path: '/home/dev/.codex/config.toml',
    action: 'uninstall',
    parts: new Set(['hook']),
    serverUrl: 'http://127.0.0.1:8080',
    commands,
  });

  assert.equal(uninstall.changed, false);
  assert.equal(uninstall.after, before);
  assert.deepEqual(uninstall.summary, []);

  const install = planCodexConfig(before, {
    path: '/home/dev/.codex/config.toml',
    action: 'install',
    parts: new Set(['hook']),
    serverUrl: 'http://127.0.0.1:8080',
    commands,
  });

  assert.match(install.after, /command = "python3 \.\/existing.py"/);
  assert.match(install.after, /command = "muninn-codex-hook-wrapper"/);
  assert.match(install.after, /statusMessage = "mentions muninn-codex-hook"/);
  assert.equal((install.after.match(/^command = "muninn-codex-hook"$/gm) ?? []).length, 1);
});

test('planCodexConfig uninstall from empty config has empty summary', () => {
  const plan = planCodexConfig('', {
    path: '/home/dev/.codex/config.toml',
    action: 'uninstall',
    parts: new Set(['mcp', 'hook']),
    serverUrl: 'http://127.0.0.1:8080',
    commands,
  });

  assert.equal(plan.changed, false);
  assert.deepEqual(plan.summary, []);
});

test('planCodexConfig reinstalling exact config has empty summary', () => {
  const before = planCodexConfig('', {
    path: '/home/dev/.codex/config.toml',
    action: 'install',
    parts: new Set(['mcp', 'hook']),
    serverUrl: 'http://127.0.0.1:8080',
    commands,
  }).after;

  const plan = planCodexConfig(before, {
    path: '/home/dev/.codex/config.toml',
    action: 'install',
    parts: new Set(['mcp', 'hook']),
    serverUrl: 'http://127.0.0.1:8080',
    commands,
  });

  assert.equal(plan.changed, false);
  assert.deepEqual(plan.summary, []);
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
