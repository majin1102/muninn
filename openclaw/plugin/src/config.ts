export type MuninnPluginConfig = {
  baseUrl: string;
  enabled: boolean;
  timeoutMs: number;
  recallLimit: number;
};

const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_RECALL_LIMIT = 3;

export function resolvePluginConfig(
  raw: Record<string, unknown> | undefined,
): MuninnPluginConfig | null {
  const baseUrl = typeof raw?.baseUrl === "string" ? raw.baseUrl.trim() : "";
  if (!baseUrl) {
    return null;
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    enabled: raw?.enabled !== false,
    timeoutMs: resolveTimeoutMs(raw?.timeoutMs),
    recallLimit: resolveRecallLimit(raw?.recallLimit),
  };
}

function resolveTimeoutMs(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.trunc(raw);
}

function resolveRecallLimit(raw: unknown): number {
  if (!Number.isInteger(raw) || (raw as number) <= 0) {
    return DEFAULT_RECALL_LIMIT;
  }
  return raw as number;
}
