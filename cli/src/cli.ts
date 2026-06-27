#!/usr/bin/env node
import { accessSync, constants as fsConstants, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './args.js';
import type { HostTarget } from './args.js';
import type { InstallPart } from './model.js';
import { installTargets, uninstallTargets } from './install.js';
import { readInstallStatus } from './status.js';
import { resolveCommand } from './bins.js';
import { resolveMuninnServerBaseUrl } from '@muninn/common';

const BIN_NAMES = {
  mcpCommand: 'muninn-mcp',
  codexHookCommand: 'muninn-codex-hook',
  claudeHookCommand: 'muninn-claude-hook',
} as const;

const BIN_PACKAGE_FALLBACKS = {
  mcpCommand: { packageName: '@muninn/mcp', binPath: 'dist/index.js' },
  codexHookCommand: { packageName: '@muninn/codex', binPath: 'dist/cli.js' },
  claudeHookCommand: { packageName: '@muninn/claude', binPath: 'dist/claude-cli.js' },
} as const;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    if (parsed.command === 'help') {
      process.stdout.write(helpText());
      return 0;
    }
    if (parsed.command === 'install' || parsed.command === 'uninstall') {
      const parts = installParts(parsed);
      const muninnHome = process.env.MUNINN_HOME ?? path.join(os.homedir(), '.muninn');
      const results = await (parsed.command === 'install' ? installTargets : uninstallTargets)({
        action: parsed.command,
        target: parsed.target,
        parts,
        scope: parsed.scope,
        serverUrl: parsed.serverUrl ?? resolveMuninnServerBaseUrl({ home: muninnHome }),
        dryRun: parsed.dryRun,
        yes: parsed.yes,
        home: os.homedir(),
        cwd: process.cwd(),
        commands: resolveInstallCommands({
          requireExecutable: parsed.command === 'install',
          target: parsed.target,
          parts,
        }),
      });
      for (const result of results) {
        for (const line of result.summary) {
          process.stdout.write(`${parsed.dryRun ? 'Would ' : ''}${line}\n`);
        }
      }
      return 0;
    }
    if (parsed.command === 'status') {
      const status = await readInstallStatus({
        home: os.homedir(),
        cwd: process.cwd(),
        scope: parsed.scope ?? 'user',
      });
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      return 0;
    }
    if (parsed.command === 'doctor') {
      const { renderDoctorChecks, runDoctorChecks } = await import('./doctor.js');
      const checks = await runDoctorChecks();
      process.stdout.write(renderDoctorChecks(checks));
      return checks.every((check) => check.ok || check.name === 'server health') ? 0 : 1;
    }
    if (parsed.command === 'run') {
      const { runServer } = await import('./run.js');
      await runServer({
        host: parsed.host,
        port: parsed.port,
        home: parsed.home,
      });
      return 0;
    }
    if (parsed.command === 'start') {
      const { startManagedServer } = await import('./server.js');
      const result = await startManagedServer({
        host: parsed.host,
        port: parsed.port,
        home: parsed.home,
        force: parsed.force,
      }, process.argv[1] ?? fileURLToPath(import.meta.url));
      process.stdout.write(`Muninn server started: http://${result.state.host}:${result.state.port}\n`);
      process.stdout.write(`Data home: ${result.state.home}\n`);
      process.stdout.write(`Logs: ${result.paths.stdoutLog}\n`);
      return 0;
    }
    if (parsed.command === 'stop') {
      const { stopManagedServer } = await import('./server.js');
      const result = await stopManagedServer({
        home: parsed.home,
        force: parsed.force,
      });
      process.stdout.write(`${result.message}\n`);
      return 0;
    }
    if (parsed.command === 'restart') {
      const { restartManagedServer } = await import('./server.js');
      const result = await restartManagedServer({
        host: parsed.host,
        port: parsed.port,
        home: parsed.home,
        force: parsed.force,
      }, process.argv[1] ?? fileURLToPath(import.meta.url));
      process.stdout.write(`Muninn server restarted: http://${result.state.host}:${result.state.port}\n`);
      process.stdout.write(`Data home: ${result.state.home}\n`);
      process.stdout.write(`Logs: ${result.paths.stdoutLog}\n`);
      return 0;
    }
    process.stdout.write(`muninn ${parsed.command} is not implemented yet\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write(helpText());
    return 1;
  }
}

function helpText(): string {
  return [
    'Usage:',
    '  muninn doctor',
    '  muninn run [--host 127.0.0.1] [--port 8080] [--home ~/.muninn]',
    '  muninn start [--host 127.0.0.1] [--port 8080] [--home ~/.muninn] [--force]',
    '  muninn stop [--home ~/.muninn] [--force]',
    '  muninn restart [--host 127.0.0.1] [--port 8080] [--home ~/.muninn] [--force]',
    '  muninn install codex|claude|all [--mcp-only|--hook-only] [--scope user|project] [--server-url URL] [--dry-run] [--yes]',
    '  muninn uninstall codex|claude|all [--mcp-only|--hook-only] [--scope user|project] [--server-url URL] [--dry-run] [--yes]',
    '  muninn status [--server-url URL] [--scope user|project]',
    '',
  ].join('\n');
}

function installParts(parsed: {
  mcpOnly: boolean;
  hookOnly: boolean;
}): Set<InstallPart> {
  if (parsed.mcpOnly) {
    return new Set(['mcp']);
  }
  if (parsed.hookOnly) {
    return new Set(['hook']);
  }
  return new Set(['mcp', 'hook']);
}

export function resolveInstallCommands(options: {
  requireExecutable?: boolean;
  target?: HostTarget | 'all';
  parts?: Set<InstallPart>;
  envPath?: string;
  access?: (candidate: string) => boolean;
} = {}): {
  mcpCommand: string;
  codexHookCommand: string;
  claudeHookCommand: string;
} {
  const extraBinDirs = packageBinDirs();
  const target = options.target ?? 'all';
  const targets = new Set(target === 'all' ? ['codex', 'claude'] : [target]);
  const parts = options.parts ?? new Set<InstallPart>(['mcp', 'hook']);
  const needsMcp = parts.has('mcp');
  const needsCodexHook = parts.has('hook') && targets.has('codex');
  const needsClaudeHook = parts.has('hook') && targets.has('claude');

  return {
    mcpCommand: resolveBin(BIN_NAMES.mcpCommand, extraBinDirs, BIN_PACKAGE_FALLBACKS.mcpCommand, {
      ...options,
      requireExecutable: options.requireExecutable && needsMcp,
    }),
    codexHookCommand: resolveBin(BIN_NAMES.codexHookCommand, extraBinDirs, BIN_PACKAGE_FALLBACKS.codexHookCommand, {
      ...options,
      requireExecutable: options.requireExecutable && needsCodexHook,
    }),
    claudeHookCommand: resolveBin(BIN_NAMES.claudeHookCommand, extraBinDirs, BIN_PACKAGE_FALLBACKS.claudeHookCommand, {
      ...options,
      requireExecutable: options.requireExecutable && needsClaudeHook,
    }),
  };
}

function resolveBin(
  name: string,
  extraBinDirs: string[],
  packageFallback: { packageName: string; binPath: string },
  options: {
    requireExecutable?: boolean;
    envPath?: string;
    access?: (candidate: string) => boolean;
  },
): string {
  const resolved = resolveCommand(name, {
    preferAbsolute: true,
    extraBinDirs,
    envPath: options.envPath,
    access: options.access,
  });
  if (!resolved.resolvedPath && options.requireExecutable) {
    const packageBin = resolvePackageBin(packageFallback);
    if (packageBin) {
      return packageBin;
    }
    throw new Error(`Unable to locate ${name}. Reinstall @muninn/cli and retry.`);
  }
  return resolved.command;
}

function packageBinDirs(): string[] {
  const entryDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.basename(entryDir) === 'dist' || path.basename(entryDir) === 'src'
    ? path.dirname(entryDir)
    : entryDir;
  return [path.join(packageRoot, 'node_modules', '.bin')];
}

function resolvePackageBin(fallback: { packageName: string; binPath: string }): string | null {
  const packageRoot = path.dirname(packageBinDirs()[0]);
  const candidate = path.join(packageRoot, fallback.packageName, fallback.binPath);
  try {
    accessSync(candidate, fsConstants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

function isMainModule(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  const modulePath = fileURLToPath(import.meta.url);
  const argvPath = path.resolve(process.argv[1]);
  if (path.basename(modulePath) === 'cli.js' && path.basename(argvPath) === 'muninn') {
    return true;
  }
  try {
    const moduleStat = statSync(modulePath);
    const argvStat = statSync(argvPath);
    if (moduleStat.dev === argvStat.dev && moduleStat.ino === argvStat.ino) {
      return true;
    }
  } catch {
    // Fall back to path comparisons below.
  }
  try {
    return realpathSync(modulePath) === realpathSync(argvPath);
  } catch {
    return modulePath === argvPath;
  }
}

if (isMainModule()) {
  main().then((code) => {
    process.exitCode = code;
  });
}
