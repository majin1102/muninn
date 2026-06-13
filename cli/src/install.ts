import { planClaudeMcpJson, planClaudeSettings } from './claude_config.js';
import { planCodexConfig } from './codex_config.js';
import { applyChangePlan, readTextFileIfExists, type ApplyResult } from './files.js';
import type { ChangePlan, InstallHost, InstallOptions } from './model.js';
import { resolveHostPaths } from './paths.js';

export type InstallRunOptions = InstallOptions & {
  home: string;
  cwd: string;
  commands: {
    mcpCommand: string;
    codexHookCommand: string;
    claudeHookCommand: string;
  };
  confirm?: (summary: string[]) => Promise<boolean>;
};

export async function installHost(options: InstallRunOptions): Promise<ApplyResult[]> {
  return applyHostPlans(options);
}

export async function uninstallHost(options: InstallRunOptions): Promise<ApplyResult[]> {
  return applyHostPlans(options);
}

export function targetHosts(target: InstallHost | 'all'): InstallHost[] {
  return target === 'all' ? ['codex', 'claude'] : [target];
}

async function applyHostPlans(options: InstallRunOptions): Promise<ApplyResult[]> {
  const plans = await createHostPlans(options);
  const changedPlans = plans.filter((plan) => plan.changed);

  if (changedPlans.length > 0 && !options.dryRun && !options.yes) {
    const confirmed = await (options.confirm ?? defaultConfirm)(
      changedPlans.flatMap((plan) => plan.summary),
    );
    if (!confirmed) {
      return [];
    }
  }

  const results: ApplyResult[] = [];
  for (const plan of plans) {
    results.push(await applyChangePlan(plan, { dryRun: options.dryRun }));
  }
  return results;
}

async function createHostPlans(options: InstallRunOptions): Promise<ChangePlan[]> {
  const paths = resolveHostPaths({
    home: options.home,
    cwd: options.cwd,
    scope: options.scope,
  });

  if (options.host === 'codex') {
    const before = await readTextFileIfExists(paths.codexConfigPath);
    return [
      planCodexConfig(before, {
        path: paths.codexConfigPath,
        action: options.action,
        parts: options.parts,
        serverUrl: options.serverUrl,
        commands: {
          mcpCommand: options.commands.mcpCommand,
          hookCommand: options.commands.codexHookCommand,
        },
      }),
    ];
  }

  const plans: ChangePlan[] = [];
  if (options.parts.has('mcp')) {
    const before = await readTextFileIfExists(paths.claudeMcpJsonPath);
    plans.push(planClaudeMcpJson(before, {
      path: paths.claudeMcpJsonPath,
      action: options.action,
      mcpCommand: options.commands.mcpCommand,
      serverUrl: options.serverUrl,
    }));
  }
  if (options.parts.has('hook')) {
    const before = await readTextFileIfExists(paths.claudeSettingsPath);
    plans.push(planClaudeSettings(before, {
      path: paths.claudeSettingsPath,
      action: options.action,
      hookCommand: options.commands.claudeHookCommand,
    }));
  }
  return plans;
}

async function defaultConfirm(summary: string[]): Promise<boolean> {
  if (summary.length > 0) {
    process.stdout.write(`${summary.join('\n')}\n`);
  }
  process.stdout.write('Proceed? [y/N] ');
  const answer = await new Promise<string>((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (chunk) => resolve(String(chunk)));
  });
  const normalized = answer.trim().toLowerCase();
  return normalized === 'y' || normalized === 'yes';
}
