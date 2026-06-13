import type { TurnContent } from '@muninn/common';
import type { CodexHookConfig } from './config.js';

export type CaptureTurnRequest = {
  turn: TurnContent;
};

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
    signal?: AbortSignal;
  },
) => Promise<FetchResponseLike>;

export type MuninnClient = {
  captureTurn(request: CaptureTurnRequest): Promise<boolean>;
};

/**
 * Thin, fail-soft client for the Muninn sidecar. A capture failure must never
 * block Codex, so errors are logged to stderr and swallowed.
 */
export function createMuninnClient(params: { config: CodexHookConfig; fetchImpl?: FetchLike }): MuninnClient {
  const fetchImpl = (params.fetchImpl ?? (fetch as unknown as FetchLike));
  return {
    async captureTurn(request) {
      try {
        const response = await fetchImpl(`${params.config.baseUrl}/api/v1/turn/capture`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(params.config.timeoutMs),
        });
        if (!response.ok) {
          const body = await safeReadBody(response);
          logWarn(`muninn capture failed with status ${response.status}${body ? ` body=${body}` : ''}`);
          return false;
        }
        return true;
      } catch (error) {
        logWarn('muninn capture request failed', error);
        return false;
      }
    },
  };
}

async function safeReadBody(response: FetchResponseLike): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return '';
  }
}

function logWarn(message: string, error?: unknown): void {
  const suffix = error instanceof Error ? `: ${error.message}` : error !== undefined ? `: ${String(error)}` : '';
  process.stderr.write(`[muninn-codex-hook] ${message}${suffix}\n`);
}
