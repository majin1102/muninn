import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { resolveRunEnv, type RunOptions } from './run.js';

export type ServerProcessOptions = RunOptions & {
  force?: boolean;
  startTimeoutMs?: number;
};

export type ServerProcessPaths = {
  runDir: string;
  stateFile: string;
  stdoutLog: string;
  stderrLog: string;
};

export type ServerProcessState = {
  pid: number;
  host: string;
  port: number;
  home: string;
  startedAt: string;
};

export type StartServerResult = {
  state: ServerProcessState;
  paths: ServerProcessPaths;
};

export type StopServerResult = {
  stopped: boolean;
  message: string;
  paths: ServerProcessPaths;
};

const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 100;

export function resolveServerProcessPaths(home: string): ServerProcessPaths {
  const runDir = path.join(home, 'run');
  return {
    runDir,
    stateFile: path.join(runDir, 'server.json'),
    stdoutLog: path.join(runDir, 'server.stdout.log'),
    stderrLog: path.join(runDir, 'server.stderr.log'),
  };
}

export async function startManagedServer(
  options: ServerProcessOptions,
  cliEntryPath: string,
): Promise<StartServerResult> {
  const env = resolveRunEnv(options);
  const paths = resolveServerProcessPaths(env.MUNINN_HOME);
  await mkdir(paths.runDir, { recursive: true });

  const existing = await readServerState(paths);
  if (existing && isProcessAlive(existing.pid)) {
    if (!options.force) {
      throw new Error(`Muninn server is already running with pid ${existing.pid}. Use --force to restart it.`);
    }
    await killPid(existing.pid, true, STOP_TIMEOUT_MS);
  }
  if (existing && !isProcessAlive(existing.pid)) {
    await rm(paths.stateFile, { force: true });
  }

  const stdoutFd = openSync(paths.stdoutLog, 'a');
  const stderrFd = openSync(paths.stderrLog, 'a');
  const child = spawn(process.execPath, [
    path.resolve(cliEntryPath),
    'run',
    '--host',
    env.HOST,
    '--port',
    env.PORT,
    '--home',
    env.MUNINN_HOME,
  ], {
    detached: true,
    env: {
      ...process.env,
      HOST: env.HOST,
      PORT: env.PORT,
      MUNINN_HOME: env.MUNINN_HOME,
    },
    stdio: ['ignore', stdoutFd, stderrFd],
  });
  closeSync(stdoutFd);
  closeSync(stderrFd);
  child.unref();

  if (!child.pid) {
    throw new Error('Failed to start Muninn server process.');
  }

  const childExit = new Promise<never>((_, reject) => {
    child.once('exit', (code, signal) => {
      reject(new Error(`Muninn server exited before becoming healthy: code ${code ?? 'null'}, signal ${signal ?? 'null'}.`));
    });
    child.once('error', reject);
  });

  try {
    await Promise.race([
      waitForHealth(env.HOST, Number(env.PORT), options.startTimeoutMs ?? START_TIMEOUT_MS),
      childExit,
    ]);
  } catch (error) {
    await killPid(child.pid, true, STOP_TIMEOUT_MS).catch(() => undefined);
    throw error;
  }

  const state: ServerProcessState = {
    pid: child.pid,
    host: env.HOST,
    port: Number(env.PORT),
    home: env.MUNINN_HOME,
    startedAt: new Date().toISOString(),
  };
  await writeFile(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);
  return { state, paths };
}

export async function stopManagedServer(options: {
  home?: string;
  force?: boolean;
} = {}): Promise<StopServerResult> {
  const env = resolveRunEnv({ home: options.home });
  const paths = resolveServerProcessPaths(env.MUNINN_HOME);
  const state = await readServerState(paths);
  if (!state) {
    return {
      stopped: false,
      message: 'No CLI-managed Muninn server is running.',
      paths,
    };
  }

  if (!isProcessAlive(state.pid)) {
    await rm(paths.stateFile, { force: true });
    return {
      stopped: false,
      message: `Removed stale Muninn server state for pid ${state.pid}.`,
      paths,
    };
  }

  await killPid(state.pid, options.force === true, STOP_TIMEOUT_MS);
  await rm(paths.stateFile, { force: true });
  return {
    stopped: true,
    message: `Stopped Muninn server pid ${state.pid}.`,
    paths,
  };
}

export async function restartManagedServer(
  options: ServerProcessOptions,
  cliEntryPath: string,
): Promise<StartServerResult> {
  await stopManagedServer({
    home: options.home,
    force: options.force,
  });
  return startManagedServer(options, cliEntryPath);
}

async function readServerState(paths: ServerProcessPaths): Promise<ServerProcessState | undefined> {
  let raw: string;
  try {
    raw = await readFile(paths.stateFile, 'utf8');
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
  const value = JSON.parse(raw) as Partial<ServerProcessState>;
  if (
    typeof value.pid !== 'number'
    || typeof value.host !== 'string'
    || typeof value.port !== 'number'
    || typeof value.home !== 'string'
    || typeof value.startedAt !== 'string'
  ) {
    throw new Error(`Invalid Muninn server state file: ${paths.stateFile}`);
  }
  return value as ServerProcessState;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killPid(pid: number, force: boolean, timeoutMs: number): Promise<void> {
  if (!isProcessAlive(pid)) {
    return;
  }
  process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
  const stopped = await waitForExit(pid, timeoutMs);
  if (!stopped) {
    throw new Error(`Muninn server pid ${pid} did not stop. Retry with --force.`);
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await delay(POLL_INTERVAL_MS);
  }
  return !isProcessAlive(pid);
}

async function waitForHealth(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await checkHealth(host, port)) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Muninn server did not become healthy within ${timeoutMs}ms: ${lastError instanceof Error ? lastError.message : 'timeout'}`);
}

export function resolveHealthHost(host: string): string {
  if (host === '0.0.0.0') {
    return '127.0.0.1';
  }
  if (host === '::') {
    return '::1';
  }
  return host;
}

export function checkHealth(host: string, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const request = http.get({
      host: resolveHealthHost(host),
      port,
      path: '/health',
      timeout: 1_000,
      agent: false,
    }, (response) => {
      response.resume();
      resolve((response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300);
    });
    request.once('timeout', () => {
      request.destroy(new Error('health request timed out'));
    });
    request.once('error', reject);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
