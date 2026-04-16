import type {
  OpenClawPluginApi,
  PluginHookAfterToolCallEvent,
  PluginHookAgentEndEvent,
} from "openclaw/plugin-sdk/core";

import { resolvePluginConfig } from "./config.js";
import { createMuninnClient } from "./client.js";
import { collectArtifacts } from "./artifacts.js";
import { buildCapturePayload, type Artifact, type ToolCall } from "./payloads.js";

type RunState = {
  toolCalls: ToolCall[];
  artifacts: Artifact[];
};

export function registerMuninnHooks(api: OpenClawPluginApi): void {
  const config = resolvePluginConfig(api.pluginConfig);
  if (!config?.enabled) {
    api.logger.info?.("[muninn] plugin disabled or missing baseUrl");
    return;
  }

  const client = createMuninnClient({
    config,
    logger: api.logger,
  });
  const runs = new Map<string, RunState>();

  api.on("after_tool_call", async (event, ctx) => {
    const key = cacheKey(ctx.sessionKey);
    if (!key) {
      api.logger.warn?.("[muninn] after_tool_call missing sessionKey; skipping cached tool data");
      return;
    }
    const state = getRunState(runs, key);
    state.toolCalls.push(buildToolCall(event));
    const artifacts = await collectArtifacts({
      toolName: event.toolName,
      toolParams: event.params,
      workspaceDir: ctx.workspaceDir,
      logger: api.logger,
    });
    if (artifacts) {
      mergeArtifacts(state.artifacts, toArtifacts(artifacts));
    }
  });

  api.on("agent_end", async (event, ctx) => {
    const key = cacheKey(ctx.sessionKey);
    const state = key ? runs.get(key) : undefined;
    try {
      const payload = buildCapturePayload({
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
        prompt: extractFinalUserText(event),
        response: extractFinalAssistantText(event),
        toolCalls: state?.toolCalls.length ? state.toolCalls : extractToolCalls(event),
        artifacts: state?.artifacts.length ? state.artifacts : undefined,
      });
      if (payload) {
        await client.captureTurn(payload);
      }
    } finally {
      if (key) {
        runs.delete(key);
      }
    }
  });
}

export function extractFinalAssistantText(event: PluginHookAgentEndEvent): string {
  for (let index = event.messages.length - 1; index >= 0; index -= 1) {
    const text = extractAssistantText(event.messages[index]);
    if (text) {
      return text;
    }
  }
  return "";
}

export function extractFinalUserText(event: PluginHookAgentEndEvent): string {
  for (let index = event.messages.length - 1; index >= 0; index -= 1) {
    const text = extractRoleText(event.messages[index], "user");
    if (text) {
      return text;
    }
  }
  return "";
}

export function extractToolCalls(event: PluginHookAgentEndEvent): ToolCall[] | undefined {
  const toolCalls = event.messages.flatMap((message) => extractMessageToolCalls(message));
  return toolCalls.length > 0 ? toolCalls : undefined;
}

function cacheKey(sessionKey: unknown): string | undefined {
  return typeof sessionKey === "string" && sessionKey.trim() ? sessionKey.trim() : undefined;
}

function getRunState(runs: Map<string, RunState>, key: string): RunState {
  const existing = runs.get(key);
  if (existing) {
    return existing;
  }
  const state: RunState = {
    toolCalls: [],
    artifacts: [],
  };
  runs.set(key, state);
  return state;
}

function buildToolCall(event: PluginHookAfterToolCallEvent): ToolCall {
  const input = stringifyBlockValue(event.params);
  const output = stringifyBlockValue(event.result ?? event.error);
  return {
    ...(typeof event.toolCallId === "string" ? { id: event.toolCallId } : {}),
    name: event.toolName,
    ...(input ? { input } : {}),
    ...(output ? { output } : {}),
  };
}

function toArtifacts(artifacts: Record<string, string>): Artifact[] {
  return Object.entries(artifacts).map(([key, content]) => ({ key, content }));
}

function mergeArtifacts(target: Artifact[], updates: Artifact[]): void {
  const byKey = new Map(target.map((artifact) => [artifact.key, artifact]));
  for (const artifact of updates) {
    byKey.set(artifact.key, artifact);
  }
  target.splice(0, target.length, ...byKey.values());
}

function extractAssistantText(message: unknown): string {
  return extractRoleText(message, "assistant");
}

function extractRoleText(message: unknown, role: string): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const record = message as Record<string, unknown>;
  if (record.role !== role) {
    return "";
  }
  return extractContentText(record.content);
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const blocks = content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      const entry = block as Record<string, unknown>;
      return entry.type === "text" && typeof entry.text === "string" ? entry.text.trim() : "";
    })
    .filter(Boolean);
  return blocks.join("\n\n").trim();
}

function extractMessageToolCalls(message: unknown): ToolCall[] {
  if (!message || typeof message !== "object") {
    return [];
  }
  const record = message as Record<string, unknown>;
  if (record.role !== "assistant" || !Array.isArray(record.content)) {
    return [];
  }
  return record.content.flatMap((block) => {
    if (!block || typeof block !== "object") {
      return [];
    }
    const entry = block as Record<string, unknown>;
    if (entry.type !== "toolCall" || typeof entry.name !== "string") {
      return [];
    }
    const input = stringifyBlockValue(entry.arguments);
    return [{
      ...(typeof entry.id === "string" ? { id: entry.id } : {}),
      name: entry.name,
      ...(input ? { input } : {}),
    }];
  });
}

function stringifyBlockValue(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
