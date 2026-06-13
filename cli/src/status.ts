import type { Scope } from './args.js';
import { readTextFileIfExists } from './files.js';
import { resolveHostPaths } from './paths.js';

export type InstallStatus = {
  codex: {
    mcp: boolean;
    hook: boolean;
  };
  claude: {
    mcp: boolean;
    hook: boolean;
  };
};

export async function readInstallStatus(params: {
  home: string;
  cwd: string;
  scope: Scope;
}): Promise<InstallStatus> {
  const paths = resolveHostPaths(params);
  const [codexConfig, claudeSettings, claudeMcpJson] = await Promise.all([
    readTextFileIfExists(paths.codexConfigPath),
    readTextFileIfExists(paths.claudeSettingsPath),
    readTextFileIfExists(paths.claudeMcpJsonPath),
  ]);

  return {
    codex: {
      mcp: codexConfig.includes('[mcp_servers.muninn]'),
      hook: codexConfig.includes('muninn-codex-hook'),
    },
    claude: {
      mcp: claudeMcpJson.includes('"muninn"') && claudeMcpJson.includes('muninn-mcp'),
      hook: claudeSettings.includes('muninn-claude-hook'),
    },
  };
}
