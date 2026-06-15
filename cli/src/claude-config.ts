import type { Scope } from './args.js';
import type { ChangePlan, PlanAction } from './model.js';

type JsonObject = Record<string, unknown>;

export function planClaudeSettings(before: string, options: {
  path: string;
  action: PlanAction;
  hookCommand: string;
}): ChangePlan {
  const settings = parseJsonObject(before);
  const existingHooks = objectValue(settings, 'hooks');
  const existingStop = Array.isArray(existingHooks.Stop) ? existingHooks.Stop : [];
  const { stop, removed } = removeManagedStopHooks(existingStop, options.hookCommand);

  if (options.action === 'uninstall' && !removed) {
    return unchanged(options.path, before);
  }

  if (options.action === 'install') {
    stop.push({
      hooks: [
        {
          type: 'command',
          command: options.hookCommand,
          timeout: 30,
        },
      ],
    });
  }

  const hooks = { ...existingHooks, Stop: stop };
  const after = renderJson({ ...settings, hooks });
  const changed = before !== after;

  return {
    changed,
    path: options.path,
    before,
    after: changed ? after : before,
    summary: changed
      ? [
          options.action === 'install'
            ? 'Configure Claude Code Stop hook: muninn-claude-hook'
            : 'Remove Claude Code Stop hook: muninn-claude-hook',
        ]
      : [],
  };
}

export function planClaudeMcpJson(before: string, options: {
  path: string;
  action: PlanAction;
  mcpCommand: string;
  serverUrl: string;
}): ChangePlan {
  const config = parseJsonObject(before);
  const existingServers = objectValue(config, 'mcpServers');
  const hadMuninn = Object.hasOwn(existingServers, 'muninn');

  if (options.action === 'uninstall' && !hadMuninn) {
    return unchanged(options.path, before);
  }

  const mcpServers = { ...existingServers };
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

  const after = renderJson({ ...config, mcpServers });
  const changed = before !== after;

  return {
    changed,
    path: options.path,
    before,
    after: changed ? after : before,
    summary: changed
      ? [
          options.action === 'install'
            ? 'Configure Claude Code MCP server: muninn'
            : 'Remove Claude Code MCP server: muninn',
        ]
      : [],
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

  const parsed: unknown = JSON.parse(input);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Claude configuration must be a JSON object');
  }

  return parsed as JsonObject;
}

function objectValue(parent: JsonObject, key: string): JsonObject {
  const value = parent[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as JsonObject;
}

function removeManagedStopHooks(stop: unknown[], hookCommand: string): {
  stop: unknown[];
  removed: boolean;
} {
  const output: unknown[] = [];
  let removed = false;

  for (const entry of stop) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      output.push(entry);
      continue;
    }

    const hooks = (entry as { hooks?: unknown }).hooks;
    if (!Array.isArray(hooks)) {
      output.push(entry);
      continue;
    }

    const keptHooks = hooks.filter((hook) => {
      const managed = isManagedHook(hook, hookCommand);
      if (managed) {
        removed = true;
      }
      return !managed;
    });

    if (keptHooks.length > 0) {
      output.push({ ...entry, hooks: keptHooks });
    }
  }

  return { stop: output, removed };
}

function isManagedHook(hook: unknown, hookCommand: string): boolean {
  if (!hook || typeof hook !== 'object' || Array.isArray(hook)) {
    return false;
  }

  const command = (hook as { command?: unknown }).command;
  if (typeof command !== 'string') {
    return false;
  }

  return command === hookCommand || basename(command) === 'muninn-claude-hook';
}

function basename(value: string): string {
  return value.split('/').pop() ?? value;
}

function renderJson(value: JsonObject): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function unchanged(path: string, before: string): ChangePlan {
  return {
    changed: false,
    path,
    before,
    after: before,
    summary: [],
  };
}
