export type AgentName = string;
export type CanonicalProjectIdentity = string;
export type MuninnSessionKey = string;

export type MuninnSessionIdentity = {
  project: string;
  agent: string;
  sessionId: string;
};

export type SessionIdentity = MuninnSessionIdentity;

const SESSION_IDENTITY_SEPARATOR = '\u001f';

export function muninnSessionKey(identity: MuninnSessionIdentity): MuninnSessionKey {
  return [
    identity.project,
    identity.agent,
    identity.sessionId,
  ].join(SESSION_IDENTITY_SEPARATOR);
}

export function sessionIdentityKey(identity: SessionIdentity): MuninnSessionKey {
  return muninnSessionKey(identity);
}

export function muninnSessionKeyMatches(key: string, identity: MuninnSessionIdentity): boolean {
  const parsed = parseSessionIdentityKey(key);
  return parsed !== null
    && parsed.project === identity.project
    && parsed.agent === identity.agent
    && parsed.sessionId === identity.sessionId;
}

export function sessionIdentityKeyMatches(key: string, identity: SessionIdentity): boolean {
  return muninnSessionKeyMatches(key, identity);
}

function parseSessionIdentityKey(key: string): MuninnSessionIdentity | null {
  const parts = key.split(SESSION_IDENTITY_SEPARATOR);
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    return null;
  }
  const [project, agent, sessionId] = parts;
  return { project, agent, sessionId };
}
