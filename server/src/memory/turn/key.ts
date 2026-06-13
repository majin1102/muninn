export function sessionKey(
  sessionId: string | undefined,
  agent: string,
  observer: string,
  ownership: { project: string; cwd: string } = {
    project: 'default',
    cwd: process.cwd(),
  },
): string {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const scope = `cwd:${ownership.cwd}`;
  if (normalizedSessionId) {
    return `${scope}|session:${normalizedSessionId}|agent:${agent}|observer:${observer}`;
  }
  return `${scope}|agent:${agent}|observer:${observer}`;
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
