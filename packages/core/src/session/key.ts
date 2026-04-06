export function sessionKey(
  sessionId: string | undefined,
  agent: string,
  observer: string,
): string {
  if (hasText(sessionId)) {
    return `session:${sessionId}|agent:${agent}|observer:${observer}`;
  }
  return `agent:${agent}|observer:${observer}`;
}

export function hasText(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
