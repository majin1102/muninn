import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_SERVER_BASE_URL = 'http://127.0.0.1:8080';

export type ServerUrlEnv = {
  MUNINN_HOME?: string;
  MUNINN_SERVER_BASE_URL?: string;
  MUNINN_BASE_URL?: string;
};

export type ResolveServerUrlOptions = {
  env?: ServerUrlEnv;
  home?: string;
};

type ServerState = {
  pid: number;
  host: string;
  port: number;
};

type MuninnConfig = {
  server?: {
    host?: string;
    port?: number;
  };
};

export function resolveMuninnServerBaseUrl(options: ResolveServerUrlOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.home ?? env.MUNINN_HOME ?? process.env.MUNINN_HOME ?? muninnHome();
  const explicit = env.MUNINN_SERVER_BASE_URL ?? env.MUNINN_BASE_URL;
  const raw = explicit ?? liveServerBaseUrl(home) ?? configuredServerBaseUrl(home) ?? DEFAULT_SERVER_BASE_URL;
  return normalizeBaseUrl(raw);
}

export function liveServerBaseUrl(home: string): string | undefined {
  const state = readJson<ServerState>(path.join(home, 'run', 'server.json'));
  if (!state || !isProcessAlive(state.pid)) {
    return undefined;
  }
  if (!state.host || !Number.isSafeInteger(state.port)) {
    return undefined;
  }
  return `http://${loopbackHost(state.host)}:${state.port}`;
}

export function configuredServerBaseUrl(home: string): string | undefined {
  const config = readJson<MuninnConfig>(path.join(home, 'muninn.json'));
  const server = config?.server;
  if (!server?.host || !Number.isSafeInteger(server.port)) {
    return undefined;
  }
  return `http://${loopbackHost(server.host)}:${server.port}`;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '') || DEFAULT_SERVER_BASE_URL;
}

function loopbackHost(host: string): string {
  return host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function muninnHome(): string {
  return path.join(os.homedir(), '.muninn');
}
