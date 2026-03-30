export type MunnaiPluginConfig = {
  baseUrl: string;
  enabled: boolean;
  timeoutMs: number;
};

const DEFAULT_TIMEOUT_MS = 1500;

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
  };
}

function resolveTimeoutMs(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.trunc(raw);
}
