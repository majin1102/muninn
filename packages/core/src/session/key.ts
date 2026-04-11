export function sessionKey(
  sessionId: string | undefined,
  agent: string,
  observer: string,
): string {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (normalizedSessionId) {
    return `session:${normalizedSessionId}|agent:${agent}|observer:${observer}`;
  }
  return `agent:${agent}|observer:${observer}`;
}

export function normalizeSessionId(sessionId: string | null | undefined): string | undefined {
  if (!hasText(sessionId)) {
    return undefined;
  }
  return sessionId.trim();
}

export function hasText(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
