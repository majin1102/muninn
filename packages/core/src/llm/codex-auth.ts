import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MIN_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

type CodexAuthFile = {
  auth_mode?: unknown;
  tokens?: {
    access_token?: unknown;
  };
};

export type CodexCliAuth = {
  accessToken: string;
  expiresAt: number;
};

export function loadCodexCliAuth(now = Date.now()): CodexCliAuth {
  const authPath = path.join(resolveCodexHome(), 'auth.json');
  const auth = readAuthFile(authPath);
  if (auth.auth_mode !== 'chatgpt') {
    throw new Error('Codex CLI auth must use ChatGPT login. Run `codex login` and sign in with ChatGPT.');
  }

  const accessToken = trimString(auth.tokens?.access_token);
  if (!accessToken) {
    throw new Error('Codex CLI auth is missing tokens.access_token. Run `codex login` again.');
  }

  const expiresAt = resolveJwtExpiry(accessToken);
  if (!expiresAt) {
    throw new Error('Codex CLI auth token is not a JWT with an exp claim. Run `codex login` again.');
  }
  if (expiresAt - now < MIN_TOKEN_TTL_MS) {
    throw new Error('Codex CLI auth token expires within 24 hours. Run `codex login` again before starting the benchmark.');
  }

  return { accessToken, expiresAt };
}

function resolveCodexHome(): string {
  const configured = trimString(process.env.CODEX_HOME);
  if (!configured) {
    return path.join(os.homedir(), '.codex');
  }
  if (configured === '~') {
    return os.homedir();
  }
  if (configured.startsWith('~/')) {
    return path.join(os.homedir(), configured.slice(2));
  }
  return path.resolve(configured);
}

function readAuthFile(authPath: string): CodexAuthFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Could not read Codex CLI auth at ${authPath}. Run \`codex login\` and sign in with ChatGPT. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Codex CLI auth at ${authPath} must be a JSON object.`);
  }
  return parsed as CodexAuthFile;
}

function resolveJwtExpiry(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const exp = (payload as { exp?: unknown }).exp;
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
}

function trimString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
