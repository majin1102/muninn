import type {
  ContextEngine,
  AgentMessage,
  AssembleResult,
  IngestResult,
  CompactResult,
} from "openclaw/plugin-sdk/core";
import type { MunnaiPluginConfig } from "./config.js";
import type { LoggerLike } from "./logger.js";
import type { FetchLike } from "./client.js";

export function createMunnaiContextEngine(params: {
  config: MunnaiPluginConfig;
  logger: LoggerLike;
  fetchImpl?: FetchLike;
}): ContextEngine {
  const fetchImpl = params.fetchImpl ?? fetch;

  return {
    info: {
      id: "munnai",
      name: "Munnai Memory",
      version: "0.1.0",
    },

    async ingest(): Promise<IngestResult> {
      return { ingested: false };
    },

    async assemble(assembleParams: {
      sessionId: string;
      messages: AgentMessage[];
      tokenBudget?: number;
    }): Promise<AssembleResult> {
      try {
        const signal = AbortSignal.timeout(params.config.timeoutMs);
        const response = await fetchImpl(
          `${params.config.baseUrl}/api/v1/list?mode=recency&limit=5`,
          { signal }
        );

        if (!response.ok) {
          params.logger.warn?.(`munnai recall failed: ${response.status}`);
          return {
            messages: assembleParams.messages,
            estimatedTokens: estimateTokens(assembleParams.messages),
          };
        }

        const data = await response.text();
        const parsed = JSON.parse(data) as { memoryHits: Array<{ content: string }> };
        const memories = parsed.memoryHits.map(hit => hit.content).join("\n\n");

        if (!memories.trim()) {
          return {
            messages: assembleParams.messages,
            estimatedTokens: estimateTokens(assembleParams.messages),
          };
        }

        return {
          messages: assembleParams.messages,
          systemPromptAddition: formatMemoriesContext(memories),
          estimatedTokens: estimateTokens(assembleParams.messages) + estimateTextTokens(memories),
        };
      } catch (error) {
        params.logger.warn?.(`munnai assemble failed: ${String(error)}`);
        return {
          messages: assembleParams.messages,
          estimatedTokens: estimateTokens(assembleParams.messages),
        };
      }
    },

    async afterTurn(afterTurnParams: {
      sessionId: string;
      sessionFile: string;
      messages: AgentMessage[];
      prePromptMessageCount: number;
      runtimeContext?: Record<string, unknown>;
    }): Promise<void> {
      try {
        const newMessages = afterTurnParams.messages.slice(
          afterTurnParams.prePromptMessageCount
        );
        const { userText, assistantText } = extractTurnTexts(newMessages);

        if (!userText && !assistantText) {
          return;
        }

        const signal = AbortSignal.timeout(params.config.timeoutMs);
        await fetchImpl(`${params.config.baseUrl}/api/v1/session/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session: {
              session_id: afterTurnParams.sessionId,
              agent: "openclaw",
              prompt: userText || undefined,
              response: assistantText || undefined,
            },
          }),
          signal,
        });
      } catch (error) {
        params.logger.warn?.(`munnai afterTurn failed: ${String(error)}`);
      }
    },

    async compact(): Promise<CompactResult> {
      return {
        ok: true,
        compacted: false,
        reason: "munnai_does_not_compact",
      };
    },
  };
}

function estimateTokens(messages: AgentMessage[]): number {
  return Math.max(1, messages.length * 80);
}

function estimateTextTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function formatMemoriesContext(memories: string): string {
  return `<relevant-memories>
${memories}
</relevant-memories>`;
}

function extractTurnTexts(messages: AgentMessage[]): {
  userText: string;
  assistantText: string;
} {
  const userTexts: string[] = [];
  const assistantTexts: string[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const role = msg.role;
    if (role !== "user" && role !== "assistant") continue;

    const text = extractContentText(msg.content);
    if (!text) continue;

    if (role === "user") {
      userTexts.push(text);
    } else {
      assistantTexts.push(text);
    }
  }

  return {
    userText: userTexts.join("\n\n").trim(),
    assistantText: assistantTexts.join("\n\n").trim(),
  };
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const texts = content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const entry = block as Record<string, unknown>;
      return entry.type === "text" && typeof entry.text === "string"
        ? entry.text.trim()
        : "";
    })
    .filter(Boolean);
  return texts.join("\n\n").trim();
}
