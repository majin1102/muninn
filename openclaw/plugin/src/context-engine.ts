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
          `${params.config.baseUrl}/api/v1/list?mode=recency&limit=${params.config.recencyLimit}`,
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
