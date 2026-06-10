export type CodexHookConfig = {
  baseUrl: string;
  timeoutMs: number;
};

const DEFAULT_BASE_URL = 'http://localhost:8080';
const DEFAULT_TIMEOUT_MS = 1500;

/**
 * Resolve hook configuration from the environment. Codex invokes hooks as bare
 * subprocesses, so the sidecar endpoint is passed via env rather than a plugin
 * config object.
 */
export function resolveHookConfig(env: NodeJS.ProcessEnv = process.env): CodexHookConfig {
  const raw = env.MUNINN_SIDECAR_URL ?? env.MUNINN_BASE_URL ?? DEFAULT_BASE_URL;
  return {
    baseUrl: raw.trim().replace(/\/+$/, '') || DEFAULT_BASE_URL,
    timeoutMs: resolveTimeoutMs(env.MUNINN_HOOK_TIMEOUT_MS),
  };
}

function resolveTimeoutMs(raw: string | undefined): number {
  const value = raw ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.trunc(value);
}
