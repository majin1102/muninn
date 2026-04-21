import type { MuninnPluginConfig } from "./config.js";
import type { LoggerLike } from "./logger.js";
import { logWarn } from "./logger.js";
import type { CaptureTurnRequest } from "./payloads.js";

export type FetchResponseLike = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
};

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: unknown;
  },
) => Promise<FetchResponseLike>;

export type MuninnClient = {
  captureTurn(request: CaptureTurnRequest): Promise<void>;
  recall(query: string): Promise<string[]>;
};

export function createMuninnClient(params: {
  config: MuninnPluginConfig;
  logger: LoggerLike;
  fetchImpl?: FetchLike;
}): MuninnClient {
  const fetchImpl = params.fetchImpl ?? fetch;

  return {
    async captureTurn(request) {
      const signal = AbortSignal.timeout(params.config.timeoutMs);
      try {
        const response = await fetchImpl(`${params.config.baseUrl}/api/v1/turn/capture`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(request),
          signal,
        });
        if (!response.ok) {
          const body = await safeReadBody(response);
          logWarn(
            params.logger,
            `muninn write failed with status ${response.status}${body ? ` body=${body}` : ""}`,
          );
        }
      } catch (error) {
        logWarn(params.logger, "muninn write request failed", error);
      }
    },

    async recall(query) {
      const signal = AbortSignal.timeout(params.config.timeoutMs);
      const search = new URLSearchParams({
        query,
        limit: String(params.config.recallLimit),
      });
      try {
        const response = await fetchImpl(`${params.config.baseUrl}/api/v1/recall?${search}`, {
          signal,
        });
        if (!response.ok) {
          const body = await safeReadBody(response);
          logWarn(
            params.logger,
            `muninn recall failed with status ${response.status}${body ? ` body=${body}` : ""}`,
          );
          return [];
        }
        return parseRecallHits(await safeReadBody(response));
      } catch (error) {
        logWarn(params.logger, "muninn recall request failed", error);
        return [];
      }
    },
  };
}

function parseRecallHits(body: string): string[] {
  if (!body) {
    return [];
  }
  const parsed = JSON.parse(body) as { memoryHits?: Array<{ content?: unknown }> };
  if (!Array.isArray(parsed.memoryHits)) {
    return [];
  }
  return parsed.memoryHits
    .map((hit) => (typeof hit?.content === "string" ? hit.content.trim() : ""))
    .filter((content) => content.length > 0);
}

async function safeReadBody(response: FetchResponseLike): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}
