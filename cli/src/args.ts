export type Scope = 'user' | 'project';
export type HostTarget = 'codex' | 'claude' | 'all';

export type ParsedArgs =
  | { command: 'doctor' }
  | { command: 'status'; serverUrl?: string; scope?: Scope }
  | { command: 'serve'; host?: string; port?: number; home?: string }
  | {
      command: 'install' | 'uninstall';
      target: HostTarget;
      mcpOnly: boolean;
      hookOnly: boolean;
      scope: Scope;
      serverUrl: string;
      dryRun: boolean;
      yes: boolean;
    }
  | { command: 'help' };

const HOST_TARGETS = new Set(['codex', 'claude', 'all']);
const SCOPES = new Set(['user', 'project']);

export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return { command: 'help' };
  }
  if (command === 'doctor') {
    assertNoPositionals(command, rest);
    return { command: 'doctor' };
  }
  if (command === 'status') {
    const flags = parseFlags(rest);
    return {
      command: 'status',
      serverUrl: stringFlag(flags, 'server-url'),
      scope: scopeFlag(flags),
    };
  }
  if (command === 'serve') {
    const flags = parseFlags(rest);
    return {
      command: 'serve',
      host: stringFlag(flags, 'host'),
      port: numberFlag(flags, 'port'),
      home: stringFlag(flags, 'home'),
    };
  }
  if (command === 'install' || command === 'uninstall') {
    const [targetRaw, ...flagArgs] = rest;
    if (targetRaw === undefined || !HOST_TARGETS.has(targetRaw)) {
      throw new Error(`${command} target must be one of: codex, claude, all`);
    }
    const flags = parseFlags(flagArgs);
    const mcpOnly = booleanFlag(flags, 'mcp-only');
    const hookOnly = booleanFlag(flags, 'hook-only');
    if (mcpOnly && hookOnly) {
      throw new Error('--mcp-only and --hook-only cannot be used together');
    }
    return {
      command,
      target: targetRaw as HostTarget,
      mcpOnly,
      hookOnly,
      scope: scopeFlag(flags) ?? 'user',
      serverUrl: stringFlag(flags, 'server-url') ?? 'http://127.0.0.1:8080',
      dryRun: booleanFlag(flags, 'dry-run'),
      yes: booleanFlag(flags, 'yes'),
    };
  }
  throw new Error(`unknown command: ${command}`);
}

function parseFlags(args: string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      throw new Error(`unexpected positional argument: ${arg}`);
    }
    const name = arg.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith('--')) {
      flags.set(name, true);
      continue;
    }
    flags.set(name, next);
    index += 1;
  }
  return flags;
}

function assertNoPositionals(command: string, args: string[]): void {
  if (args.length > 0) {
    throw new Error(`${command} does not accept positional arguments`);
  }
}

function booleanFlag(flags: Map<string, string | true>, name: string): boolean {
  const value = flags.get(name);
  if (value === undefined) {
    return false;
  }
  if (value !== true) {
    throw new Error(`--${name} does not accept a value`);
  }
  return true;
}

function stringFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  if (value === undefined) {
    return undefined;
  }
  if (value === true) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

function numberFlag(flags: Map<string, string | true>, name: string): number | undefined {
  const raw = stringFlag(flags, name);
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

function scopeFlag(flags: Map<string, string | true>): Scope | undefined {
  const raw = stringFlag(flags, 'scope');
  if (raw === undefined) {
    return undefined;
  }
  if (!SCOPES.has(raw)) {
    throw new Error('--scope must be one of: user, project');
  }
  return raw as Scope;
}
