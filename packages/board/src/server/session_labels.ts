const INTERNAL_SESSION_SUFFIX = /-?[0-9a-f]{8}$/i;
const DEFAULT_AUTO_EXPAND_TURN_LIMIT = 20;

export function sessionDisplayTitle(sessionKey: string): string {
  const [, ...rest] = sessionKey.split('/');
  const raw = rest.length > 0 ? rest.join('/') : sessionKey;
  const title = raw.replace(INTERNAL_SESSION_SUFFIX, '').replace(/-+$/g, '').trim();
  return title || raw || sessionKey;
}

export function shouldAutoExpandSession(turnCount: number): boolean {
  return turnCount <= DEFAULT_AUTO_EXPAND_TURN_LIMIT;
}

export const __testing = {
  sessionDisplayTitle,
  shouldAutoExpandSession,
};
