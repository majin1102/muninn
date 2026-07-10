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
      mcp: hasCodexMcp(codexConfig, 'muninn-mcp'),
      hook: hasCodexHook(codexConfig, 'Stop', 'muninn-codex-hook')
        && hasCodexHook(codexConfig, 'SessionStart', 'muninn-codex-hook', 'startup'),
    },
    claude: {
      mcp: hasClaudeMcp(claudeMcpJson, 'muninn-mcp'),
      hook: hasClaudeStopHook(claudeSettings, 'muninn-claude-hook'),
    },
  };
}

function hasCodexMcp(input: string, commandName: string): boolean {
  const lines = input.split('\n');
  for (let index = 0; index < lines.length;) {
    if (stripInlineComment(lines[index]).trim() !== '[mcp_servers.muninn]') {
      index += 1;
      continue;
    }

    index += 1;
    while (index < lines.length && !isTomlTableHeader(lines[index])) {
      if (isCommandLine(lines[index], commandName)) {
        return true;
      }
      index += 1;
    }
  }
  return false;
}

function hasCodexHook(
  input: string,
  event: 'SessionStart' | 'Stop',
  commandName: string,
  matcher?: string,
): boolean {
  const lines = input.split('\n');
  const eventHeader = `[[hooks.${event}]]`;
  const hookHeader = `[[hooks.${event}.hooks]]`;
  for (let index = 0; index < lines.length;) {
    if (stripInlineComment(lines[index]).trim() !== eventHeader) {
      index += 1;
      continue;
    }

    const block: string[] = [];
    index += 1;
    while (index < lines.length && !startsNextHookBlock(lines[index], hookHeader)) {
      block.push(lines[index]);
      index += 1;
    }
    if (matcher !== undefined && !block.some((line) => isTomlValueLine(line, 'matcher', matcher))) {
      continue;
    }

    for (let blockIndex = 0; blockIndex < block.length;) {
      if (stripInlineComment(block[blockIndex]).trim() !== hookHeader) {
        blockIndex += 1;
        continue;
      }

      const hook: string[] = [];
      blockIndex += 1;
      while (blockIndex < block.length && stripInlineComment(block[blockIndex]).trim() !== hookHeader) {
        hook.push(block[blockIndex]);
        blockIndex += 1;
      }
      if (hook.some((line) => isCommandLine(line, commandName))) {
        return true;
      }
    }
  }
  return false;
}

function isTomlValueLine(line: string, key: string, expected: string): boolean {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`).exec(stripInlineComment(line));
  return Boolean(match && parseTomlString(match[1].trimEnd()) === expected);
}

function hasClaudeMcp(input: string, commandName: string): boolean {
  const config = parseJsonObject(input);
  const mcpServers = objectValue(config, 'mcpServers');
  const muninn = objectValue(mcpServers, 'muninn');
  const command = muninn.command;
  return typeof command === 'string' && isManagedCommand(command, commandName);
}

function hasClaudeStopHook(input: string, commandName: string): boolean {
  const settings = parseJsonObject(input);
  const hooks = objectValue(settings, 'hooks');
  const stop = hooks.Stop;
  if (!Array.isArray(stop)) {
    return false;
  }

  for (const entry of stop) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const entryHooks = (entry as { hooks?: unknown }).hooks;
    if (!Array.isArray(entryHooks)) {
      continue;
    }
    for (const hook of entryHooks) {
      if (!hook || typeof hook !== 'object' || Array.isArray(hook)) {
        continue;
      }
      const command = (hook as { command?: unknown }).command;
      if (typeof command === 'string' && isManagedCommand(command, commandName)) {
        return true;
      }
    }
  }
  return false;
}

function isCommandLine(line: string, commandName: string): boolean {
  const match = /^\s*command\s*=\s*(.+?)\s*$/.exec(line);
  if (!match) {
    return false;
  }
  return isManagedCommand(parseTomlString(stripInlineComment(match[1]).trimEnd()), commandName);
}

function parseJsonObject(input: string): Record<string, unknown> {
  if (!input.trim()) {
    return {};
  }
  const parsed: unknown = JSON.parse(input);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

function objectValue(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function isManagedCommand(command: string, commandName: string): boolean {
  const executable = shellWords(command)[0] ?? command;
  if (executable === commandName || basename(executable) === commandName) {
    return true;
  }
  return managedPackageBinSuffixes(commandName).some((suffix) => executable.endsWith(suffix));
}

function basename(value: string): string {
  return value.split('/').pop() ?? value;
}

function shellWords(value: string): string[] {
  const words: string[] = [];
  let current = '';
  let quoted: '"' | "'" | null = null;
  let escaping = false;

  for (const char of value) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (quoted === '"' && char === '\\') {
      escaping = true;
      continue;
    }
    if (quoted !== null) {
      if (char === quoted) {
        quoted = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quoted = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) {
    words.push(current);
  }
  return words;
}

function managedPackageBinSuffixes(commandName: string): string[] {
  if (commandName === 'muninn-mcp') {
    return ['/node_modules/@muninn/mcp/dist/index.js'];
  }
  if (commandName === 'muninn-codex-hook') {
    return ['/node_modules/@muninn/codex/dist/cli.js'];
  }
  if (commandName === 'muninn-claude-hook') {
    return ['/node_modules/@muninn/claude/dist/claude-cli.js'];
  }
  return [];
}

function parseTomlString(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'string') {
        return parsed;
      }
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

function stripInlineComment(value: string): string {
  let quoted: '"' | "'" | null = null;
  let escaping = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (escaping) {
      escaping = false;
      continue;
    }

    if (quoted === '"' && char === '\\') {
      escaping = true;
      continue;
    }

    if (quoted !== null) {
      if (char === quoted) {
        quoted = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quoted = char;
      continue;
    }

    if (char === '#') {
      return value.slice(0, index);
    }
  }

  return value;
}

function isTomlTableHeader(line: string): boolean {
  return /^\s*\[/.test(stripInlineComment(line));
}

function startsNextHookBlock(line: string, hookHeader: string): boolean {
  const trimmed = stripInlineComment(line).trim();
  if (trimmed === hookHeader) {
    return false;
  }
  return isTomlTableHeader(line);
}
