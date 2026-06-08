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
  isObserverEnabled,
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
  type SessionIndexEntry,
} from './checkpoint.js';
import { Memories } from './memories/memories.js';
import { Extractor } from './extractor/extractor.js';
import { Observer } from './observer/observer.js';
import { SessionRegistry } from './turn/registry.js';
import { readTurn } from './turn/types.js';
import { Watchdog } from './watchdog.js';
import { TableMutationLocks, lockNativeTables } from './table-locks.js';
import { writeMuninnLog } from './logging.js';
import { SessionIndex } from './session-index.js';
import type { Artifact, TurnContent, TurnEvent } from '@muninn/types';

export interface Turn {
  turnId: string;
  createdAt: string;
  updatedAt: string;
  sessionId?: string | null;
  project: string;
  cwd: string;
  agent: string;
  observer: string;
  title?: string | null;
  summary?: string | null;
  events: TurnEvent[];
  artifacts?: Artifact[] | null;
  metadata?: Record<string, unknown> | null;
  prompt?: string | null;
  response?: string | null;
  observingEpoch?: number | null;
  previousTurnSummary?: string | null;
  recentContext?: RecentTurn[];
}

export interface SessionSnapshot {
  snapshotId: string;
  sessionId: string;
  project: string;
  cwd: string;
  agent: string;
  snapshotSequence: number;
  createdAt: string;
  updatedAt: string;
  extractor: string;
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
  title?: string;
  summary?: string;
  content: string;
  references: string[];
  project?: string;
  sessionId?: string;
  agent?: string;
  cwd?: string;
  sessionKey?: string;
  displaySession?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type RecallMode = 'vector' | 'fts' | 'hybrid';

export type MemoryWatermarkPhase = 'idle' | 'pending' | 'running' | 'draining' | 'error';

export interface MemoryWatermark {
  pending: {
    turns: string[];
    extractions: string[];
  };
  phases: {
    extractor: MemoryWatermarkPhase;
    observer: MemoryWatermarkPhase;
  };
  error?: {
    phase: 'extractor' | 'observer';
    message: string;
  };
}

export type ListModeInput =
  | { type: 'recency'; limit: number }
  | { type: 'page'; offset: number; limit: number };

export type { TurnContent } from '@muninn/types';

export interface CheckpointLock {
  shared<T>(operation: () => Promise<T> | T): Promise<T>;
  exclusive<T>(operation: () => Promise<T> | T): Promise<T>;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    (timer as { unref?: () => void }).unref?.();
  });
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

function combineWatermarks(
  extractorWatermark: MemoryWatermark,
  observerWatermark: MemoryWatermark,
): MemoryWatermark {
  return {
    pending: {
      turns: extractorWatermark.pending.turns,
      extractions: observerWatermark.pending.extractions,
    },
    phases: {
      extractor: extractorWatermark.phases.extractor,
      observer: observerWatermark.phases.observer,
    },
    error: extractorWatermark.error ?? observerWatermark.error,
  };
}

function idleObserverWatermark(): MemoryWatermark {
  return {
    pending: {
      turns: [],
      extractions: [],
    },
    phases: {
      extractor: 'idle',
      observer: 'idle',
    },
  };
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
  private readonly sessionIndex: SessionIndex;
  private watchdog: Watchdog | null = null;
  private watchdogClient: NativeTables | null = null;
  private finalizeDrainPromise: Promise<void> | null = null;
  private readonly observerEnabled: boolean;

  private constructor(
    private readonly client: NativeTables,
    private readonly database: string,
    private readonly checkpoint: CheckpointFile | null = null,
  ) {
    this.memories = new Memories(client);
    this.checkpointLock = new AsyncCheckpointLock();
    this.observerEnabled = isObserverEnabled();
    const extractorName = loadMuninnConfig()?.extractor?.name;
    this.sessionIndex = new SessionIndex(checkpoint?.sessionIndex ?? null, extractorName ?? null);
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
          sessionIndex: checkpoint.sessionIndex,
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
      if (this.observerEnabled) {
        await this.ensureObserver();
      }
      const extractor = await this.ensureExtractor();
      const registry = this.ensureSessionRegistry(extractor.name);
      await extractor.accept(turnContent, registry);
    });
  }

  async deleteTurns(turnIds: string[]): Promise<{ deleted: number }> {
    return this.checkpointLock.exclusive(async () => {
      const result = await this.client.turnTable.deleteTurns({ turnIds });
      if (result.deleted > 0) {
        this.sessionIndex.markDirty();
      }
      return result;
    });
  }

  async listSessionIndex(): Promise<SessionIndexEntry[]> {
    return this.checkpointLock.shared(async () => this.sessionIndex.list(this.client));
  }

  async memoryWatermark(): Promise<MemoryWatermark> {
    return this.checkpointLock.shared(async () => {
      const observer = this.observerEnabled ? await this.ensureObserver() : null;
      const extractor = await this.ensureExtractor();
      const extractorWatermark = await extractor.watermark();
      const observerWatermark = observer ? await observer.watermark() : idleObserverWatermark();
      return combineWatermarks(extractorWatermark, observerWatermark);
    });
  }

  async memoryFinalize(): Promise<MemoryWatermark> {
    const { observer, extractor } = await this.checkpointLock.shared(async () => {
      const observer = this.observerEnabled ? await this.ensureObserver() : null;
      const extractor = await this.ensureExtractor();
      return { observer, extractor };
    });
    const extractorWatermark = await extractor.finalize();
    const observerWatermark = observer ? await observer.finalize() : idleObserverWatermark();
    this.scheduleFinalizeDrain(extractor, observer);
    const watermark = combineWatermarks(extractorWatermark, observerWatermark);
    return watermark;
  }

  async recallMemories(
    query: string,
    limit?: number,
    options?: { mode?: RecallMode; budget?: number; queryLimit?: number; includeGlobalObservations?: boolean },
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
      if (!extractor || !extractorCheckpoint) {
        return null;
      }
      if (this.observerEnabled && (!observer || !observerCheckpoint)) {
        return null;
      }
      const [turnStats, sessionStats, extractionStats, observationContextStats, observationStats] = await Promise.all([
        this.client.turnTable.stats(),
        this.client.sessionTable.stats(),
        this.client.extractionTable.stats(),
        this.client.globalObservationContextTable.stats(),
        this.client.globalObservationTable.stats(),
      ]);
      const extractorSection: ExtractorCheckpoint = {
        baseline: {
          turn: turnStats?.version ?? 0,
          session: sessionStats?.version ?? 0,
          extraction: extractionStats?.version ?? 0,
          global_observation: observationStats?.version ?? 0,
        },
        committedEpoch: extractorCheckpoint.committedEpoch,
        nextEpoch: extractorCheckpoint.nextEpoch,
        recentSessions: this.sessionRegistry?.exportRecentSessions() ?? [],
        threads: extractorCheckpoint.threads,
        runs: extractorCheckpoint.runs,
        pendingExtractionChanges: extractorCheckpoint.pendingExtractionChanges,
      };
      const observerSection: ObserverCheckpoint = observerCheckpoint ? {
        baseline: observerCheckpoint.baseline,
        observeQueue: observerCheckpoint.observeQueue,
        runs: observerCheckpoint.runs,
      } : {
        baseline: {
          globalObservationContext: observationContextStats?.version ?? 0,
          global_observation: observationStats?.version ?? 0,
        },
        observeQueue: { cwdBuckets: [] },
        runs: [],
      };
      return {
        schemaVersion: 7,
        extractor: extractorSection,
        observer: observerSection,
        sessionIndex: await this.sessionIndex.exportCheckpoint(this.client),
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
    this.finalizeDrainPromise = null;
    this.sessionRegistry = null;
  }

  private scheduleFinalizeDrain(extractor: Extractor, observer: Observer | null): void {
    if (this.finalizeDrainPromise) {
      return;
    }
    this.finalizeDrainPromise = this.runFinalizeDrain(extractor, observer)
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        await writeMuninnLog(this.database, 'error', 'sidecar', 'memory_finalize_drain_failed', { message });
      })
      .finally(() => {
        this.finalizeDrainPromise = null;
      });
  }

  private async runFinalizeDrain(extractor: Extractor, observer: Observer | null): Promise<void> {
    while (this.extractor === extractor && (!observer || this.observer === observer)) {
      const watermark = await extractor.watermark();
      if (watermark.pending.turns.length === 0 && watermark.phases.extractor === 'idle') {
        await observer?.finalize();
        await this.watchdog?.flushCheckpoint();
        return;
      }
      await sleep(20);
    }
  }

  private async ensureExtractor(): Promise<Extractor> {
    if (!this.extractor) {
      const checkpoint = this.checkpoint?.extractor ?? null;
      this.extractor = new Extractor(
        this.client,
        checkpoint,
        this.checkpointLock,
        (changes) => {
          if (this.observerEnabled && changes.length > 0) {
            this.observer?.enqueue(changes);
          }
          if (this.observerEnabled) {
            this.observer?.notify();
          }
        },
        this.database,
      );
    }
    await this.extractor.ensureBootstrapped();
    return this.extractor;
  }

  private async ensureObserver(): Promise<Observer> {
    if (!this.observerEnabled) {
      throw new Error('observer is disabled.');
    }
    if (!this.observer) {
      const checkpoint = this.checkpoint?.observer ?? null;
      this.observer = new Observer(this.client, checkpoint, this.checkpointLock, this.database);
    }
    this.observer.start();
    return this.observer;
  }

  private ensureSessionRegistry(extractorName: string): SessionRegistry {
    if (!this.sessionRegistry || this.sessionRegistry.extractorName !== extractorName) {
      this.sessionRegistry = new SessionRegistry(this.client, extractorName);
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
        { project: session.project, cwd: session.cwd },
        session.turns,
      );
    }
    const delta = await this.client.turnTable.delta({
      observer: this.sessionRegistry.extractorName,
      baselineVersion: this.checkpoint.extractor.baseline.turn,
    });
    for (const row of delta) {
      const turn = readTurn(row);
      if (!turn.observer || turn.observer !== this.sessionRegistry.extractorName) {
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

  async delete(params: {
    turnIds: string[];
    database?: string | null;
  }): Promise<{ deleted: number }> {
    const databaseName = resolveDatabaseName(params.database);
    await writeMuninnLog(databaseName, 'info', 'delete', 'turn_delete', {
      count: params.turnIds.length,
    });
    return (await getBackend(databaseName)).deleteTurns(params.turnIds);
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

  async index(database?: string | null): Promise<SessionIndexEntry[]> {
    const databaseName = resolveDatabaseName(database);
    await writeMuninnLog(databaseName, 'info', 'list', 'session_index', {});
    return (await getBackend(databaseName)).listSessionIndex();
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
    options?: { mode?: RecallMode; budget?: number; queryLimit?: number; includeGlobalObservations?: boolean; database?: string | null },
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
