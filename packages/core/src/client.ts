import { accessSync, constants as fsConstants } from 'fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import os from 'os';
import path from 'path';
import readline from 'readline';

const SHUTDOWN_RPC_TIMEOUT_MS = 500;
const DEFAULT_DAEMON_COMMAND = 'muninn-core';
const DAEMON_PATH_ENV = 'MUNINN_CORE_DAEMON_PATH';
const DAEMON_COMMAND_ENV = 'MUNINN_CORE_DAEMON_COMMAND';
const CARGO_FALLBACK_ENV = 'MUNINN_CORE_ALLOW_CARGO_FALLBACK';

export interface SessionTurnRecord {
  turnId: string;
  createdAt: string;
  updatedAt: string;
  session_id?: string;
  agent: string;
  observer: string;
  title?: string;
  summary?: string;
  toolCalling?: string[];
  artifacts?: Record<string, string>;
  prompt?: string;
  response?: string;
  observingEpoch?: number;
}

export interface ObservingRecord {
  snapshotId: string;
  observingId: string;
  snapshotSequence: number;
  createdAt: string;
  updatedAt: string;
  observer: string;
  title: string;
  summary: string;
  content: string;
  references: string[];
  checkpoint: {
    observingEpoch: number;
    indexedSnapshotSequence?: number;
  };
}

export interface RenderedMemoryRecord {
  memoryId: string;
  title?: string;
  summary?: string;
  detail?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecallHitRecord {
  memoryId: string;
  text: string;
}

export interface ObserverWatermarkRecord {
  resolved: boolean;
  pendingTurnIds: string[];
}

export type ListModeInput =
  | { type: 'recency'; limit: number }
  | { type: 'page'; offset: number; limit: number };

type RawObservingRecord = {
  snapshotId?: string;
  observingId?: string;
  snapshotSequence?: number;
  createdAt: string;
  updatedAt: string;
  observer: string;
  title: string;
  summary: string;
  content: string;
  references?: string[];
  checkpoint: {
    observingEpoch: number;
    indexedSnapshotSequence?: number | null;
  };
};

type RawRenderedMemoryRecord = {
  memoryId: string;
  title?: string | null;
  summary?: string | null;
  detail?: string | null;
  createdAt: string;
  updatedAt: string;
};

type RawRecallHitRecord = {
  memoryId: string;
  text: string;
};

type RawObserverWatermarkRecord = {
  resolved: boolean;
  pendingTurnIds?: string[];
};

export interface SessionMessageInput {
  session_id?: string;
  agent: string;
  title?: string;
  summary?: string;
  tool_calling?: string[];
  artifacts?: Record<string, string>;
  prompt?: string;
  response?: string;
}

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: unknown): void;
};

type ResponseEnvelope = {
  id: number;
  ok: boolean;
  data?: unknown;
  error?: string;
};

type DaemonLaunchSpec = {
  command: string;
  args: string[];
  cwd?: string;
  description: string;
  source: 'path' | 'command' | 'cargo-fallback';
};

class RustCoreBridge {
  private process: ChildProcessWithoutNullStreams;
  private readonly launchSpec: DaemonLaunchSpec;
  private readonly started: Promise<void>;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private exited = false;

  constructor() {
    const muninnHome = resolveMuninnHome();
    this.launchSpec = resolveDaemonLaunchSpec();

    this.process = spawn(
      this.launchSpec.command,
      this.launchSpec.args,
      {
        cwd: this.launchSpec.cwd,
        env: {
          ...process.env,
          MUNINN_HOME: muninnHome,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    this.started = new Promise<void>((resolve, reject) => {
      this.process.once('spawn', () => resolve());
      this.process.once('error', (error: Error) => {
        reject(formatDaemonStartError(this.launchSpec, error));
      });
      this.process.once('exit', (code: number | null, signal: string | null) => {
        if (!this.exited) {
          reject(formatDaemonExitError(this.launchSpec, code, signal));
        }
      });
    });
    this.started.catch(() => undefined);

    const rl = readline.createInterface({ input: this.process.stdout });
    rl.on('line', (line: string) => this.handleLine(line));

    this.process.stderr.on('data', (chunk: any) => {
      const message = chunk.toString().trim();
      if (message.length > 0) {
        console.error(`[muninn-core:rust] ${message}`);
      }
    });

    this.process.on('exit', (code: number | null, signal: string | null) => {
      this.exited = true;
      const error = new Error(`Rust daemon exited (${signal ?? code ?? 'unknown'})`);
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
      singleton = null;
    });
  }

  request<T>(method: string, params: object): Promise<T> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });

    return new Promise<T>((resolve, reject) => {
      void this.started.then(
        () => {
          this.pending.set(id, { resolve, reject });
          this.process.stdin.write(`${payload}\n`, 'utf8', (error?: Error | null) => {
            if (error) {
              this.pending.delete(id);
              reject(error);
            }
          });
        },
        (error) => reject(error),
      );
    });
  }

  async close(): Promise<void> {
    if (this.exited) {
      return;
    }

    try {
      await this.started;
    } catch {
      return;
    }

    await waitForPromiseOrTimeout(this.request<null>('shutdown', {}), SHUTDOWN_RPC_TIMEOUT_MS);

    await this.waitForExit(2_000);
    if (this.exited) {
      return;
    }

    this.process.kill();
    await this.waitForExit(2_000);
  }

  private handleLine(line: string) {
    let response: ResponseEnvelope;
    try {
      response = JSON.parse(line) as ResponseEnvelope;
    } catch (error) {
      console.error(`[muninn-core:rust] invalid JSON response: ${(error as Error).message}`);
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    this.pending.delete(response.id);

    if (response.ok) {
      pending.resolve(response.data);
    } else {
      pending.reject(new Error(response.error ?? 'unknown rust daemon error'));
    }
  }

  private waitForExit(timeoutMs: number): Promise<void> {
    if (this.exited) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const onExit = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.process.off('exit', onExit);
        resolve();
      }, timeoutMs);
      this.process.once('exit', onExit);
    });
  }
}

async function waitForPromiseOrTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = promise.then(
    () => true,
    () => true,
  );
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const result = await Promise.race([settled, timeout]);
  if (timer) {
    clearTimeout(timer);
  }
  return result;
}

let singleton: RustCoreBridge | null = null;

function getDaemon(): RustCoreBridge {
  if (!singleton) {
    singleton = new RustCoreBridge();
  }
  return singleton;
}

export async function addMessage(session: SessionMessageInput): Promise<SessionTurnRecord> {
  return getDaemon().request<SessionTurnRecord>('addMessage', {
    session_id: session.session_id,
    agent: session.agent,
    title: session.title,
    summary: session.summary,
    toolCalling: session.tool_calling,
    artifacts: session.artifacts,
    prompt: session.prompt,
    response: session.response,
  });
}

export async function validateSettings(content: string): Promise<void> {
  await getDaemon().request<null>('settings.validate', { content });
}

export const sessions = {
  async get(memoryId: string): Promise<SessionTurnRecord | null> {
    return getDaemon().request<SessionTurnRecord | null>('sessions.get', { memoryId });
  },

  async list(params: {
    mode: ListModeInput;
    agent?: string;
    sessionId?: string;
  }): Promise<SessionTurnRecord[]> {
    return getDaemon().request<SessionTurnRecord[]>('sessions.list', {
      mode: params.mode,
      agent: params.agent,
      session_id: params.sessionId,
    });
  },
};

export const observings = {
  async get(memoryId: string): Promise<ObservingRecord | null> {
    const row = await getDaemon().request<RawObservingRecord | null>('observings.get', { memoryId });
    return row ? normalizeObservingRecord(row) : null;
  },

  async list(params: {
    mode: ListModeInput;
    observer?: string;
  }): Promise<ObservingRecord[]> {
    const rows = await getDaemon().request<RawObservingRecord[]>('observings.list', {
      mode: params.mode,
      observer: params.observer,
    });
    return rows.map(normalizeObservingRecord);
  },
};

export const memories = {
  async get(memoryId: string): Promise<RenderedMemoryRecord | null> {
    const row = await getDaemon().request<RawRenderedMemoryRecord | null>('memories.get', { memoryId });
    return row ? normalizeRenderedMemoryRecord(row) : null;
  },

  async list(params: {
    mode: ListModeInput;
  }): Promise<RenderedMemoryRecord[]> {
    const rows = await getDaemon().request<RawRenderedMemoryRecord[]>('memories.list', {
      mode: params.mode,
    });
    return rows.map(normalizeRenderedMemoryRecord);
  },

  async timeline(params: {
    memoryId: string;
    beforeLimit?: number;
    afterLimit?: number;
  }): Promise<RenderedMemoryRecord[]> {
    const rows = await getDaemon().request<RawRenderedMemoryRecord[]>('memories.timeline', {
      memoryId: params.memoryId,
      beforeLimit: params.beforeLimit,
      afterLimit: params.afterLimit,
    });
    return rows.map(normalizeRenderedMemoryRecord);
  },

  async recall(query: string, limit?: number): Promise<RecallHitRecord[]> {
    const rows = await getDaemon().request<RawRecallHitRecord[]>('memories.recall', { query, limit });
    return rows.map(normalizeRecallHitRecord);
  },
};

export const observer = {
  async watermark(): Promise<ObserverWatermarkRecord> {
    const row = await getDaemon().request<RawObserverWatermarkRecord>('observer.watermark', {
    });
    return normalizeObserverWatermarkRecord(row);
  },
};

export async function shutdownCoreForTests(): Promise<void> {
  if (!singleton) {
    return;
  }
  const daemon = singleton;
  singleton = null;
  await daemon.close();
}

function resolveRepoRoot(): string {
  return path.resolve(__dirname, '../../..');
}

function resolveMuninnHome(): string {
  return process.env.MUNINN_HOME
    ?? path.join(os.homedir(), '.muninn');
}

function resolveManifestPath(repoRoot: string): string {
  return process.env.MUNINN_CORE_MANIFEST_PATH
    ?? path.join(repoRoot, 'core', 'Cargo.toml');
}

function resolveDaemonLaunchSpec(): DaemonLaunchSpec {
  const explicitPath = trimEnv(process.env[DAEMON_PATH_ENV]);
  if (explicitPath) {
    validateExplicitDaemonPath(explicitPath);
    return {
      command: explicitPath,
      args: [],
      cwd: undefined,
      description: `${DAEMON_PATH_ENV}=${explicitPath}`,
      source: 'path',
    };
  }

  const explicitCommand = trimEnv(process.env[DAEMON_COMMAND_ENV]);
  if (explicitCommand) {
    return {
      command: explicitCommand,
      args: [],
      cwd: undefined,
      description: `${DAEMON_COMMAND_ENV}=${explicitCommand}`,
      source: 'command',
    };
  }

  const bundledPath = resolveBundledDaemonPath();
  if (bundledPath) {
    return {
      command: bundledPath,
      args: [],
      cwd: undefined,
      description: `bundled daemon at ${bundledPath}`,
      source: 'path',
    };
  }

  if (process.env[CARGO_FALLBACK_ENV] === '1') {
    const repoRoot = resolveRepoRoot();
    const manifestPath = resolveManifestPath(repoRoot);
    return {
      command: 'cargo',
      args: ['run', '--quiet', '--manifest-path', manifestPath],
      cwd: repoRoot,
      description: `${CARGO_FALLBACK_ENV}=1 (cargo fallback)`,
      source: 'cargo-fallback',
    };
  }

  return {
    command: DEFAULT_DAEMON_COMMAND,
    args: [],
    cwd: undefined,
    description: `${DEFAULT_DAEMON_COMMAND} on PATH`,
    source: 'command',
  };
}

function trimEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveBundledDaemonPath(): string | undefined {
  const candidate = path.resolve(
    __dirname,
    '..',
    'bin',
    resolveBundledDaemonExecutableName(),
  );
  try {
    accessSync(candidate, fsConstants.X_OK);
    return candidate;
  } catch {
    return undefined;
  }
}

function resolveBundledDaemonExecutableName(platform = process.platform): string {
  return platform === 'win32' ? `${DEFAULT_DAEMON_COMMAND}.exe` : DEFAULT_DAEMON_COMMAND;
}

function validateExplicitDaemonPath(daemonPath: string): void {
  try {
    accessSync(daemonPath, fsConstants.X_OK);
  } catch (error) {
    throw new Error(
      `Unable to use ${DAEMON_PATH_ENV}=${daemonPath}: ${(error as Error).message}`,
    );
  }
}

function formatDaemonStartError(spec: DaemonLaunchSpec, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (isMissingExecutableError(error)) {
    return new Error([
      `Unable to start the Muninn core daemon (${spec.description}).`,
      `Set ${DAEMON_PATH_ENV} to an executable daemon binary or install ${DEFAULT_DAEMON_COMMAND} on PATH.`,
      `For local development only, set ${CARGO_FALLBACK_ENV}=1 to opt back into the source-tree cargo fallback.`,
      `Original error: ${message}`,
    ].join(' '));
  }

  return new Error(`Unable to start the Muninn core daemon (${spec.description}): ${message}`);
}

function formatDaemonExitError(
  spec: DaemonLaunchSpec,
  code: number | null,
  signal: string | null,
): Error {
  return new Error(
    `Muninn core daemon exited before it became ready (${spec.description}) with ${
      signal ?? code ?? 'unknown'
    }`,
  );
}

function isMissingExecutableError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT',
  );
}

function normalizeObservingRecord(row: RawObservingRecord): ObservingRecord {
  return {
    snapshotId: row.snapshotId ?? '',
    observingId: row.observingId ?? '',
    snapshotSequence: row.snapshotSequence ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    observer: row.observer,
    title: row.title,
    summary: row.summary,
    content: row.content,
    references: row.references ?? [],
    checkpoint: {
      observingEpoch: row.checkpoint.observingEpoch,
      indexedSnapshotSequence: row.checkpoint.indexedSnapshotSequence ?? undefined,
    },
  };
}

function normalizeRenderedMemoryRecord(row: RawRenderedMemoryRecord): RenderedMemoryRecord {
  return {
    memoryId: row.memoryId,
    title: row.title ?? undefined,
    summary: row.summary ?? undefined,
    detail: row.detail ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeRecallHitRecord(row: RawRecallHitRecord): RecallHitRecord {
  return {
    memoryId: row.memoryId,
    text: row.text,
  };
}

function normalizeObserverWatermarkRecord(
  row: RawObserverWatermarkRecord,
): ObserverWatermarkRecord {
  return {
    resolved: row.resolved,
    pendingTurnIds: row.pendingTurnIds ?? [],
  };
}

export const __testing = {
  waitForPromiseOrTimeout,
  resolveRepoRoot,
  resolveDaemonLaunchSpec,
  resolveBundledDaemonExecutableName,
  formatDaemonStartError,
  formatDaemonExitError,
};

const core = {
  addMessage,
  validateSettings,
  sessions,
  observings,
  memories,
  observer,
  shutdownCoreForTests,
};

export default core;
