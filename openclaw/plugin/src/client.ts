import type { MuninnPluginConfig } from "./config.js";
import type { LoggerLike } from "./logger.js";
import { logWarn } from "./logger.js";
import type { AddMessageToSessionRequest } from "./payloads.js";

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
  sendMessage(request: AddMessageToSessionRequest): Promise<void>;
};

export function createMuninnClient(params: {
  config: MuninnPluginConfig;
  logger: LoggerLike;
  fetchImpl?: FetchLike;
}): MuninnClient {
  const fetchImpl = params.fetchImpl ?? fetch;

  return {
    async sendMessage(request) {
      const signal = AbortSignal.timeout(params.config.timeoutMs);
      try {
        const response = await fetchImpl(`${params.config.baseUrl}/api/v1/session/messages`, {
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
  };
}

async function safeReadBody(response: FetchResponseLike): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}
