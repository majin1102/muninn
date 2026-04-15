import type {
  OpenClawPluginApi,
  PluginHookAgentEndEvent,
} from "openclaw/plugin-sdk/core";

import { resolvePluginConfig } from "./config.js";
import { createMuninnClient } from "./client.js";
import { buildCapturePayload, type ToolCall } from "./payloads.js";

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

  api.on("agent_end", async (event, ctx) => {
    const payload = buildCapturePayload({
      sessionKey: ctx.sessionKey,
      agentId: ctx.agentId,
      prompt: extractFinalUserText(event),
      response: extractFinalAssistantText(event),
      toolCalls: extractToolCalls(event),
    });
    if (payload) {
      await client.captureTurn(payload);
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
