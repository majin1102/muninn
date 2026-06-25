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
    const previous = after;
    const withoutMcp = removeMcpServer(after);
    if (options.action === 'install') {
      after = appendSection(withoutMcp, renderMcpServer(options.commands.mcpCommand, options.serverUrl));
      if (after !== previous) {
        summary.push('Configure Codex MCP server: muninn');
      }
    } else {
      after = withoutMcp;
      if (after !== previous) {
        summary.push('Remove Codex MCP server: muninn');
      }
    }
  }

  if (options.parts.has('hook')) {
    const previous = after;
    const withoutHook = removeMuninnStopHooks(after, options.commands.hookCommand);
    if (options.action === 'install') {
      after = appendSection(withoutHook, renderStopHook(options.commands.hookCommand));
      if (after !== previous) {
        summary.push('Configure Codex Stop hook: muninn-codex-hook');
      }
    } else {
      after = withoutHook;
      if (after !== previous) {
        summary.push('Remove Codex Stop hook: muninn-codex-hook');
      }
    }
  }

  after = normalizeTrailingNewline(after);
  const changed = before !== after;

  return {
    changed,
    path: options.path,
    before,
    after,
    summary: changed ? summary : [],
  };
}

export function planCodexHookConfig(before: string, options: {
  path: string;
  action: PlanAction;
  serverUrl: string;
}): ChangePlan {
  const after = options.action === 'install'
    ? `${JSON.stringify({ serverUrl: options.serverUrl }, null, 2)}\n`
    : '';
  const changed = before !== after;
  return {
    changed,
    path: options.path,
    before,
    after,
    summary: changed
      ? [options.action === 'install'
          ? 'Configure Codex Stop hook endpoint: muninn'
          : 'Remove Codex Stop hook endpoint: muninn']
      : [],
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
    'timeout = 5',
    'statusMessage = "Capturing conversation by muninn"',
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
      while (index < lines.length && !startsNextStopBlock(lines[index])) {
        block.push(lines[index]);
        index += 1;
      }
      const keptBlock = removeMuninnHookEntries(block, hookCommand);
      if (keptBlock.length > 0) {
        output.push(...keptBlock);
      }
      continue;
    }
    output.push(lines[index]);
    index += 1;
  }
  return compactBlankLines(output.join('\n'));
}

function removeMuninnHookEntries(block: string[], hookCommand: string): string[] {
  const output: string[] = [];
  let keptHook = false;

  for (let index = 0; index < block.length;) {
    if (block[index].trim() === '[[hooks.Stop.hooks]]') {
      const hook: string[] = [block[index]];
      index += 1;
      while (index < block.length && block[index].trim() !== '[[hooks.Stop.hooks]]') {
        hook.push(block[index]);
        index += 1;
      }

      if (isMuninnHook(hook, hookCommand)) {
        continue;
      }

      output.push(...hook);
      keptHook = true;
      continue;
    }

    output.push(block[index]);
    index += 1;
  }

  return keptHook ? output : [];
}

function isMuninnHook(hook: string[], hookCommand: string): boolean {
  const command = hook.map(readCommandValue).find((value): value is string => value !== null);
  if (command === undefined) {
    return false;
  }
  const executable = shellWords(command)[0] ?? command;
  return executable === hookCommand || basename(executable) === 'muninn-codex-hook';
}

function readCommandValue(line: string): string | null {
  const match = /^\s*command\s*=\s*(.+?)\s*$/.exec(line);
  if (!match) {
    return null;
  }
  return parseTomlString(stripInlineComment(match[1]).trimEnd());
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

function startsNextStopBlock(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '[[hooks.Stop.hooks]]') {
    return false;
  }
  return isTomlTableHeader(line);
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
