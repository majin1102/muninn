import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import os from 'os';
import path from 'path';
import readline from 'readline';

const SHUTDOWN_RPC_TIMEOUT_MS = 500;

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

class RustCoreBridge {
  private process: ChildProcessWithoutNullStreams;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private exited = false;

  constructor() {
    const repoRoot = resolveRepoRoot();
    const munnaiHome = resolveMunnaiHome();
    const manifestPath = resolveManifestPath(repoRoot);

    this.process = spawn(
      'cargo',
      ['run', '--quiet', '--manifest-path', manifestPath],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          MUNNAI_HOME: munnaiHome,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    const rl = readline.createInterface({ input: this.process.stdout });
    rl.on('line', (line: string) => this.handleLine(line));

    this.process.stderr.on('data', (chunk: any) => {
      const message = chunk.toString().trim();
      if (message.length > 0) {
        console.error(`[munnai-core:rust] ${message}`);
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
      this.pending.set(id, { resolve, reject });
      this.process.stdin.write(`${payload}\n`, 'utf8', (error?: Error | null) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  async close(): Promise<void> {
    if (this.exited) {
      return;
    }

    await waitForPromiseOrTimeout(
      this.request<null>('shutdown', {}),
      SHUTDOWN_RPC_TIMEOUT_MS,
    );

    await this.waitForExit(2_000);
    if (this.exited) {
      return;
    }

    this.process.kill();
    await this.waitForExit(2_000);
  }

  private handleLine(line: string) {
    const response = JSON.parse(line) as ResponseEnvelope;
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

export async function shutdownCoreForTests(): Promise<void> {
  if (!singleton) {
    return;
  }
  const daemon = singleton;
  singleton = null;
  await daemon.close();
}

export const __testing = {
  waitForPromiseOrTimeout,
};

function resolveRepoRoot(): string {
  return path.resolve(__dirname, '../../..');
}

function resolveMunnaiHome(): string {
  return process.env.MUNNAI_HOME
    ?? path.join(os.homedir(), '.munnai');
}

function resolveManifestPath(repoRoot: string): string {
  return process.env.MUNNAI_CORE_MANIFEST_PATH
    ?? path.join(repoRoot, 'core', 'Cargo.toml');
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

const core = {
  addMessage,
  validateSettings,
  sessions,
  observings,
  memories,
  shutdownCoreForTests,
};

export default core;
