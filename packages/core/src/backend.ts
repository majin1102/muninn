import {
  __testing as nativeTesting,
  createNativeTables,
  describeExtractionForStorage,
  getNativeTables,
  shutdownNativeTablesForTests,
  type NativeTables,
} from './native.js';
import {
  loadMuninnConfig,
  resolveDatabaseName,
  resolveStorageTarget,
  getEmbeddingConfig,
  getExtractorLlmConfig,
  getObserverLlmConfig,
  getWatchdogConfig,
  validateMuninnConfigInput,
  validateMuninnConfigStorage,
} from './config.js';
import {
  readCheckpointFile,
  type CheckpointContent,
  type CheckpointFile,
  type ExtractorCheckpoint,
  type ObserverCheckpoint,
  type RecentTurn,
} from './checkpoint.js';
import { Memories } from './memories/memories.js';
import { Extractor } from './extractor/extractor.js';
import { Observer } from './observer/observer.js';
import { SessionRegistry } from './turn/registry.js';
import { readTurn } from './turn/types.js';
import { Watchdog } from './watchdog.js';
import { TableMutationLocks, lockNativeTables } from './table-locks.js';
import { writeMuninnLog } from './logging.js';
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

export interface MemoryWatermark {
  resolved: boolean;
  pendingTurnIds: string[];
  extractingEpoch?: number;
  committedEpoch?: number;
  observerPending?: boolean;
  observerQueuedCount?: number;
  observerReadyCount?: number;
  observerReadyBucketCount?: number;
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

const backendCache = new Map<string, MuninnBackend>();
const backendPromises = new Map<string, Promise<MuninnBackend>>();
const bootstrapPromises = new Map<string, Promise<void>>();

export class MuninnBackend {
  readonly memories: Memories;
  readonly checkpointLock: CheckpointLock;
  private extractor: Extractor | null = null;
  private observer: Observer | null = null;
  private sessionRegistry: SessionRegistry | null = null;
  private watchdog: Watchdog | null = null;
  private watchdogClient: NativeTables | null = null;

  private constructor(
    private readonly client: NativeTables,
    private readonly database: string,
    private readonly checkpoint: CheckpointFile | null = null,
  ) {
    this.memories = new Memories(client);
    this.checkpointLock = new AsyncCheckpointLock();
    const extractorName = loadMuninnConfig()?.extractor?.name;
    this.sessionRegistry = extractorName
      ? new SessionRegistry(client, extractorName)
      : null;
  }

  static async create(client: NativeTables, database?: string | null): Promise<MuninnBackend> {
    const databaseName = resolveDatabaseName(database);
    const checkpoint = await readCheckpointFile(databaseName);
    const tableLocks = new TableMutationLocks();
    const backend = new MuninnBackend(lockNativeTables(client, tableLocks), databaseName, checkpoint);
    await backend.restoreCheckpointSessions();
    const watchdogConfig = getWatchdogConfig();
    if (watchdogConfig.enabled) {
      const lastCheckpointJson = checkpoint
        ? JSON.stringify({
          schemaVersion: checkpoint.schemaVersion,
          extractor: checkpoint.extractor,
          observer: checkpoint.observer,
        })
        : null;
      const watchdogClient = lockNativeTables(
        await createNativeTables(resolveStorageTarget(loadMuninnConfig() ?? {}, databaseName)),
        tableLocks,
      );
      backend.watchdogClient = watchdogClient;
      backend.watchdog = new Watchdog(
        watchdogClient,
        watchdogConfig,
        backend,
        lastCheckpointJson,
        backend.checkpointLock,
        databaseName,
      );
      backend.watchdog.start();
    }
    return backend;
  }

  static createForTests(client: NativeTables, checkpoint: CheckpointFile | null = null): MuninnBackend {
    return new MuninnBackend(lockNativeTables(client, new TableMutationLocks()), 'main', checkpoint);
  }

  async accept(turnContent: TurnContent): Promise<void> {
    return this.checkpointLock.shared(async () => {
      await this.ensureObserver();
      const extractor = await this.ensureExtractor();
      const registry = this.ensureSessionRegistry(extractor.name);
      await extractor.accept(turnContent, registry);
    });
  }

  async memoryWatermark(): Promise<MemoryWatermark> {
    return this.checkpointLock.shared(async () => {
      const observer = await this.ensureObserver();
      const extractor = await this.ensureExtractor();
      const extractorWatermark = await extractor.watermark();
      const observerWatermark = await observer.watermark();
      return {
        resolved: extractorWatermark.resolved && observerWatermark.resolved,
        pendingTurnIds: extractorWatermark.pendingTurnIds,
        extractingEpoch: extractorWatermark.extractingEpoch,
        committedEpoch: extractorWatermark.committedEpoch,
        observerPending: observerWatermark.observerPending,
        observerQueuedCount: observerWatermark.observerQueuedCount,
        observerReadyCount: observerWatermark.observerReadyCount,
        observerReadyBucketCount: observerWatermark.observerReadyBucketCount,
      };
    });
  }

  async memoryFinalize(): Promise<MemoryWatermark> {
    const { observer, extractor } = await this.checkpointLock.shared(async () => {
      const observer = await this.ensureObserver();
      const extractor = await this.ensureExtractor();
      return { observer, extractor };
    });
    await extractor.flushPending();
    const extractorWatermark = await extractor.watermark();
    const observerWatermark = await observer.finalize();
    const watermark = {
      resolved: extractorWatermark.resolved && observerWatermark.resolved,
      pendingTurnIds: extractorWatermark.pendingTurnIds,
      extractingEpoch: extractorWatermark.extractingEpoch,
      committedEpoch: extractorWatermark.committedEpoch,
      observerPending: observerWatermark.observerPending,
      observerQueuedCount: observerWatermark.observerQueuedCount,
      observerReadyCount: observerWatermark.observerReadyCount,
      observerReadyBucketCount: observerWatermark.observerReadyBucketCount,
    };
    await this.watchdog?.flushCheckpoint();
    return watermark;
  }

  async recallMemories(
    query: string,
    limit?: number,
    options?: { mode?: RecallMode; budget?: number; queryLimit?: number },
  ): Promise<RecallHit[]> {
    await writeMuninnLog(this.database, 'info', 'recall', 'query', {
      query,
      limit,
      mode: options?.mode,
      budget: options?.budget,
      queryLimit: options?.queryLimit,
    });
    return this.memories.recall(query, limit, options);
  }

  async exportCheckpoint(): Promise<CheckpointContent | null> {
    return this.checkpointLock.exclusive(async () => {
      const extractor = this.extractor;
      const observer = this.observer;
      const extractorCheckpoint = extractor?.exportCheckpoint();
      const observerCheckpoint = observer?.exportCheckpoint();
      if (!extractor || !extractorCheckpoint || !observer || !observerCheckpoint) {
        return null;
      }
      const [turnStats, sessionStats, extractionStats, observationStats] = await Promise.all([
        this.client.turnTable.stats(),
        this.client.sessionTable.stats(),
        this.client.extractionTable.stats(),
        this.client.observationTable.stats(),
      ]);
      const extractorSection: ExtractorCheckpoint = {
        baseline: {
          turn: turnStats?.version ?? 0,
          session: sessionStats?.version ?? 0,
          extraction: extractionStats?.version ?? 0,
          observation: observationStats?.version ?? 0,
        },
        committedEpoch: extractorCheckpoint.committedEpoch,
        nextEpoch: extractorCheckpoint.nextEpoch,
        recentSessions: this.sessionRegistry?.exportRecentSessions() ?? [],
        threads: extractorCheckpoint.threads,
        runs: extractorCheckpoint.runs,
        pendingExtractionChanges: extractorCheckpoint.pendingExtractionChanges,
      };
      const observerSection: ObserverCheckpoint = {
        baseline: observerCheckpoint.baseline,
        observeQueue: observerCheckpoint.observeQueue,
        runs: observerCheckpoint.runs,
      };
      return {
        schemaVersion: 6,
        extractor: extractorSection,
        observer: observerSection,
      };
    });
  }

  async shutdown(): Promise<void> {
    if (this.extractor) {
      await this.extractor.shutdown();
    }
    if (this.observer) {
      await this.observer.shutdown();
    }
    if (this.watchdog) {
      await this.watchdog.stop({ flushCheckpoint: true });
    }
    if (this.watchdogClient) {
      await this.watchdogClient.close();
    }
    this.watchdog = null;
    this.watchdogClient = null;
    this.extractor = null;
    this.observer = null;
    this.sessionRegistry = null;
  }

  private async ensureExtractor(): Promise<Extractor> {
    if (!this.extractor) {
      const checkpoint = this.checkpoint?.extractor ?? null;
      this.extractor = new Extractor(
        this.client,
        checkpoint,
        this.checkpointLock,
        (changes) => {
          if (changes.length > 0) {
            this.observer?.enqueue(changes);
          }
          this.observer?.notify();
        },
        this.database,
      );
    }
    await this.extractor.ensureBootstrapped();
    return this.extractor;
  }

  private async ensureObserver(): Promise<Observer> {
    if (!this.observer) {
      const checkpoint = this.checkpoint?.observer ?? null;
      this.observer = new Observer(this.client, checkpoint, this.checkpointLock, this.database);
    }
    this.observer.start();
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
    for (const session of this.checkpoint.extractor.recentSessions) {
      this.sessionRegistry.restoreSession(
        session.sessionId ?? undefined,
        session.agent,
        session.turns,
      );
    }
    const delta = await this.client.turnTable.delta({
      observer: this.sessionRegistry.observerName,
      baselineVersion: this.checkpoint.extractor.baseline.turn,
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

async function ensureBootstrapped(database?: string | null) {
  const databaseName = resolveDatabaseName(database);
  const tables = await getNativeTables(resolveStorageTarget(loadMuninnConfig() ?? {}, databaseName));
  if (!bootstrapPromises.has(databaseName)) {
    const promise = bootstrap(tables).catch((error) => {
      bootstrapPromises.delete(databaseName);
      throw error;
    });
    bootstrapPromises.set(databaseName, promise);
  }
  await bootstrapPromises.get(databaseName);
  return tables;
}

async function bootstrap(tables: Awaited<ReturnType<typeof getNativeTables>>): Promise<void> {
  if (loadMuninnConfig()?.extractor) {
    const embedding = getEmbeddingConfig();
    await tables.extractionTable.validateDimensions({ expected: embedding.dimensions });
  }
}

export async function getBackend(database?: string | null): Promise<MuninnBackend> {
  const databaseName = resolveDatabaseName(database);
  const cached = backendCache.get(databaseName);
  if (cached) {
    return cached;
  }
  const pending = backendPromises.get(databaseName);
  if (pending) {
    return pending;
  }
  const promise = ensureBootstrapped(databaseName)
      .then((tables) => MuninnBackend.create(tables, databaseName))
      .then((backend) => {
        backendCache.set(databaseName, backend);
        return backend;
      })
      .catch((error) => {
        backendPromises.delete(databaseName);
        throw error;
      });
  backendPromises.set(databaseName, promise);
  return promise;
}

export async function addMessage(turnContent: TurnContent, database?: string | null): Promise<void> {
  const databaseName = resolveDatabaseName(database);
  await writeMuninnLog(databaseName, 'info', 'sidecar', 'turn_capture', {
    sessionId: turnContent.sessionId,
    agent: turnContent.agent,
  });
  await (await getBackend(databaseName)).accept(turnContent);
}

export async function validateSettings(content: string): Promise<void> {
  const config = validateMuninnConfigInput(content);
  const storage = resolveStorageTarget(config);
  const description = await describeExtractionForStorage(storage);
  await validateMuninnConfigStorage(config, description);
}

export const turns = {
  async get(memoryId: string, database?: string | null): Promise<Turn | null> {
    const databaseName = resolveDatabaseName(database);
    await writeMuninnLog(databaseName, 'info', 'detail', 'turn_get', { memoryId });
    return (await getBackend(databaseName)).memories.getTurn(memoryId);
  },

  async list(params: {
    mode: ListModeInput;
    agent?: string;
    sessionId?: string;
    database?: string | null;
  }): Promise<Turn[]> {
    const databaseName = resolveDatabaseName(params.database);
    await writeMuninnLog(databaseName, 'info', 'list', 'turn_list', {
      mode: params.mode.type,
      limit: 'limit' in params.mode ? params.mode.limit : undefined,
      agent: params.agent,
      sessionId: params.sessionId,
    });
    return (await getBackend(databaseName)).memories.listTurns(params);
  },
};

export const sessions = {
  async get(memoryId: string, database?: string | null): Promise<SessionSnapshot | null> {
    const databaseName = resolveDatabaseName(database);
    await writeMuninnLog(databaseName, 'info', 'detail', 'session_get', { memoryId });
    return (await getBackend(databaseName)).memories.getSession(memoryId);
  },

  async list(params: {
    mode: ListModeInput;
    observer?: string;
    database?: string | null;
  }): Promise<SessionSnapshot[]> {
    const databaseName = resolveDatabaseName(params.database);
    await writeMuninnLog(databaseName, 'info', 'list', 'session_list', {
      mode: params.mode.type,
      limit: 'limit' in params.mode ? params.mode.limit : undefined,
      observer: params.observer,
    });
    return (await getBackend(databaseName)).memories.listSessions(params);
  },
};

export const memories = {
  async get(memoryId: string, database?: string | null): Promise<RenderedMemory | null> {
    const databaseName = resolveDatabaseName(database);
    await writeMuninnLog(databaseName, 'info', 'detail', 'memory_get', { memoryId });
    return (await getBackend(databaseName)).memories.get(memoryId);
  },

  async list(params: {
    mode: ListModeInput;
    database?: string | null;
  }): Promise<RenderedMemory[]> {
    const databaseName = resolveDatabaseName(params.database);
    await writeMuninnLog(databaseName, 'info', 'list', 'memory_list', {
      mode: params.mode.type,
      limit: 'limit' in params.mode ? params.mode.limit : undefined,
    });
    return (await getBackend(databaseName)).memories.list(params);
  },

  async timeline(params: {
    memoryId: string;
    beforeLimit?: number;
    afterLimit?: number;
    database?: string | null;
  }): Promise<RenderedMemory[]> {
    const databaseName = resolveDatabaseName(params.database);
    await writeMuninnLog(databaseName, 'info', 'timeline', 'memory_timeline', {
      memoryId: params.memoryId,
      beforeLimit: params.beforeLimit,
      afterLimit: params.afterLimit,
    });
    return (await getBackend(databaseName)).memories.timeline(params);
  },

  async recall(
    query: string,
    limit?: number,
    options?: { mode?: RecallMode; budget?: number; queryLimit?: number; database?: string | null },
  ): Promise<RecallHit[]> {
    return (await getBackend(options?.database)).recallMemories(query, limit, options);
  },
};

export const observer = {
  async watermark(database?: string | null): Promise<MemoryWatermark> {
    return (await getBackend(database)).memoryWatermark();
  },
  async finalize(database?: string | null): Promise<MemoryWatermark> {
    return (await getBackend(database)).memoryFinalize();
  },
};

export async function shutdownCoreForTests(): Promise<void> {
  const backends = [
    ...backendCache.values(),
    ...await Promise.all([...backendPromises.values()].map((promise) => promise.catch(() => null))),
  ].filter((backend): backend is MuninnBackend => Boolean(backend));
  for (const backend of backends) {
    await backend.shutdown();
  }
  backendCache.clear();
  backendPromises.clear();
  bootstrapPromises.clear();
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
