import type {
  OpenClawPluginApi,
  PluginHookAgentContext,
  PluginHookAgentEndEvent,
  PluginHookAfterToolCallEvent,
} from "openclaw/plugin-sdk/core";

import { collectArtifacts } from "./artifacts.js";
import { buildCommandString } from "./command-string.js";
import { resolvePluginConfig } from "./config.js";
import { createMunnaiClient } from "./client.js";
import { buildPromptPayload, buildResponsePayload, buildToolPayload } from "./payloads.js";

export function registerMunnaiHooks(api: OpenClawPluginApi): void {
  const config = resolvePluginConfig(api.pluginConfig);
  if (!config?.enabled) {
    api.logger.info?.("[munnai] plugin disabled or missing baseUrl");
    return;
  }

  const client = createMunnaiClient({
    config,
    logger: api.logger,
  });

  api.on("before_model_resolve", async (event, ctx) => {
    const payload = buildPromptPayload({
      sessionKey: ctx.sessionKey,
      agentId: ctx.agentId,
      prompt: event.prompt,
    });
    if (payload) {
      await client.sendMessage(payload);
    }
  });

  api.on("after_tool_call", async (event, ctx) => {
    await handleAfterToolCall(event, ctx, api, client.sendMessage);
  });

  api.on("agent_end", async (event, ctx) => {
    const response = extractFinalAssistantText(event);
    const payload = buildResponsePayload({
      sessionKey: ctx.sessionKey,
      agentId: ctx.agentId,
      response,
    });
    if (payload) {
      await client.sendMessage(payload);
    }
  });
}

async function handleAfterToolCall(
  event: PluginHookAfterToolCallEvent,
  ctx: PluginHookAgentContext,
  api: OpenClawPluginApi,
  sendMessage: (request: ReturnType<typeof buildToolPayload> extends infer T ? Exclude<T, null> : never) => Promise<void>,
): Promise<void> {
  const command = buildCommandString(event.toolName, event.params);
  const artifacts = await collectArtifacts({
    toolName: event.toolName,
    toolParams: {
      ...event.params,
      ...(typeof event.result === "string" ? { result: event.result } : {}),
      ...(typeof event.error === "string" ? { error: event.error } : {}),
    },
    workspaceDir: ctx.workspaceDir,
    logger: api.logger,
  });
  const payload = buildToolPayload({
    sessionKey: ctx.sessionKey,
    agentId: ctx.agentId,
    command,
    artifacts,
  });
  if (payload) {
    await sendMessage(payload);
  }
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

function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const record = message as Record<string, unknown>;
  if (record.role !== "assistant") {
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
