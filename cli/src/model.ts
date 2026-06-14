import type { Scope } from './args.js';

export type InstallHost = 'codex' | 'claude';
export type InstallPart = 'mcp' | 'hook';
export type PlanAction = 'install' | 'uninstall';

export type HostPaths = {
  codexConfigPath: string;
  claudeSettingsPath: string;
  claudeMcpJsonPath: string;
};

export type ResolvedCommand = {
  command: string;
  resolvedPath: string | null;
  isAbsolute: boolean;
};

export type ChangePlan = {
  changed: boolean;
  path: string;
  before: string;
  after: string;
  summary: string[];
};

export type InstallOptions = {
  action: PlanAction;
  host: InstallHost;
  parts: Set<InstallPart>;
  scope: Scope;
  serverUrl: string;
  dryRun: boolean;
  yes: boolean;
};
