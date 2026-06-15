import { planClaudeMcpJson, planClaudeSettings } from './claude-config.js';
import { planCodexConfig } from './codex-config.js';
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

export type InstallTargetsRunOptions = Omit<InstallRunOptions, 'host'> & {
  target: InstallHost | 'all';
};

export async function installHost(options: InstallRunOptions): Promise<ApplyResult[]> {
  return applyPlans(await createHostPlans(options), options);
}

export async function uninstallHost(options: InstallRunOptions): Promise<ApplyResult[]> {
  return applyPlans(await createHostPlans(options), options);
}

export async function installTargets(options: InstallTargetsRunOptions): Promise<ApplyResult[]> {
  return applyTargetPlans(options);
}

export async function uninstallTargets(options: InstallTargetsRunOptions): Promise<ApplyResult[]> {
  return applyTargetPlans(options);
}

export function targetHosts(target: InstallHost | 'all'): InstallHost[] {
  return target === 'all' ? ['codex', 'claude'] : [target];
}

async function applyTargetPlans(options: InstallTargetsRunOptions): Promise<ApplyResult[]> {
  const plans: ChangePlan[] = [];
  for (const host of targetHosts(options.target)) {
    plans.push(...await createHostPlans({ ...options, host }));
  }
  return applyPlans(plans, options);
}

async function applyPlans(
  plans: ChangePlan[],
  options: Pick<InstallRunOptions, 'dryRun' | 'yes' | 'confirm'>,
): Promise<ApplyResult[]> {
  const changedPlans = plans.filter((plan) => plan.changed);

  if (changedPlans.length > 0 && !options.dryRun && !options.yes) {
    const confirmed = await (options.confirm ?? defaultConfirm)(
      changedPlans.flatMap((plan) => plan.summary),
    );
    if (!confirmed) {
      return [];
    }
  }

  if (changedPlans.length > 0 && !options.dryRun) {
    await preflightPlans(changedPlans);
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

async function preflightPlans(plans: ChangePlan[]): Promise<void> {
  for (const plan of plans) {
    const current = await readTextFileIfExists(plan.path);
    if (current !== plan.before) {
      throw new Error(`Muninn config changed since this change was planned: ${plan.path}`);
    }
  }
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
