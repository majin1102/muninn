export type SessionIdentity = {
  project: string;
  agent: string;
  sessionId: string;
};

const SESSION_IDENTITY_SEPARATOR = '\u001f';

export function sessionIdentityKey(identity: SessionIdentity): string {
  return [
    identity.project,
    identity.agent,
    identity.sessionId,
  ].join(SESSION_IDENTITY_SEPARATOR);
}

export function sessionIdentityKeyMatches(key: string, identity: SessionIdentity): boolean {
  const parsed = parseSessionIdentityKey(key);
  return parsed !== null
    && parsed.project === identity.project
    && parsed.agent === identity.agent
    && parsed.sessionId === identity.sessionId;
}

function parseSessionIdentityKey(key: string): SessionIdentity | null {
  const parts = key.split(SESSION_IDENTITY_SEPARATOR);
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    return null;
  }
  const [project, agent, sessionId] = parts;
  return { project, agent, sessionId };
}
