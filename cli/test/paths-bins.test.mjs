import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { resolveHostPaths } from '../dist/paths.js';
import { renderCommand, resolveCommand } from '../dist/bins.js';

test('resolveHostPaths returns user config paths', () => {
  const paths = resolveHostPaths({
    home: '/Users/dev',
    cwd: '/Users/dev/workspace/project',
    scope: 'user',
  });

  assert.equal(paths.codexConfigPath, path.join('/Users/dev', '.codex', 'config.toml'));
  assert.equal(paths.claudeSettingsPath, path.join('/Users/dev', '.claude', 'settings.json'));
  assert.equal(paths.claudeMcpJsonPath, path.join('/Users/dev', '.claude.json'));
});

test('resolveHostPaths returns project config paths', () => {
  const paths = resolveHostPaths({
    home: '/Users/dev',
    cwd: '/Users/dev/workspace/project',
    scope: 'project',
  });

  assert.equal(paths.codexConfigPath, path.join('/Users/dev/workspace/project', '.codex', 'config.toml'));
  assert.equal(paths.claudeSettingsPath, path.join('/Users/dev/workspace/project', '.claude', 'settings.json'));
  assert.equal(paths.claudeMcpJsonPath, path.join('/Users/dev/workspace/project', '.mcp.json'));
});

test('resolveCommand prefers stable command name when available', () => {
  const resolved = resolveCommand('muninn-mcp', {
    envPath: '/usr/local/bin:/opt/bin',
    access: (candidate) => candidate === '/usr/local/bin/muninn-mcp',
  });

  assert.deepEqual(resolved, {
    command: 'muninn-mcp',
    resolvedPath: '/usr/local/bin/muninn-mcp',
    isAbsolute: false,
  });
});

test('resolveCommand falls back to absolute path when requested', () => {
  const resolved = resolveCommand('muninn-codex-hook', {
    preferAbsolute: true,
    envPath: '/usr/local/bin',
    access: (candidate) => candidate === '/usr/local/bin/muninn-codex-hook',
  });

  assert.deepEqual(resolved, {
    command: '/usr/local/bin/muninn-codex-hook',
    resolvedPath: '/usr/local/bin/muninn-codex-hook',
    isAbsolute: true,
  });
});

test('resolveCommand checks package-local dependency bins before PATH', () => {
  const resolved = resolveCommand('muninn-mcp', {
    preferAbsolute: true,
    envPath: '/usr/local/bin',
    extraBinDirs: ['/opt/muninn/node_modules/.bin'],
    access: (candidate) => candidate === '/opt/muninn/node_modules/.bin/muninn-mcp',
  });

  assert.deepEqual(resolved, {
    command: '/opt/muninn/node_modules/.bin/muninn-mcp',
    resolvedPath: '/opt/muninn/node_modules/.bin/muninn-mcp',
    isAbsolute: true,
  });
});

test('renderCommand quotes commands with spaces', () => {
  assert.equal(renderCommand('/Applications/Muninn Tools/muninn-mcp'), '"/Applications/Muninn Tools/muninn-mcp"');
  assert.equal(renderCommand('muninn-mcp'), 'muninn-mcp');
});
