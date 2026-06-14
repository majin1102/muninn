# Muninn CLI Install Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first macOS/Linux npm CLI release path for starting Muninn and installing Codex/Claude MCP plus Stop hook integrations.

**Architecture:** Add a new `@muninn/cli` package with pure planning modules for host config changes, a small command dispatcher, and filesystem adapters for dry-run/backup/write flows. Keep `@muninn/mcp` as a protocol adapter used by host-specific install commands, and expose `@muninn/server` through a reusable `startServer` API plus a `muninn-server` bin so `muninn serve` does not depend on workspace commands.

**Tech Stack:** TypeScript NodeNext, Node.js `node:test`, Node standard library, existing pnpm workspace, existing Hono server runtime, existing Codex/Claude/MCP packages.

---

## File Structure

Create:

- `cli/package.json` - publishable CLI package metadata and scripts.
- `cli/tsconfig.json` - NodeNext TypeScript build config.
- `cli/src/cli.ts` - bin entrypoint and top-level command dispatch.
- `cli/src/args.ts` - dependency-free argument parser.
- `cli/src/model.ts` - shared command, install, planner, and status types.
- `cli/src/paths.ts` - host config path resolution from `HOME`, cwd, and scope.
- `cli/src/bins.ts` - command/path resolution and command rendering.
- `cli/src/codex_config.ts` - pure Codex TOML planner for install/uninstall.
- `cli/src/claude_config.ts` - pure Claude settings and MCP planner.
- `cli/src/files.ts` - read/write/backup adapter for config files.
- `cli/src/install.ts` - install/uninstall orchestration.
- `cli/src/doctor.ts` - environment and dependency checks.
- `cli/src/status.ts` - host config and server status checks.
- `cli/src/serve.ts` - foreground server startup command.
- `cli/test/args.test.mjs` - CLI parser tests.
- `cli/test/paths-bins.test.mjs` - path and bin resolution tests.
- `cli/test/codex-config.test.mjs` - Codex config planner tests.
- `cli/test/claude-config.test.mjs` - Claude config planner tests.
- `cli/test/files.test.mjs` - backup/write tests under temporary directories.
- `cli/test/install-status.test.mjs` - install/status orchestration tests with temporary HOME.
- `cli/README.md` - package-level install and usage docs.

Modify:

- `pnpm-workspace.yaml` - add `cli`.
- `package.json` - add build/test convenience scripts for CLI if needed.
- `server/package.json` - add publish-safe metadata, `bin`, `files`, and `postinstall`/native build behavior.
- `server/src/index.ts` - export `startServer` and keep direct process startup behavior.
- `mcp/package.json` - publish-safe metadata for `muninn-mcp`.
- `codex/package.json` - publish-safe metadata for `muninn-codex-hook`.
- `claude/package.json` - publish-safe metadata for `muninn-claude-hook`.
- `common/package.json` - publish-safe metadata for shared exports.
- `README.md` - top-level first-release install path.

Do not create:

- `muninn install mcp`.
- Service/daemon commands.
- Background updater commands.
- Windows support files.

---

### Task 1: Add CLI Package Skeleton and Argument Parser

**Files:**
- Create: `cli/package.json`
- Create: `cli/tsconfig.json`
- Create: `cli/src/cli.ts`
- Create: `cli/src/args.ts`
- Create: `cli/test/args.test.mjs`
- Modify: `pnpm-workspace.yaml`

- [ ] **Step 1: Write failing parser tests**

Create `cli/test/args.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs } from '../dist/args.js';

test('parseArgs parses serve defaults and flags', () => {
  assert.deepEqual(parseArgs(['serve']), {
    command: 'serve',
    host: undefined,
    port: undefined,
    home: undefined,
  });
  assert.deepEqual(parseArgs(['serve', '--host', '127.0.0.1', '--port', '8081', '--home', '/tmp/muninn']), {
    command: 'serve',
    host: '127.0.0.1',
    port: 8081,
    home: '/tmp/muninn',
  });
});

test('parseArgs parses install target and common flags', () => {
  assert.deepEqual(parseArgs([
    'install',
    'codex',
    '--mcp-only',
    '--scope',
    'project',
    '--server-url',
    'http://127.0.0.1:8081',
    '--dry-run',
  ]), {
    command: 'install',
    target: 'codex',
    mcpOnly: true,
    hookOnly: false,
    scope: 'project',
    serverUrl: 'http://127.0.0.1:8081',
    dryRun: true,
    yes: false,
  });
});

test('parseArgs rejects mcp as install target', () => {
  assert.throws(
    () => parseArgs(['install', 'mcp']),
    /install target must be one of: codex, claude, all/,
  );
});

test('parseArgs rejects conflicting install part flags', () => {
  assert.throws(
    () => parseArgs(['install', 'all', '--mcp-only', '--hook-only']),
    /--mcp-only and --hook-only cannot be used together/,
  );
});
```

- [ ] **Step 2: Add CLI package metadata**

Create `cli/package.json`:

```json
{
  "name": "@muninn/cli",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "muninn": "./dist/cli.js"
  },
  "exports": {
    ".": {
      "types": "./dist/cli.d.ts",
      "default": "./dist/cli.js"
    }
  },
  "files": [
    "dist",
    "README.md"
  ],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsc -p tsconfig.json --watch",
    "test": "pnpm build && node --test test/*.test.mjs"
  },
  "dependencies": {
    "@muninn/claude": "workspace:*",
    "@muninn/codex": "workspace:*",
    "@muninn/common": "workspace:*",
    "@muninn/mcp": "workspace:*",
    "@muninn/server": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.0.0"
  }
}
```

Create `cli/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

Modify `pnpm-workspace.yaml` to include `cli`:

```yaml
packages:
  - 'common'
  - 'web'
  - 'server'
  - 'mcp'
  - 'codex'
  - 'claude'
  - 'cli'
  - 'benchmark/*'
```

- [ ] **Step 3: Implement parser**

Create `cli/src/args.ts`:

```ts
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
    if (!HOST_TARGETS.has(targetRaw)) {
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
```

Create `cli/src/cli.ts`:

```ts
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
```

- [ ] **Step 4: Run parser tests and verify they pass**

Run:

```sh
source ~/.zprofile && pnpm --filter @muninn/cli test
```

Expected: all tests in `cli/test/args.test.mjs` pass.

- [ ] **Step 5: Commit**

```sh
git add pnpm-workspace.yaml cli/package.json cli/tsconfig.json cli/src/cli.ts cli/src/args.ts cli/test/args.test.mjs
git commit -m "feat: add muninn cli package"
```

---

### Task 2: Add Shared CLI Models, Paths, and Bin Resolution

**Files:**
- Create: `cli/src/model.ts`
- Create: `cli/src/paths.ts`
- Create: `cli/src/bins.ts`
- Create: `cli/test/paths-bins.test.mjs`

- [ ] **Step 1: Write failing path and bin tests**

Create `cli/test/paths-bins.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { resolveHostPaths } from '../dist/paths.js';
import { renderCommand, resolveCommand } from '../dist/bins.js';

test('resolveHostPaths returns user config paths', () => {
  const paths = resolveHostPaths({
    home: '/Users/dev',
    cwd: '/Users/dev/workspace/project',
    scope: 'user',
  });

  assert.equal(paths.codexConfigPath, path.join('/Users/dev', '.codex', 'config.toml'));
  assert.equal(paths.claudeSettingsPath, path.join('/Users/dev', '.claude', 'settings.json'));
  assert.equal(paths.claudeMcpJsonPath, path.join('/Users/dev', '.claude.json'));
});

test('resolveHostPaths returns project config paths', () => {
  const paths = resolveHostPaths({
    home: '/Users/dev',
    cwd: '/Users/dev/workspace/project',
    scope: 'project',
  });

  assert.equal(paths.codexConfigPath, path.join('/Users/dev/workspace/project', '.codex', 'config.toml'));
  assert.equal(paths.claudeSettingsPath, path.join('/Users/dev/workspace/project', '.claude', 'settings.json'));
  assert.equal(paths.claudeMcpJsonPath, path.join('/Users/dev/workspace/project', '.mcp.json'));
});

test('resolveCommand prefers stable command name when available', () => {
  const resolved = resolveCommand('muninn-mcp', {
    envPath: '/usr/local/bin:/opt/bin',
    access: (candidate) => candidate === '/usr/local/bin/muninn-mcp',
  });

  assert.deepEqual(resolved, {
    command: 'muninn-mcp',
    resolvedPath: '/usr/local/bin/muninn-mcp',
    isAbsolute: false,
  });
});

test('resolveCommand falls back to absolute path when requested', () => {
  const resolved = resolveCommand('muninn-codex-hook', {
    preferAbsolute: true,
    envPath: '/usr/local/bin',
    access: (candidate) => candidate === '/usr/local/bin/muninn-codex-hook',
  });

  assert.deepEqual(resolved, {
    command: '/usr/local/bin/muninn-codex-hook',
    resolvedPath: '/usr/local/bin/muninn-codex-hook',
    isAbsolute: true,
  });
});

test('renderCommand quotes commands with spaces', () => {
  assert.equal(renderCommand('/Applications/Muninn Tools/muninn-mcp'), '"/Applications/Muninn Tools/muninn-mcp"');
  assert.equal(renderCommand('muninn-mcp'), 'muninn-mcp');
});
```

- [ ] **Step 2: Implement models**

Create `cli/src/model.ts`:

```ts
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
```

- [ ] **Step 3: Implement paths**

Create `cli/src/paths.ts`:

```ts
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
```

- [ ] **Step 4: Implement bin resolution**

Create `cli/src/bins.ts`:

```ts
import { accessSync, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import type { ResolvedCommand } from './model.js';

export function resolveCommand(name: string, options: {
  preferAbsolute?: boolean;
  envPath?: string;
  access?: (candidate: string) => boolean;
} = {}): ResolvedCommand {
  const envPath = options.envPath ?? process.env.PATH ?? '';
  const access = options.access ?? canExecute;
  const resolvedPath = findOnPath(name, envPath, access);
  if (!resolvedPath) {
    return {
      command: name,
      resolvedPath: null,
      isAbsolute: false,
    };
  }
  if (options.preferAbsolute) {
    return {
      command: resolvedPath,
      resolvedPath,
      isAbsolute: true,
    };
  }
  return {
    command: name,
    resolvedPath,
    isAbsolute: false,
  };
}

export function renderCommand(command: string): string {
  if (/[\s"']/u.test(command)) {
    return JSON.stringify(command);
  }
  return command;
}

function findOnPath(name: string, envPath: string, access: (candidate: string) => boolean): string | null {
  if (path.isAbsolute(name)) {
    return access(name) ? name : null;
  }
  for (const segment of envPath.split(path.delimiter)) {
    if (!segment) {
      continue;
    }
    const candidate = path.join(segment, name);
    if (access(candidate)) {
      return candidate;
    }
  }
  return null;
}

function canExecute(candidate: string): boolean {
  try {
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Run tests**

Run:

```sh
source ~/.zprofile && pnpm --filter @muninn/cli test
```

Expected: parser, path, and bin tests pass.

- [ ] **Step 6: Commit**

```sh
git add cli/src/model.ts cli/src/paths.ts cli/src/bins.ts cli/test/paths-bins.test.mjs
git commit -m "feat: add cli install planning primitives"
```

---

### Task 3: Add Codex Config Planner

**Files:**
- Create: `cli/src/codex_config.ts`
- Create: `cli/test/codex-config.test.mjs`

- [ ] **Step 1: Write failing Codex planner tests**

Create `cli/test/codex-config.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { planCodexConfig } from '../dist/codex_config.js';

const commands = {
  mcpCommand: 'muninn-mcp',
  hookCommand: 'muninn-codex-hook',
};

test('planCodexConfig installs mcp and hook into empty config', () => {
  const plan = planCodexConfig('', {
    path: '/home/dev/.codex/config.toml',
    action: 'install',
    parts: new Set(['mcp', 'hook']),
    serverUrl: 'http://127.0.0.1:8080',
    commands,
  });

  assert.equal(plan.changed, true);
  assert.match(plan.after, /\[mcp_servers\.muninn\]/);
  assert.match(plan.after, /command = "muninn-mcp"/);
  assert.match(plan.after, /MUNINN_SERVER_BASE_URL = "http:\/\/127\.0\.0\.1:8080"/);
  assert.match(plan.after, /\[\[hooks\.Stop\]\]/);
  assert.match(plan.after, /command = "muninn-codex-hook"/);
  assert.match(plan.after, /statusMessage = "Syncing turn to Muninn"/);
});

test('planCodexConfig updates existing muninn mcp without duplicating it', () => {
  const before = [
    '[mcp_servers.muninn]',
    'command = "old-muninn-mcp"',
    'env = { MUNINN_SERVER_BASE_URL = "http://127.0.0.1:9999" }',
    '',
    '[mcp_servers.context7]',
    'command = "npx"',
    'args = ["-y", "@upstash/context7-mcp"]',
    '',
  ].join('\n');

  const plan = planCodexConfig(before, {
    path: '/home/dev/.codex/config.toml',
    action: 'install',
    parts: new Set(['mcp']),
    serverUrl: 'http://127.0.0.1:8081',
    commands,
  });

  assert.equal((plan.after.match(/\[mcp_servers\.muninn\]/g) ?? []).length, 1);
  assert.match(plan.after, /MUNINN_SERVER_BASE_URL = "http:\/\/127\.0\.0\.1:8081"/);
  assert.match(plan.after, /\[mcp_servers\.context7\]/);
});

test('planCodexConfig does not remove unrelated Stop hooks', () => {
  const before = [
    '[[hooks.Stop]]',
    '[[hooks.Stop.hooks]]',
    'type = "command"',
    'command = "python3 ./existing.py"',
    'timeout = 10',
    '',
  ].join('\n');

  const plan = planCodexConfig(before, {
    path: '/home/dev/.codex/config.toml',
    action: 'install',
    parts: new Set(['hook']),
    serverUrl: 'http://127.0.0.1:8080',
    commands,
  });

  assert.match(plan.after, /command = "python3 \.\/existing.py"/);
  assert.equal((plan.after.match(/muninn-codex-hook/g) ?? []).length, 1);
});

test('planCodexConfig uninstall removes only muninn entries', () => {
  const installed = planCodexConfig('', {
    path: '/home/dev/.codex/config.toml',
    action: 'install',
    parts: new Set(['mcp', 'hook']),
    serverUrl: 'http://127.0.0.1:8080',
    commands,
  }).after + [
    '',
    '[mcp_servers.context7]',
    'command = "npx"',
    '',
  ].join('\n');

  const plan = planCodexConfig(installed, {
    path: '/home/dev/.codex/config.toml',
    action: 'uninstall',
    parts: new Set(['mcp', 'hook']),
    serverUrl: 'http://127.0.0.1:8080',
    commands,
  });

  assert.equal(plan.changed, true);
  assert.doesNotMatch(plan.after, /\[mcp_servers\.muninn\]/);
  assert.doesNotMatch(plan.after, /muninn-codex-hook/);
  assert.match(plan.after, /\[mcp_servers\.context7\]/);
});
```

- [ ] **Step 2: Implement Codex planner**

Create `cli/src/codex_config.ts`:

```ts
import type { ChangePlan, InstallPart, PlanAction } from './model.js';

export type CodexConfigPlanOptions = {
  path: string;
  action: PlanAction;
  parts: Set<InstallPart>;
  serverUrl: string;
  commands: {
    mcpCommand: string;
    hookCommand: string;
  };
};

export function planCodexConfig(before: string, options: CodexConfigPlanOptions): ChangePlan {
  let after = normalizeTrailingNewline(before);
  const summary: string[] = [];

  if (options.parts.has('mcp')) {
    const withoutMcp = removeMcpServer(after);
    if (options.action === 'install') {
      after = appendSection(withoutMcp, renderMcpServer(options.commands.mcpCommand, options.serverUrl));
      summary.push('Configure Codex MCP server: muninn');
    } else {
      after = withoutMcp;
      summary.push('Remove Codex MCP server: muninn');
    }
  }

  if (options.parts.has('hook')) {
    const withoutHook = removeMuninnStopHooks(after, options.commands.hookCommand);
    if (options.action === 'install') {
      after = appendSection(withoutHook, renderStopHook(options.commands.hookCommand));
      summary.push('Configure Codex Stop hook: muninn-codex-hook');
    } else {
      after = withoutHook;
      summary.push('Remove Codex Stop hook: muninn-codex-hook');
    }
  }

  after = normalizeTrailingNewline(after);

  return {
    changed: before !== after,
    path: options.path,
    before,
    after,
    summary,
  };
}

function renderMcpServer(command: string, serverUrl: string): string {
  return [
    '[mcp_servers.muninn]',
    `command = ${tomlString(command)}`,
    `env = { MUNINN_SERVER_BASE_URL = ${tomlString(serverUrl)} }`,
  ].join('\n');
}

function renderStopHook(command: string): string {
  return [
    '[[hooks.Stop]]',
    '[[hooks.Stop.hooks]]',
    'type = "command"',
    `command = ${tomlString(command)}`,
    'timeout = 30',
    'statusMessage = "Syncing turn to Muninn"',
  ].join('\n');
}

function removeMcpServer(input: string): string {
  const lines = input.split('\n');
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    if (lines[index].trim() === '[mcp_servers.muninn]') {
      index += 1;
      while (index < lines.length && !isTomlTableHeader(lines[index])) {
        index += 1;
      }
      continue;
    }
    output.push(lines[index]);
    index += 1;
  }
  return compactBlankLines(output.join('\n'));
}

function removeMuninnStopHooks(input: string, hookCommand: string): string {
  const lines = input.split('\n');
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    if (lines[index].trim() === '[[hooks.Stop]]') {
      const block: string[] = [];
      block.push(lines[index]);
      index += 1;
      while (index < lines.length && lines[index].trim() !== '[[hooks.Stop]]') {
        block.push(lines[index]);
        index += 1;
      }
      const text = block.join('\n');
      if (text.includes(hookCommand) || text.includes('muninn-codex-hook')) {
        continue;
      }
      output.push(...block);
      continue;
    }
    output.push(lines[index]);
    index += 1;
  }
  return compactBlankLines(output.join('\n'));
}

function appendSection(input: string, section: string): string {
  const trimmed = input.trimEnd();
  if (!trimmed) {
    return `${section}\n`;
  }
  return `${trimmed}\n\n${section}\n`;
}

function isTomlTableHeader(line: string): boolean {
  return /^\s*\[/.test(line);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function normalizeTrailingNewline(input: string): string {
  return input.trimEnd() ? `${input.trimEnd()}\n` : '';
}

function compactBlankLines(input: string): string {
  return input.replace(/\n{3,}/g, '\n\n');
}
```

- [ ] **Step 3: Run Codex planner tests**

Run:

```sh
source ~/.zprofile && pnpm --filter @muninn/cli test
```

Expected: Codex tests pass with existing parser/path tests.

- [ ] **Step 4: Commit**

```sh
git add cli/src/codex_config.ts cli/test/codex-config.test.mjs
git commit -m "feat: plan codex integration config"
```

---

### Task 4: Add Claude Settings and MCP Planner

**Files:**
- Create: `cli/src/claude_config.ts`
- Create: `cli/test/claude-config.test.mjs`

- [ ] **Step 1: Write failing Claude planner tests**

Create `cli/test/claude-config.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planClaudeMcpJson,
  planClaudeSettings,
  renderClaudeMcpAddCommand,
} from '../dist/claude_config.js';

test('planClaudeSettings installs Stop hook into empty settings', () => {
  const plan = planClaudeSettings('', {
    path: '/home/dev/.claude/settings.json',
    action: 'install',
    hookCommand: 'muninn-claude-hook',
  });

  assert.equal(plan.changed, true);
  const parsed = JSON.parse(plan.after);
  assert.equal(parsed.hooks.Stop[0].hooks[0].type, 'command');
  assert.equal(parsed.hooks.Stop[0].hooks[0].command, 'muninn-claude-hook');
  assert.equal(parsed.hooks.Stop[0].hooks[0].timeout, 30);
});

test('planClaudeSettings preserves unrelated hooks', () => {
  const before = JSON.stringify({
    hooks: {
      Stop: [
        { hooks: [{ type: 'command', command: 'python3 ./existing.py', timeout: 10 }] },
      ],
    },
  }, null, 2);

  const plan = planClaudeSettings(before, {
    path: '/home/dev/.claude/settings.json',
    action: 'install',
    hookCommand: 'muninn-claude-hook',
  });

  const parsed = JSON.parse(plan.after);
  assert.equal(parsed.hooks.Stop.length, 2);
  assert.equal(parsed.hooks.Stop[0].hooks[0].command, 'python3 ./existing.py');
  assert.equal(parsed.hooks.Stop[1].hooks[0].command, 'muninn-claude-hook');
});

test('planClaudeSettings uninstall removes only muninn hook', () => {
  const installed = planClaudeSettings('', {
    path: '/home/dev/.claude/settings.json',
    action: 'install',
    hookCommand: 'muninn-claude-hook',
  }).after;

  const plan = planClaudeSettings(installed, {
    path: '/home/dev/.claude/settings.json',
    action: 'uninstall',
    hookCommand: 'muninn-claude-hook',
  });

  assert.equal(plan.changed, true);
  assert.doesNotMatch(plan.after, /muninn-claude-hook/);
});

test('planClaudeMcpJson installs stdio muninn server', () => {
  const plan = planClaudeMcpJson('', {
    path: '/home/dev/.mcp.json',
    action: 'install',
    mcpCommand: 'muninn-mcp',
    serverUrl: 'http://127.0.0.1:8080',
  });

  const parsed = JSON.parse(plan.after);
  assert.deepEqual(parsed.mcpServers.muninn, {
    type: 'stdio',
    command: 'muninn-mcp',
    env: {
      MUNINN_SERVER_BASE_URL: 'http://127.0.0.1:8080',
    },
  });
});

test('renderClaudeMcpAddCommand renders a user scoped stdio command', () => {
  assert.deepEqual(renderClaudeMcpAddCommand({
    scope: 'user',
    mcpCommand: 'muninn-mcp',
    serverUrl: 'http://127.0.0.1:8080',
  }), [
    'claude',
    'mcp',
    'add',
    '--scope',
    'user',
    '--transport',
    'stdio',
    'muninn',
    '--env',
    'MUNINN_SERVER_BASE_URL=http://127.0.0.1:8080',
    '--',
    'muninn-mcp',
  ]);
});
```

- [ ] **Step 2: Implement Claude planner**

Create `cli/src/claude_config.ts`:

```ts
import type { Scope } from './args.js';
import type { ChangePlan, PlanAction } from './model.js';

type JsonObject = Record<string, any>;

export function planClaudeSettings(before: string, options: {
  path: string;
  action: PlanAction;
  hookCommand: string;
}): ChangePlan {
  const settings = parseJsonObject(before);
  const hooks = objectValue(settings, 'hooks');
  const stop = Array.isArray(hooks.Stop) ? hooks.Stop : [];
  const filtered = stop.filter((entry) => !entryContainsCommand(entry, options.hookCommand) && !entryContainsCommand(entry, 'muninn-claude-hook'));

  if (options.action === 'install') {
    filtered.push({
      hooks: [
        {
          type: 'command',
          command: options.hookCommand,
          timeout: 30,
        },
      ],
    });
  }

  hooks.Stop = filtered;
  settings.hooks = hooks;

  const after = `${JSON.stringify(settings, null, 2)}\n`;
  return {
    changed: before !== after,
    path: options.path,
    before,
    after,
    summary: [
      options.action === 'install'
        ? 'Configure Claude Code Stop hook: muninn-claude-hook'
        : 'Remove Claude Code Stop hook: muninn-claude-hook',
    ],
  };
}

export function planClaudeMcpJson(before: string, options: {
  path: string;
  action: PlanAction;
  mcpCommand: string;
  serverUrl: string;
}): ChangePlan {
  const config = parseJsonObject(before);
  const mcpServers = objectValue(config, 'mcpServers');
  delete mcpServers.muninn;

  if (options.action === 'install') {
    mcpServers.muninn = {
      type: 'stdio',
      command: options.mcpCommand,
      env: {
        MUNINN_SERVER_BASE_URL: options.serverUrl,
      },
    };
  }

  config.mcpServers = mcpServers;
  const after = `${JSON.stringify(config, null, 2)}\n`;
  return {
    changed: before !== after,
    path: options.path,
    before,
    after,
    summary: [
      options.action === 'install'
        ? 'Configure Claude Code MCP server: muninn'
        : 'Remove Claude Code MCP server: muninn',
    ],
  };
}

export function renderClaudeMcpAddCommand(options: {
  scope: Scope;
  mcpCommand: string;
  serverUrl: string;
}): string[] {
  return [
    'claude',
    'mcp',
    'add',
    '--scope',
    options.scope,
    '--transport',
    'stdio',
    'muninn',
    '--env',
    `MUNINN_SERVER_BASE_URL=${options.serverUrl}`,
    '--',
    options.mcpCommand,
  ];
}

function parseJsonObject(input: string): JsonObject {
  if (!input.trim()) {
    return {};
  }
  const parsed = JSON.parse(input);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Claude configuration must be a JSON object');
  }
  return parsed;
}

function objectValue(parent: JsonObject, key: string): JsonObject {
  const value = parent[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function entryContainsCommand(entry: unknown, command: string): boolean {
  if (!entry || typeof entry !== 'object') {
    return false;
  }
  const hooks = (entry as { hooks?: unknown }).hooks;
  if (!Array.isArray(hooks)) {
    return false;
  }
  return hooks.some((hook) => {
    return !!hook
      && typeof hook === 'object'
      && String((hook as { command?: unknown }).command ?? '').includes(command);
  });
}
```

- [ ] **Step 3: Run Claude planner tests**

Run:

```sh
source ~/.zprofile && pnpm --filter @muninn/cli test
```

Expected: Claude, Codex, parser, path, and bin tests pass.

- [ ] **Step 4: Commit**

```sh
git add cli/src/claude_config.ts cli/test/claude-config.test.mjs
git commit -m "feat: plan claude integration config"
```

---

### Task 5: Add Config File Backup and Write Adapter

**Files:**
- Create: `cli/src/files.ts`
- Create: `cli/test/files.test.mjs`

- [ ] **Step 1: Write failing file adapter tests**

Create `cli/test/files.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { applyChangePlan, readTextFileIfExists } from '../dist/files.js';

test('readTextFileIfExists returns empty string for missing files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muninn-files-'));
  assert.equal(await readTextFileIfExists(path.join(root, 'missing.txt')), '');
});

test('applyChangePlan dry-run does not write files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muninn-files-'));
  const file = path.join(root, 'config.toml');
  await writeFile(file, 'before\n');

  const result = await applyChangePlan({
    changed: true,
    path: file,
    before: 'before\n',
    after: 'after\n',
    summary: ['change file'],
  }, {
    dryRun: true,
    now: () => new Date('2026-06-14T03:00:00.000Z'),
  });

  assert.equal(result.wrote, false);
  assert.equal(result.backupPath, null);
  assert.equal(await readFile(file, 'utf8'), 'before\n');
});

test('applyChangePlan writes backup before replacing content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muninn-files-'));
  const file = path.join(root, 'config.toml');
  await writeFile(file, 'before\n');

  const result = await applyChangePlan({
    changed: true,
    path: file,
    before: 'before\n',
    after: 'after\n',
    summary: ['change file'],
  }, {
    dryRun: false,
    now: () => new Date('2026-06-14T03:00:00.000Z'),
  });

  assert.equal(result.wrote, true);
  assert.match(result.backupPath, /config\.toml\.muninn-backup-20260614-030000$/);
  assert.equal(await readFile(result.backupPath, 'utf8'), 'before\n');
  assert.equal(await readFile(file, 'utf8'), 'after\n');
});
```

- [ ] **Step 2: Implement file adapter**

Create `cli/src/files.ts`:

```ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChangePlan } from './model.js';

export type ApplyResult = {
  wrote: boolean;
  backupPath: string | null;
  summary: string[];
};

export async function readTextFileIfExists(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

export async function applyChangePlan(plan: ChangePlan, options: {
  dryRun: boolean;
  now?: () => Date;
}): Promise<ApplyResult> {
  if (!plan.changed) {
    return {
      wrote: false,
      backupPath: null,
      summary: plan.summary,
    };
  }

  if (options.dryRun) {
    return {
      wrote: false,
      backupPath: null,
      summary: plan.summary,
    };
  }

  await mkdir(path.dirname(plan.path), { recursive: true });
  const backupPath = backupFilePath(plan.path, options.now?.() ?? new Date());
  if (plan.before) {
    await writeFile(backupPath, plan.before, 'utf8');
  }

  const tempPath = `${plan.path}.muninn-tmp-${process.pid}`;
  await writeFile(tempPath, plan.after, 'utf8');
  await rename(tempPath, plan.path);

  return {
    wrote: true,
    backupPath: plan.before ? backupPath : null,
    summary: plan.summary,
  };
}

function backupFilePath(filePath: string, date: Date): string {
  const stamp = date.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, '')
    .replace('T', '-');
  return `${filePath}.muninn-backup-${stamp}`;
}
```

- [ ] **Step 3: Run file tests**

Run:

```sh
source ~/.zprofile && pnpm --filter @muninn/cli test
```

Expected: file adapter tests pass with previous CLI tests.

- [ ] **Step 4: Commit**

```sh
git add cli/src/files.ts cli/test/files.test.mjs
git commit -m "feat: add cli config file writes"
```

---

### Task 6: Wire Install, Uninstall, and Status Orchestration

**Files:**
- Create: `cli/src/install.ts`
- Create: `cli/src/status.ts`
- Create: `cli/test/install-status.test.mjs`
- Modify: `cli/src/cli.ts`

- [ ] **Step 1: Write failing install/status tests**

Create `cli/test/install-status.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { installHost, uninstallHost } from '../dist/install.js';
import { readInstallStatus } from '../dist/status.js';

test('installHost writes Codex config under temporary user HOME', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muninn-install-'));
  const result = await installHost({
    host: 'codex',
    action: 'install',
    parts: new Set(['mcp', 'hook']),
    scope: 'user',
    serverUrl: 'http://127.0.0.1:8080',
    dryRun: false,
    yes: true,
    home: root,
    cwd: path.join(root, 'project'),
    commands: {
      mcpCommand: 'muninn-mcp',
      codexHookCommand: 'muninn-codex-hook',
      claudeHookCommand: 'muninn-claude-hook',
    },
  });

  assert.equal(result.length, 1);
  const config = await readFile(path.join(root, '.codex', 'config.toml'), 'utf8');
  assert.match(config, /\[mcp_servers\.muninn\]/);
  assert.match(config, /muninn-codex-hook/);
});

test('installHost asks for confirmation when not dry-run and --yes is absent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muninn-confirm-'));
  let asked = 0;

  await installHost({
    host: 'codex',
    action: 'install',
    parts: new Set(['mcp']),
    scope: 'user',
    serverUrl: 'http://127.0.0.1:8080',
    dryRun: false,
    yes: false,
    home: root,
    cwd: path.join(root, 'project'),
    commands: {
      mcpCommand: 'muninn-mcp',
      codexHookCommand: 'muninn-codex-hook',
      claudeHookCommand: 'muninn-claude-hook',
    },
    confirm: async () => {
      asked += 1;
      return true;
    },
  });

  assert.equal(asked, 1);
  const config = await readFile(path.join(root, '.codex', 'config.toml'), 'utf8');
  assert.match(config, /\[mcp_servers\.muninn\]/);
});

test('installHost skips writes when confirmation is denied', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muninn-confirm-denied-'));

  const result = await installHost({
    host: 'codex',
    action: 'install',
    parts: new Set(['mcp']),
    scope: 'user',
    serverUrl: 'http://127.0.0.1:8080',
    dryRun: false,
    yes: false,
    home: root,
    cwd: path.join(root, 'project'),
    commands: {
      mcpCommand: 'muninn-mcp',
      codexHookCommand: 'muninn-codex-hook',
      claudeHookCommand: 'muninn-claude-hook',
    },
    confirm: async () => false,
  });

  assert.deepEqual(result, []);
});

test('uninstallHost removes Codex muninn entries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muninn-uninstall-'));
  const cwd = path.join(root, 'project');
  const commands = {
    mcpCommand: 'muninn-mcp',
    codexHookCommand: 'muninn-codex-hook',
    claudeHookCommand: 'muninn-claude-hook',
  };
  await installHost({
    host: 'codex',
    action: 'install',
    parts: new Set(['mcp', 'hook']),
    scope: 'user',
    serverUrl: 'http://127.0.0.1:8080',
    dryRun: false,
    yes: true,
    home: root,
    cwd,
    commands,
  });
  await uninstallHost({
    host: 'codex',
    action: 'uninstall',
    parts: new Set(['mcp', 'hook']),
    scope: 'user',
    serverUrl: 'http://127.0.0.1:8080',
    dryRun: false,
    yes: true,
    home: root,
    cwd,
    commands,
  });

  const config = await readFile(path.join(root, '.codex', 'config.toml'), 'utf8');
  assert.doesNotMatch(config, /mcp_servers\.muninn/);
  assert.doesNotMatch(config, /muninn-codex-hook/);
});

test('readInstallStatus detects installed Codex and Claude entries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muninn-status-'));
  const cwd = path.join(root, 'project');
  const commands = {
    mcpCommand: 'muninn-mcp',
    codexHookCommand: 'muninn-codex-hook',
    claudeHookCommand: 'muninn-claude-hook',
  };
  await installHost({
    host: 'codex',
    action: 'install',
    parts: new Set(['mcp', 'hook']),
    scope: 'user',
    serverUrl: 'http://127.0.0.1:8080',
    dryRun: false,
    yes: true,
    home: root,
    cwd,
    commands,
  });
  await installHost({
    host: 'claude',
    action: 'install',
    parts: new Set(['mcp', 'hook']),
    scope: 'user',
    serverUrl: 'http://127.0.0.1:8080',
    dryRun: false,
    yes: true,
    home: root,
    cwd,
    commands,
  });

  const status = await readInstallStatus({ home: root, cwd, scope: 'user' });
  assert.equal(status.codex.mcp, true);
  assert.equal(status.codex.hook, true);
  assert.equal(status.claude.mcp, true);
  assert.equal(status.claude.hook, true);
});
```

- [ ] **Step 2: Implement install orchestration**

Create `cli/src/install.ts`:

```ts
import { planClaudeMcpJson, planClaudeSettings } from './claude_config.js';
import { planCodexConfig } from './codex_config.js';
import { applyChangePlan, readTextFileIfExists, type ApplyResult } from './files.js';
import { resolveHostPaths } from './paths.js';
import type { InstallHost, InstallOptions } from './model.js';

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

async function applyHostPlans(options: InstallRunOptions): Promise<ApplyResult[]> {
  const paths = resolveHostPaths({ home: options.home, cwd: options.cwd, scope: options.scope });
  const plans = [];

  if (options.host === 'codex') {
    const before = await readTextFileIfExists(paths.codexConfigPath);
    plans.push(planCodexConfig(before, {
      path: paths.codexConfigPath,
      action: options.action,
      parts: options.parts,
      serverUrl: options.serverUrl,
      commands: {
        mcpCommand: options.commands.mcpCommand,
        hookCommand: options.commands.codexHookCommand,
      },
    }));
  }

  if (options.host === 'claude') {
    if (options.parts.has('mcp')) {
      const mcpBefore = await readTextFileIfExists(paths.claudeMcpJsonPath);
      plans.push(planClaudeMcpJson(mcpBefore, {
        path: paths.claudeMcpJsonPath,
        action: options.action,
        mcpCommand: options.commands.mcpCommand,
        serverUrl: options.serverUrl,
      }));
    }
    if (options.parts.has('hook')) {
      const settingsBefore = await readTextFileIfExists(paths.claudeSettingsPath);
      plans.push(planClaudeSettings(settingsBefore, {
        path: paths.claudeSettingsPath,
        action: options.action,
        hookCommand: options.commands.claudeHookCommand,
      }));
    }
  }

  const results: ApplyResult[] = [];
  if (!options.dryRun && !options.yes) {
    const confirmed = await (options.confirm ?? defaultConfirm)(plans.flatMap((plan) => plan.summary));
    if (!confirmed) {
      return [];
    }
  }
  for (const plan of plans) {
    results.push(await applyChangePlan(plan, { dryRun: options.dryRun }));
  }
  return results;
}

async function defaultConfirm(summary: string[]): Promise<boolean> {
  process.stdout.write(`${summary.join('\n')}\nProceed? [y/N] `);
  const answer = await new Promise<string>((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (chunk) => resolve(String(chunk)));
  });
  return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
}

export function targetHosts(target: InstallHost | 'all'): InstallHost[] {
  return target === 'all' ? ['codex', 'claude'] : [target];
}
```

- [ ] **Step 3: Implement status reader**

Create `cli/src/status.ts`:

```ts
import { readTextFileIfExists } from './files.js';
import { resolveHostPaths } from './paths.js';
import type { Scope } from './args.js';

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
  const codex = await readTextFileIfExists(paths.codexConfigPath);
  const claudeSettings = await readTextFileIfExists(paths.claudeSettingsPath);
  const claudeMcp = await readTextFileIfExists(paths.claudeMcpJsonPath);

  return {
    codex: {
      mcp: codex.includes('[mcp_servers.muninn]'),
      hook: codex.includes('muninn-codex-hook'),
    },
    claude: {
      mcp: claudeMcp.includes('"muninn"') && claudeMcp.includes('muninn-mcp'),
      hook: claudeSettings.includes('muninn-claude-hook'),
    },
  };
}
```

- [ ] **Step 4: Wire CLI dispatch**

Modify `cli/src/cli.ts` to call install/status modules:

```ts
#!/usr/bin/env node
import os from 'node:os';
import { parseArgs } from './args.js';
import { installHost, targetHosts, uninstallHost } from './install.js';
import { readInstallStatus } from './status.js';

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    if (parsed.command === 'help') {
      process.stdout.write(helpText());
      return 0;
    }
    if (parsed.command === 'install' || parsed.command === 'uninstall') {
      const parts = new Set(parsed.mcpOnly ? ['mcp'] as const : parsed.hookOnly ? ['hook'] as const : ['mcp', 'hook'] as const);
      for (const host of targetHosts(parsed.target)) {
        const results = await (parsed.command === 'install' ? installHost : uninstallHost)({
          action: parsed.command,
          host,
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => {
    process.exitCode = code;
  });
}
```

- [ ] **Step 5: Run install/status tests**

Run:

```sh
source ~/.zprofile && pnpm --filter @muninn/cli test
```

Expected: install/status tests pass with previous CLI tests.

- [ ] **Step 6: Commit**

```sh
git add cli/src/install.ts cli/src/status.ts cli/src/cli.ts cli/test/install-status.test.mjs
git commit -m "feat: wire cli host install commands"
```

---

### Task 7: Expose Server Startup for `muninn serve`

**Files:**
- Modify: `server/src/index.ts`
- Modify: `server/package.json`
- Create: `cli/src/serve.ts`
- Create: `cli/test/serve.test.mjs`
- Modify: `cli/src/cli.ts`

- [ ] **Step 1: Write failing server export test**

Create `cli/test/serve.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveServeEnv } from '../dist/serve.js';

test('resolveServeEnv applies serve defaults', () => {
  assert.deepEqual(resolveServeEnv({}), {
    HOST: '127.0.0.1',
    PORT: '8080',
    MUNINN_HOME: `${process.env.HOME}/.muninn`,
  });
});

test('resolveServeEnv applies explicit options', () => {
  assert.deepEqual(resolveServeEnv({
    host: '0.0.0.0',
    port: 8081,
    home: '/tmp/muninn-home',
  }), {
    HOST: '0.0.0.0',
    PORT: '8081',
    MUNINN_HOME: '/tmp/muninn-home',
  });
});
```

- [ ] **Step 2: Export startServer from server**

Modify `server/src/index.ts`:

```ts
import { serve } from '@hono/node-server';
import { app } from './routes.js';

export { app } from './routes.js';
export type { RecallMode } from './memory/index.js';

export type StartServerOptions = {
  host?: string;
  port?: number;
};

export function startServer(options: StartServerOptions = {}) {
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  const port = options.port ?? parseInt(process.env.PORT || '8080', 10);

  console.log(`Muninn Server running on http://${host}:${port}`);

  return serve({
    fetch: app.fetch,
    hostname: host,
    port,
  });
}

if (require.main === module) {
  startServer();
}
```

Modify `server/package.json` to add a bin:

```json
"bin": {
  "muninn-server": "./dist/index.js"
}
```

Add a shebang to the top of `server/src/index.ts` only if Node executes the compiled file directly through the bin shim on the target package manager. If npm creates a shell shim, a shebang is not required for macOS/Linux npm global installs.

- [ ] **Step 3: Implement serve helper**

Create `cli/src/serve.ts`:

```ts
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

export type ServeOptions = {
  host?: string;
  port?: number;
  home?: string;
};

type ServerModule = {
  startServer(options: { host?: string; port?: number }): unknown;
};

const require = createRequire(import.meta.url);

export function resolveServeEnv(options: ServeOptions): Record<'HOST' | 'PORT' | 'MUNINN_HOME', string> {
  return {
    HOST: options.host ?? '127.0.0.1',
    PORT: String(options.port ?? 8080),
    MUNINN_HOME: options.home ?? path.join(os.homedir(), '.muninn'),
  };
}

export async function runServe(options: ServeOptions): Promise<void> {
  const env = resolveServeEnv(options);
  process.env.HOST = env.HOST;
  process.env.PORT = env.PORT;
  process.env.MUNINN_HOME = env.MUNINN_HOME;

  process.stdout.write(`Muninn server running: http://${env.HOST}:${env.PORT}\n`);
  process.stdout.write(`Data home: ${env.MUNINN_HOME}\n`);
  process.stdout.write(`Health: http://${env.HOST}:${env.PORT}/health\n`);

  const serverModule = require('@muninn/server') as ServerModule;
  const { startServer } = serverModule;
  startServer({
    host: env.HOST,
    port: Number(env.PORT),
  });
}
```

- [ ] **Step 4: Wire `muninn serve`**

Modify the `serve` branch in `cli/src/cli.ts`:

```ts
if (parsed.command === 'serve') {
  const { runServe } = await import('./serve.js');
  await runServe({
    host: parsed.host,
    port: parsed.port,
    home: parsed.home,
  });
  return 0;
}
```

- [ ] **Step 5: Run serve tests**

Run:

```sh
source ~/.zprofile && pnpm --filter @muninn/server build
source ~/.zprofile && pnpm --filter @muninn/cli test
```

Expected: server builds and CLI tests pass.

- [ ] **Step 6: Commit**

```sh
git add server/src/index.ts server/package.json cli/src/serve.ts cli/src/cli.ts cli/test/serve.test.mjs
git commit -m "feat: add foreground muninn serve"
```

---

### Task 8: Add Doctor Checks

**Files:**
- Create: `cli/src/doctor.ts`
- Create: `cli/test/doctor.test.mjs`
- Modify: `cli/src/cli.ts`

- [ ] **Step 1: Write failing doctor tests**

Create `cli/test/doctor.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { runDoctorChecks } from '../dist/doctor.js';

test('runDoctorChecks reports missing cargo and protoc', async () => {
  const checks = await runDoctorChecks({
    platform: 'darwin',
    nodeVersion: 'v20.11.0',
    commandExists: (name) => name === 'node',
    fetchHealth: async () => ({ ok: false, detail: 'offline' }),
    loadNative: async () => ({ ok: false, detail: 'native addon not built' }),
  });

  assert.deepEqual(checks.map((check) => [check.name, check.ok]), [
    ['platform', true],
    ['node', true],
    ['cargo', false],
    ['protoc', false],
    ['native addon', false],
    ['server health', false],
  ]);
  assert.match(checks.find((check) => check.name === 'cargo').detail, /cargo not found/);
});

test('runDoctorChecks accepts linux and node 20+', async () => {
  const checks = await runDoctorChecks({
    platform: 'linux',
    nodeVersion: 'v22.0.0',
    commandExists: () => true,
    fetchHealth: async () => ({ ok: true, detail: 'ok' }),
    loadNative: async () => ({ ok: true, detail: 'ok' }),
  });

  assert.equal(checks.every((check) => check.ok), true);
});
```

- [ ] **Step 2: Implement doctor checks**

Create `cli/src/doctor.ts`:

```ts
import { accessSync, constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

export async function runDoctorChecks(options: {
  platform?: NodeJS.Platform;
  nodeVersion?: string;
  commandExists?: (name: string) => boolean;
  fetchHealth?: () => Promise<{ ok: boolean; detail: string }>;
  loadNative?: () => Promise<{ ok: boolean; detail: string }>;
} = {}): Promise<DoctorCheck[]> {
  const platform = options.platform ?? os.platform();
  const nodeVersion = options.nodeVersion ?? process.version;
  const commandExists = options.commandExists ?? commandOnPath;
  const fetchHealth = options.fetchHealth ?? defaultFetchHealth;
  const loadNative = options.loadNative ?? defaultLoadNative;

  const checks: DoctorCheck[] = [];
  checks.push({
    name: 'platform',
    ok: platform === 'darwin' || platform === 'linux',
    detail: platform === 'darwin' || platform === 'linux' ? platform : `unsupported platform: ${platform}`,
  });
  checks.push({
    name: 'node',
    ok: nodeMajor(nodeVersion) >= 20,
    detail: nodeVersion,
  });
  checks.push({
    name: 'cargo',
    ok: commandExists('cargo'),
    detail: commandExists('cargo') ? 'cargo found' : 'cargo not found in PATH',
  });
  checks.push({
    name: 'protoc',
    ok: commandExists('protoc'),
    detail: commandExists('protoc') ? 'protoc found' : 'protoc not found in PATH',
  });
  const native = await loadNative();
  checks.push({
    name: 'native addon',
    ok: native.ok,
    detail: native.detail,
  });
  const health = await fetchHealth();
  checks.push({
    name: 'server health',
    ok: health.ok,
    detail: health.detail,
  });
  return checks;
}

export function renderDoctorChecks(checks: DoctorCheck[]): string {
  return checks.map((check) => `${check.ok ? 'ok' : 'fail'} ${check.name}: ${check.detail}`).join('\n') + '\n';
}

function nodeMajor(version: string): number {
  return Number(version.replace(/^v/, '').split('.')[0] ?? '0');
}

function commandOnPath(name: string): boolean {
  for (const segment of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!segment) {
      continue;
    }
    try {
      accessSync(path.join(segment, name), fsConstants.X_OK);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

async function defaultFetchHealth(): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch('http://127.0.0.1:8080/health', {
      signal: AbortSignal.timeout(1000),
    });
    return {
      ok: response.ok,
      detail: response.ok ? 'http://127.0.0.1:8080/health ok' : `status ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function defaultLoadNative(): Promise<{ ok: boolean; detail: string }> {
  try {
    await import('@muninn/server');
    return { ok: true, detail: '@muninn/server loaded' };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
```

- [ ] **Step 3: Wire doctor command**

Modify `cli/src/cli.ts`:

```ts
if (parsed.command === 'doctor') {
  const { renderDoctorChecks, runDoctorChecks } = await import('./doctor.js');
  const checks = await runDoctorChecks();
  process.stdout.write(renderDoctorChecks(checks));
  return checks.every((check) => check.ok || check.name === 'server health') ? 0 : 1;
}
```

The `server health` check may fail without making `doctor` exit nonzero because users often run `doctor` before `muninn serve`.

- [ ] **Step 4: Run doctor tests**

Run:

```sh
source ~/.zprofile && pnpm --filter @muninn/cli test
```

Expected: doctor tests pass with previous CLI tests.

- [ ] **Step 5: Commit**

```sh
git add cli/src/doctor.ts cli/src/cli.ts cli/test/doctor.test.mjs
git commit -m "feat: add muninn doctor checks"
```

---

### Task 9: Make Runtime Packages Publish-Safe

**Files:**
- Modify: `common/package.json`
- Modify: `codex/package.json`
- Modify: `claude/package.json`
- Modify: `mcp/package.json`
- Modify: `server/package.json`
- Modify: `README.md`
- Create: `cli/README.md`

- [ ] **Step 1: Update package metadata**

For each publishable package, remove `private: true` only when ready to publish. During internal CI development, keep `private: true` until package contents and npm ownership are ready. Add the publish metadata now so removing `private` is a final release switch.

Update `common/package.json` to include:

```json
"engines": {
  "node": ">=20"
},
"license": "UNLICENSED"
```

Update `codex/package.json` to include:

```json
"engines": {
  "node": ">=20"
},
"files": [
  "dist",
  "README.md"
],
"license": "UNLICENSED"
```

Update `claude/package.json` to include:

```json
"engines": {
  "node": ">=20"
},
"files": [
  "dist",
  "README.md"
],
"license": "UNLICENSED"
```

Update `mcp/package.json` to include:

```json
"type": "module",
"engines": {
  "node": ">=20"
},
"files": [
  "dist",
  "README.md",
  "DEMO.md"
],
"license": "UNLICENSED"
```

If adding `"type": "module"` to `mcp/package.json` breaks the current CommonJS compile output, change `mcp/tsconfig.json` to NodeNext in the same commit:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2020"],
    "outDir": "./dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

Update `server/package.json` to include:

```json
"engines": {
  "node": ">=20"
},
"files": [
  "dist",
  "native/Cargo.toml",
  "native/src",
  "native/muninn_native.node",
  "prompts",
  "scripts/build-native.mjs",
  "README.md"
],
"license": "UNLICENSED",
"bin": {
  "muninn-server": "./dist/index.js"
},
"scripts": {
  "build": "pnpm --filter @muninn/codex build && pnpm --filter @muninn/claude build && pnpm run build:native && tsc",
  "build:native": "node ./scripts/build-native.mjs",
  "check:native": "cargo check --manifest-path native/Cargo.toml",
  "dev": "tsc --watch",
  "postinstall": "node ./scripts/build-native.mjs",
  "start": "node dist/index.js",
  "test": "(cd ../openclaw/plugin && pnpm build) && pnpm run build && node --test test/*.test.mjs test/memory/*.test.mjs"
}
```

If `postinstall` makes workspace development too slow, keep the package private during development and enable the script only in the release commit. Do not replace it with a workspace command; npm consumers must be able to build the native addon without `pnpm --filter`.

- [ ] **Step 2: Add CLI README**

Create `cli/README.md`:

```md
# @muninn/cli

Muninn CLI installs and runs Muninn for local agent memory.

## Install

```sh
npm i -g @muninn/cli
muninn doctor
muninn serve
muninn install all
```

The first release supports macOS and Linux. Windows is not supported.

`muninn serve` runs the server in the foreground. Keep it running while using Codex or Claude Code MCP tools and Stop hooks.

## Commands

```sh
muninn doctor
muninn serve
muninn install codex
muninn install claude
muninn install all
muninn uninstall codex
muninn uninstall claude
muninn uninstall all
muninn status
```

Muninn does not install a background service or background updater in the first release.

## Native Requirements

`@muninn/server` builds a native addon locally. Install Node.js 20+, Rust with `cargo`, `protoc`, and platform build tools before installing.
```

- [ ] **Step 3: Update top-level README install section**

Add this section to `README.md` after the repository layout:

```md
## First Installable Release Direction

The first installable release is planned as a macOS/Linux npm CLI:

```sh
npm i -g @muninn/cli
muninn doctor
muninn serve
muninn install all
```

`muninn install all` configures Codex and Claude Code host integrations. It registers the Muninn MCP server and Stop hooks for those hosts. `mcp/` remains a protocol adapter package; there is no `muninn install mcp` target.

The first release does not install a background service, does not perform background updates, does not support Windows, and requires local native compilation with Rust and `protoc`.
```

- [ ] **Step 4: Run package builds**

Run:

```sh
source ~/.zprofile && pnpm --filter @muninn/common build
source ~/.zprofile && pnpm --filter @muninn/codex build
source ~/.zprofile && pnpm --filter @muninn/claude build
source ~/.zprofile && pnpm --filter @muninn/mcp build
source ~/.zprofile && pnpm --filter @muninn/server build
source ~/.zprofile && pnpm --filter @muninn/cli build
```

Expected: every package builds.

- [ ] **Step 5: Commit**

```sh
git add common/package.json codex/package.json claude/package.json mcp/package.json mcp/tsconfig.json server/package.json README.md cli/README.md
git commit -m "chore: prepare muninn packages for cli release"
```

---

### Task 10: Full Verification

**Files:**
- No new files.

- [ ] **Step 1: Run focused package tests**

Run:

```sh
source ~/.zprofile && pnpm --filter @muninn/cli test
source ~/.zprofile && pnpm --filter @muninn/codex test
source ~/.zprofile && pnpm --filter @muninn/claude test
source ~/.zprofile && pnpm --filter @muninn/mcp build
```

Expected: all commands pass.

- [ ] **Step 2: Run server build**

Run:

```sh
source ~/.zprofile && pnpm --filter @muninn/server build
```

Expected: native addon builds and TypeScript compiles.

- [ ] **Step 3: Run root build**

Run:

```sh
source ~/.zprofile && pnpm run build
```

Expected: workspace build passes.

- [ ] **Step 4: Verify command help locally**

Run:

```sh
source ~/.zprofile && node cli/dist/cli.js --help
```

Expected output includes:

```text
muninn doctor
muninn serve
muninn install codex|claude|all
```

- [ ] **Step 5: Verify dry-run does not write real HOME**

Run:

```sh
source ~/.zprofile && node cli/dist/cli.js install all --dry-run
```

Expected: output describes planned Codex and Claude changes. It does not modify `~/.codex/config.toml`, `~/.claude/settings.json`, or `~/.claude.json`.

- [ ] **Step 6: Handle verification failures**

If verification reveals a failure, return to the task that introduced the failing behavior, make the fix there, rerun that task's tests, and commit under that task's commit step. After the fix, restart Task 10 from Step 1.

If all verification commands pass and `git status --short` shows no uncommitted changes, Task 10 is complete and no commit is needed.
