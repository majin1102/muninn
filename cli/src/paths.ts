import path from 'node:path';
import type { Scope } from './args.js';
import type { HostPaths } from './model.js';

export function resolveHostPaths(params: {
  home: string;
  cwd: string;
  scope: Scope;
}): HostPaths {
  if (params.scope === 'project') {
    return {
      codexConfigPath: path.join(params.cwd, '.codex', 'config.toml'),
      claudeSettingsPath: path.join(params.cwd, '.claude', 'settings.json'),
      claudeMcpJsonPath: path.join(params.cwd, '.mcp.json'),
    };
  }

  return {
    codexConfigPath: path.join(params.home, '.codex', 'config.toml'),
    claudeSettingsPath: path.join(params.home, '.claude', 'settings.json'),
    claudeMcpJsonPath: path.join(params.home, '.claude.json'),
  };
}
