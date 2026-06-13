#!/usr/bin/env node
import os from 'node:os';
import { parseArgs } from './args.js';
import type { InstallPart } from './model.js';
import { installTargets, uninstallTargets } from './install.js';
import { readInstallStatus } from './status.js';

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
        commands: {
          mcpCommand: 'muninn-mcp',
          codexHookCommand: 'muninn-codex-hook',
          claudeHookCommand: 'muninn-claude-hook',
        },
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => {
    process.exitCode = code;
  });
}
