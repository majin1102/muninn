#!/usr/bin/env node
import { parseArgs } from './args.js';

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    if (parsed.command === 'help') {
      process.stdout.write(helpText());
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => {
    process.exitCode = code;
  });
}
