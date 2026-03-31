export type MunnaiPluginConfig = {
  baseUrl: string;
  enabled: boolean;
  timeoutMs: number;
  recencyLimit: number;
};

const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_RECENCY_LIMIT = 5;

export function resolvePluginConfig(
  raw: Record<string, unknown> | undefined,
): MunnaiPluginConfig | null {
  const baseUrl = typeof raw?.baseUrl === "string" ? raw.baseUrl.trim() : "";
  if (!baseUrl) {
    return null;
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    enabled: raw?.enabled !== false,
    timeoutMs: resolveTimeoutMs(raw?.timeoutMs),
    recencyLimit: resolveRecencyLimit(raw?.recencyLimit),
  };
}

function resolveTimeoutMs(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.trunc(raw);
}

function resolveRecencyLimit(raw: unknown): number {
  if (!Number.isInteger(raw) || (raw as number) <= 0) {
    return DEFAULT_RECENCY_LIMIT;
  }
  return raw as number;
}
