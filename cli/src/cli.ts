#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './args.js';
import type { InstallPart } from './model.js';
import { installTargets, uninstallTargets } from './install.js';
import { readInstallStatus } from './status.js';
import { resolveCommand } from './bins.js';

const BIN_NAMES = {
  mcpCommand: 'muninn-mcp',
  codexHookCommand: 'muninn-codex-hook',
  claudeHookCommand: 'muninn-claude-hook',
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
      const results = await (parsed.command === 'install' ? installTargets : uninstallTargets)({
        action: parsed.command,
        target: parsed.target,
        parts,
        scope: parsed.scope,
        serverUrl: parsed.serverUrl,
        dryRun: parsed.dryRun,
        yes: parsed.yes,
        home: os.homedir(),
        cwd: process.cwd(),
        commands: resolveInstallCommands({ requireExecutable: parsed.command === 'install' }),
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
    if (parsed.command === 'serve') {
      const { runServe } = await import('./serve.js');
      await runServe({
        host: parsed.host,
        port: parsed.port,
        home: parsed.home,
      });
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
    '  muninn serve [--host 127.0.0.1] [--port 8080] [--home ~/.muninn]',
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
} = {}): {
  mcpCommand: string;
  codexHookCommand: string;
  claudeHookCommand: string;
} {
  const extraBinDirs = packageBinDirs();
  return {
    mcpCommand: resolveBin(BIN_NAMES.mcpCommand, extraBinDirs, options),
    codexHookCommand: resolveBin(BIN_NAMES.codexHookCommand, extraBinDirs, options),
    claudeHookCommand: resolveBin(BIN_NAMES.claudeHookCommand, extraBinDirs, options),
  };
}

function resolveBin(
  name: string,
  extraBinDirs: string[],
  options: { requireExecutable?: boolean },
): string {
  const resolved = resolveCommand(name, {
    preferAbsolute: true,
    extraBinDirs,
  });
  if (!resolved.resolvedPath && options.requireExecutable) {
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

function isMainModule(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  }
}

if (isMainModule()) {
  main().then((code) => {
    process.exitCode = code;
  });
}
