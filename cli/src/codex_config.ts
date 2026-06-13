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

      const text = hook.join('\n');
      if (text.includes(hookCommand) || text.includes('muninn-codex-hook')) {
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
