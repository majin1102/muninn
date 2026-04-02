const LARGE_VALUE_LIMIT = 160;
const OMITTED_KEYS = new Set(["content", "patch", "text"]);

export function buildCommandString(toolName: string, params: Record<string, unknown>): string {
  const normalizedToolName = toolName.trim();
  const serialized = Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => serializeParam(key, value))
    .filter((entry): entry is string => Boolean(entry));

  if (serialized.length === 0) {
    return normalizedToolName;
  }
  return `${normalizedToolName} ${serialized.join(" ")}`;
}

function serializeParam(key: string, value: unknown): string | null {
  if (value === null) {
    return `${key}=null`;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    if (OMITTED_KEYS.has(key) || trimmed.length > LARGE_VALUE_LIMIT) {
      return `${key}=<omitted>`;
    }
    return `${key}=${quoteIfNeeded(trimmed)}`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return `${key}=${String(value)}`;
  }
  if (Array.isArray(value)) {
    return `${key}=${quoteIfNeeded(JSON.stringify(value))}`;
  }
  return `${key}=${quoteIfNeeded(JSON.stringify(value))}`;
}

function quoteIfNeeded(value: string): string {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}
