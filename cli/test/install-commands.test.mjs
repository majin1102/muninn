import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveInstallCommands } from '../dist/cli.js';

test('resolveInstallCommands only requires binaries used by hook-only codex install', () => {
  const resolved = resolveInstallCommands({
    requireExecutable: true,
    target: 'codex',
    parts: new Set(['hook']),
    envPath: '',
    access: (candidate) => candidate.endsWith('/muninn-codex-hook'),
  });

  assert.equal(resolved.mcpCommand, 'muninn-mcp');
  assert.match(resolved.codexHookCommand, /muninn-codex-hook$/);
  assert.equal(resolved.claudeHookCommand, 'muninn-claude-hook');
});

test('resolveInstallCommands resolves workspace package bin when mcp install is selected', () => {
  const resolved = resolveInstallCommands({
    requireExecutable: true,
    target: 'codex',
    parts: new Set(['mcp']),
    envPath: '',
    access: () => false,
  });

  assert.match(resolved.mcpCommand, /@muninn\/mcp\/dist\/index\.js$/);
});
