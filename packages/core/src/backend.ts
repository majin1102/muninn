import {
  __testing as nativeTesting,
  describeExtractionForStorage,
  getNativeTables,
  shutdownNativeTablesForTests,
  type NativeTables,
} from './native.js';
import {
  loadMuninnConfig,
  resolveStorageTarget,
  getEmbeddingConfig,
  getObserverLlmConfig,
  getWatchdogConfig,
  validateMuninnConfigInput,
  validateMuninnConfigStorage,
} from './config.js';
import {
  readCheckpointFile,
  type CheckpointContent,
  type CheckpointFile,
  type ObserverCheckpoint,
  type RecentTurn,
} from './checkpoint.js';
import { Memories } from './memories/memories.js';
import { Observer } from './observer/observer.js';
import { SessionRegistry } from './turn/registry.js';
import { readTurn } from './turn/types.js';
import { Watchdog } from './watchdog.js';
import type { Artifact, ToolCall, TurnContent } from '@muninn/types';

export interface Turn {
  turnId: string;
  createdAt: string;
  updatedAt: string;
  sessionId?: string | null;
  agent: string;
  observer: string;
  title?: string | null;
  summary?: string | null;
  toolCalls?: ToolCall[] | null;
  artifacts?: Artifact[] | null;
  prompt?: string | null;
  response?: string | null;
  observingEpoch?: number | null;
  previousTurnSummary?: string | null;
  recentContext?: RecentTurn[];
}

export interface SessionSnapshot {
  snapshotId: string;
  sessionId: string;
  snapshotSequence: number;
  createdAt: string;
  updatedAt: string;
  observer: string;
  title: string;
  summary: string;
  content: string;
  references: string[];
}

export interface RenderedMemory {
  memoryId: string;
  title?: string;
  summary?: string;
  detail?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecallHit {
  memoryId: string;
  text: string;
  references?: string[];
}

export type RecallMode = 'vector' | 'fts' | 'hybrid';

export interface ObserverWatermark {
  resolved: boolean;
  pendingTurnIds: string[];
  observingEpoch?: number;
  committedEpoch?: number;
}

export type ListModeInput =
  | { type: 'recency'; limit: number }
  | { type: 'page'; offset: number; limit: number };

export type { TurnContent } from '@muninn/types';

export interface CheckpointLock {
  shared<T>(operation: () => Promise<T> | T): Promise<T>;
  exclusive<T>(operation: () => Promise<T> | T): Promise<T>;
}

class AsyncCheckpointLock implements CheckpointLock {
  private activeReaders = 0;
  private activeWriter = false;
  private readonly readerWaiters: Array<() => void> = [];
  private readonly writerWaiters: Array<() => void> = [];

  async shared<T>(operation: () => Promise<T> | T): Promise<T> {
    await this.acquireShared();
    try {
      return await operation();
    } finally {
      this.releaseShared();
    }
  }

  async exclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    await this.acquireExclusive();
    try {
      return await operation();
    } finally {
      this.releaseExclusive();
    }
  }

  private acquireShared(): Promise<void> {
    if (!this.activeWriter && this.writerWaiters.length === 0) {
      this.activeReaders += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.readerWaiters.push(() => {
        this.activeReaders += 1;
        resolve();
      });
    });
  }

  private releaseShared(): void {
    this.activeReaders -= 1;
    if (this.activeReaders === 0) {
      this.wakeWaiters();
    }
  }

  private acquireExclusive(): Promise<void> {
    if (!this.activeWriter && this.activeReaders === 0) {
      this.activeWriter = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.writerWaiters.push(() => {
        this.activeWriter = true;
        resolve();
      });
    });
  }

  private releaseExclusive(): void {
    this.activeWriter = false;
    this.wakeWaiters();
  }

  private wakeWaiters(): void {
    if (this.activeWriter) {
      return;
    }
    const writer = this.writerWaiters.shift();
    if (writer) {
      writer();
      return;
    }
    while (this.readerWaiters.length > 0) {
      this.readerWaiters.shift()?.();
    }
  }
}

let singletonBackend: MuninnBackend | null = null;
let singletonBackendPromise: Promise<MuninnBackend> | null = null;
let bootstrapPromise: Promise<void> | null = null;

export class MuninnBackend {
  readonly memories: Memories;
  readonly checkpointLock: CheckpointLock;
  private observer: Observer | null = null;
  private sessionRegistry: SessionRegistry | null = null;
  private watchdog: Watchdog | null = null;

  constructor(
    private readonly client: NativeTables,
    private readonly checkpoint: CheckpointFile | null = null,
  ) {
    this.memories = new Memories(client);
    this.checkpointLock = new AsyncCheckpointLock();
    const observerName = loadMuninnConfig()?.observer?.name;
    this.sessionRegistry = observerName
      ? new SessionRegistry(client, observerName)
      : null;
  }

  static async create(client: NativeTables): Promise<MuninnBackend> {
    const checkpoint = await readCheckpointFile();
    const backend = new MuninnBackend(client, checkpoint);
    await backend.restoreCheckpointSessions();
    const watchdogConfig = getWatchdogConfig();
    if (watchdogConfig.enabled) {
      const lastCheckpointJson = checkpoint
        ? JSON.stringify({
          schemaVersion: checkpoint.schemaVersion,
          observer: checkpoint.observer,
        })
        : null;
      backend.watchdog = new Watchdog(
        client,
        watchdogConfig,
        backend,
        lastCheckpointJson,
        backend.checkpointLock,
      );
      backend.watchdog.start();
    }
    return backend;
  }

  async accept(turnContent: TurnContent): Promise<void> {
    return this.checkpointLock.shared(async () => {
      const observer = await this.ensureObserver();
      const registry = this.ensureSessionRegistry(observer.name);
      await observer.accept(turnContent, registry);
    });
  }

  async observerWatermark(): Promise<ObserverWatermark> {
    return this.checkpointLock.shared(async () => (await this.ensureObserver()).watermark());
  }

  async recallMemories(
    query: string,
    limit?: number,
    options?: { mode?: RecallMode; budget?: number; queryLimit?: number },
  ): Promise<RecallHit[]> {
    return this.memories.recall(query, limit, options);
  }

  async exportCheckpoint(): Promise<CheckpointContent | null> {
    return this.checkpointLock.exclusive(async () => {
      const observer = this.observer;
      const observerCheckpoint = observer?.exportCheckpoint();
      if (!observer || !observerCheckpoint) {
        return null;
      }
      const [turnStats, observingStats, extractionStats] = await Promise.all([
        this.client.turnTable.stats(),
        this.client.sessionTable.stats(),
        this.client.extractionTable.stats(),
      ]);
      const checkpoint: ObserverCheckpoint = {
        baseline: {
          turn: turnStats?.version ?? 0,
          session: observingStats?.version ?? 0,
          extraction: extractionStats?.version ?? 0,
        },
        committedEpoch: observerCheckpoint.committedEpoch,
        nextEpoch: observerCheckpoint.nextEpoch,
        recentSessions: this.sessionRegistry?.exportRecentSessions() ?? [],
        threads: observerCheckpoint.threads,
        runs: observerCheckpoint.runs,
      };
      return {
        schemaVersion: 4,
        observer: checkpoint,
      };
    });
  }

  async shutdown(): Promise<void> {
    if (this.observer) {
      await this.observer.shutdown();
    }
    if (this.watchdog) {
      await this.watchdog.stop({ flushCheckpoint: true });
    }
    this.watchdog = null;
    this.observer = null;
    this.sessionRegistry = null;
  }

  private async ensureObserver(): Promise<Observer> {
    if (!this.observer) {
      const checkpoint = this.checkpoint?.observer ?? null;
      this.observer = new Observer(this.client, checkpoint, this.checkpointLock);
    }
    await this.observer.ensureBootstrapped();
    return this.observer;
  }

  private ensureSessionRegistry(observerName: string): SessionRegistry {
    if (!this.sessionRegistry || this.sessionRegistry.observerName !== observerName) {
      this.sessionRegistry = new SessionRegistry(this.client, observerName);
    }
    return this.sessionRegistry;
  }

  private async restoreCheckpointSessions(): Promise<void> {
    if (!this.sessionRegistry || !this.checkpoint) {
      return;
    }
    for (const session of this.checkpoint.observer.recentSessions) {
      this.sessionRegistry.restoreSession(
        session.sessionId ?? undefined,
        session.agent,
        session.turns,
      );
    }
    const delta = await this.client.turnTable.delta({
      observer: this.sessionRegistry.observerName,
      baselineVersion: this.checkpoint.observer.baseline.turn,
    });
    for (const row of delta) {
      const turn = readTurn(row);
      if (!turn.observer || turn.observer !== this.sessionRegistry.observerName) {
        continue;
      }
      if (!turn.prompt?.trim() || !turn.response?.trim()) {
        continue;
      }
      this.sessionRegistry.rememberTurn(turn);
    }
  }
}

async function ensureBootstrapped() {
  const tables = await getNativeTables();
  if (!bootstrapPromise) {
    bootstrapPromise = bootstrap(tables).catch((error) => {
      bootstrapPromise = null;
      throw error;
    });
  }
  await bootstrapPromise;
  return tables;
}

async function bootstrap(tables: Awaited<ReturnType<typeof getNativeTables>>): Promise<void> {
  if (loadMuninnConfig()?.observer) {
    const embedding = getEmbeddingConfig();
    await tables.extractionTable.validateDimensions({ expected: embedding.dimensions });
  }
}

export async function getBackend(): Promise<MuninnBackend> {
  if (singletonBackend) {
    return singletonBackend;
  }
  if (!singletonBackendPromise) {
    singletonBackendPromise = ensureBootstrapped()
      .then((tables) => MuninnBackend.create(tables))
      .then((backend) => {
        singletonBackend = backend;
        return backend;
      })
      .catch((error) => {
        singletonBackendPromise = null;
        throw error;
      });
  }
  return singletonBackendPromise;
}

export async function addMessage(turnContent: TurnContent): Promise<void> {
  await (await getBackend()).accept(turnContent);
}

export async function validateSettings(content: string): Promise<void> {
  const config = validateMuninnConfigInput(content);
  const storage = resolveStorageTarget(config);
  const description = await describeExtractionForStorage(storage);
  await validateMuninnConfigStorage(config, description);
}

export const turns = {
  async get(memoryId: string): Promise<Turn | null> {
    return (await getBackend()).memories.getTurn(memoryId);
  },

  async list(params: {
    mode: ListModeInput;
    agent?: string;
    sessionId?: string;
  }): Promise<Turn[]> {
    return (await getBackend()).memories.listTurns(params);
  },
};

export const sessions = {
  async get(memoryId: string): Promise<SessionSnapshot | null> {
    return (await getBackend()).memories.getSession(memoryId);
  },

  async list(params: {
    mode: ListModeInput;
    observer?: string;
  }): Promise<SessionSnapshot[]> {
    return (await getBackend()).memories.listSessions(params);
  },
};

export const memories = {
  async get(memoryId: string): Promise<RenderedMemory | null> {
    return (await getBackend()).memories.get(memoryId);
  },

  async list(params: {
    mode: ListModeInput;
  }): Promise<RenderedMemory[]> {
    return (await getBackend()).memories.list(params);
  },

  async timeline(params: {
    memoryId: string;
    beforeLimit?: number;
    afterLimit?: number;
  }): Promise<RenderedMemory[]> {
    return (await getBackend()).memories.timeline(params);
  },

  async recall(
    query: string,
    limit?: number,
    options?: { mode?: RecallMode; budget?: number; queryLimit?: number },
  ): Promise<RecallHit[]> {
    return (await getBackend()).recallMemories(query, limit, options);
  },
};

export const observer = {
  async watermark(): Promise<ObserverWatermark> {
    return (await getBackend()).observerWatermark();
  },
};

export async function shutdownCoreForTests(): Promise<void> {
  const backend = singletonBackend ?? (singletonBackendPromise ? await singletonBackendPromise : null);
  if (backend) {
    await backend.shutdown();
  }
  singletonBackend = null;
  singletonBackendPromise = null;
  bootstrapPromise = null;
  await shutdownNativeTablesForTests();
}

export const __testing = {
  ...nativeTesting,
  shutdownCoreForTests,
};

const core = {
  addMessage,
  validateSettings,
  turns,
  sessions,
  memories,
  observer,
  shutdownCoreForTests,
};

export default core;
