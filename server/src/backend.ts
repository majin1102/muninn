import {
  __testing as nativeTesting,
  createNativeTables,
  describeExtractionForStorage,
  getNativeTables,
  lockNativeTables,
  shutdownNativeTablesForTests,
  TableMutationLocks,
  type ListModeInput,
  type DreamingRow,
  type NativeTables,
  type SessionSnapshotRow,
  type TurnRow,
} from './native.js';
import {
  loadMuninnConfig,
  resolveDatabaseName,
  resolveStorageTarget,
  getEmbeddingConfig,
  getDreamingConfig,
  getExtractorLlmConfig,
  getWatchdogConfig,
  validateMuninnConfigInput,
  validateMuninnConfigStorage,
} from './config.js';
import {
  readCheckpointFile,
  writeCheckpointFile,
  type CheckpointContent,
  type CheckpointFile,
  type ExtractorCheckpoint,
  type SessionIndexEntry,
} from './checkpoint.js';
import { Memories, type RecallHit, type RenderedMemory } from './api/memory.js';
import { Extractor } from './pipeline/extractor.js';
import { IngestSessionRegistry } from './pipeline/ingest.js';
import { readTurnRow } from './pipeline/ingest.js';
import { Watchdog } from './watchdog.js';
import { writeMuninnLog } from './logging.js';
import { SessionIndex } from './session-index.js';
import { ProjectDreamingService, type ProjectDreamCreateResult } from './dreaming/service.js';
import { ProjectDreamingScheduler } from './dreaming/scheduler.js';
import type { ProjectDreamSignals } from './dreaming/content.js';
import type { ProjectDreamProjectView, TurnContent } from '@muninn/common';

export type Turn = TurnRow;
export type SessionSnapshot = SessionSnapshotRow;

export type RecallMode = 'vector' | 'fts' | 'hybrid';

export type MemoryWatermarkPhase = 'idle' | 'pending' | 'running' | 'draining' | 'error';

export interface MemoryWatermark {
  pending: {
    turns: string[];
  };
  phases: {
    extractor: MemoryWatermarkPhase;
  };
  error?: {
    phase: 'extractor';
    message: string;
  };
}

export type { TurnContent } from '@muninn/common';

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

const backendCache = new Map<string, MuninnBackend>();
const backendPromises = new Map<string, Promise<MuninnBackend>>();
const bootstrapPromises = new Map<string, Promise<void>>();

export class MuninnBackend {
  readonly memories: Memories;
  readonly checkpointLock: CheckpointLock;
  private extractor: Extractor | null = null;
  private sessionRegistry: IngestSessionRegistry | null = null;
  private readonly sessionIndex: SessionIndex;
  private readonly projectDreaming: ProjectDreamingService;
  private dreamingScheduler: ProjectDreamingScheduler | null = null;
  private watchdog: Watchdog | null = null;
  private watchdogClient: NativeTables | null = null;
  private finalizeDrainPromise: Promise<void> | null = null;

  private constructor(
    private readonly client: NativeTables,
    private readonly database: string,
    private readonly checkpoint: CheckpointFile | null = null,
  ) {
    this.memories = new Memories(client);
    this.checkpointLock = new AsyncCheckpointLock();
    const extractorName = loadMuninnConfig()?.extractor?.name;
    this.sessionIndex = new SessionIndex(checkpoint?.sessionIndex ?? null, extractorName ?? null);
    this.projectDreaming = new ProjectDreamingService(client, extractorName ?? null);
    this.sessionRegistry = extractorName
      ? new IngestSessionRegistry(client, extractorName)
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
    const dreamingConfig = getDreamingConfig();
    if (dreamingConfig.enabled) {
      backend.dreamingScheduler = new ProjectDreamingScheduler({
        intervalMs: dreamingConfig.intervalMs,
        listProjects: () => backend.projectDreaming.projectsWithSignals(),
        createProject: (project) => backend.projectDreaming.create(project),
        log: (level, event, details) => writeMuninnLog(databaseName, level, 'dreaming', event, details),
      });
      backend.dreamingScheduler.start();
    }
    return backend;
  }

  static createForTests(client: NativeTables, checkpoint: CheckpointFile | null = null): MuninnBackend {
    return new MuninnBackend(lockNativeTables(client, new TableMutationLocks()), 'main', checkpoint);
  }

  async accept(turnContent: TurnContent): Promise<void> {
    return this.checkpointLock.shared(async () => {
      const extractor = await this.ensureExtractor();
      const registry = this.ensureSessionRegistry(extractor.name);
      await extractor.accept(turnContent, registry);
    });
  }

  async acceptBatch(turnContents: TurnContent[]): Promise<number> {
    if (turnContents.length === 0) {
      return 0;
    }
    return this.checkpointLock.shared(async () => {
      const extractor = await this.ensureExtractor();
      const registry = this.ensureSessionRegistry(extractor.name);
      return extractor.acceptBatch(turnContents, registry);
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

  async refreshSessionIndex(): Promise<SessionIndexEntry[]> {
    return this.checkpointLock.exclusive(async () => {
      this.sessionIndex.markDirty();
      const entries = await this.sessionIndex.list(this.client);
      const checkpoint = await readCheckpointFile(this.database);
      if (!checkpoint) {
        return entries;
      }
      await writeCheckpointFile({
        ...checkpoint,
        writtenAt: new Date().toISOString(),
        writerPid: process.pid,
        sessionIndex: this.sessionIndex.currentCheckpoint(),
      }, this.database);
      return entries;
    });
  }

  async latestProjectDream(project: string) {
    return this.checkpointLock.shared(async () => this.projectDreaming.latest(project));
  }

  async listProjectDreams(): Promise<ProjectDreamProjectView[]> {
    return this.checkpointLock.shared(async () => this.projectDreaming.projects());
  }

  async latestProjectSignals(project: string, limit = 5): Promise<ProjectDreamSignals | null> {
    return this.checkpointLock.shared(async () => this.projectDreaming.signals(project, limit));
  }

  async createProjectDream(project: string): Promise<ProjectDreamCreateResult> {
    return this.projectDreaming.create(project);
  }

  async memoryWatermark(): Promise<MemoryWatermark> {
    return this.checkpointLock.shared(async () => {
      const extractor = await this.ensureExtractor();
      return extractor.watermark();
    });
  }

  async memoryFinalize(): Promise<MemoryWatermark> {
    const extractor = await this.checkpointLock.shared(async () => {
      const extractor = await this.ensureExtractor();
      return extractor;
    });
    const watermark = await extractor.finalize();
    this.scheduleFinalizeDrain(extractor);
    return watermark;
  }

  async memoryFlushPending(): Promise<MemoryWatermark> {
    const extractor = await this.checkpointLock.shared(async () => {
      const extractor = await this.ensureExtractor();
      return extractor;
    });
    await extractor.flushPending();
    await this.watchdog?.flushCheckpoint();
    return extractor.watermark();
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
      const extractorCheckpoint = extractor?.exportCheckpoint();
      if (!extractor || !extractorCheckpoint) {
        return null;
      }
      const [turnStats, sessionStats, extractionStats] = await Promise.all([
        this.client.turnTable.stats(),
        this.client.sessionTable.stats(),
        this.client.extractionTable.stats(),
      ]);
      const extractorSection: ExtractorCheckpoint = {
        baseline: {
          turn: turnStats?.version ?? 0,
          session: sessionStats?.version ?? 0,
          extraction: extractionStats?.version ?? 0,
        },
        committedEpoch: extractorCheckpoint.committedEpoch,
        nextEpoch: extractorCheckpoint.nextEpoch,
        recentSessions: this.sessionRegistry?.exportRecentSessions() ?? [],
        threads: extractorCheckpoint.threads,
        runs: extractorCheckpoint.runs,
      };
      return {
        schemaVersion: 12,
        extractor: extractorSection,
        sessionIndex: await this.sessionIndex.exportCheckpoint(this.client),
      };
    });
  }

  async shutdown(): Promise<void> {
    if (this.extractor) {
      await this.extractor.shutdown();
    }
    if (this.watchdog) {
      await this.watchdog.stop({ flushCheckpoint: true });
    }
    if (this.dreamingScheduler) {
      await this.dreamingScheduler.stop();
    }
    if (this.watchdogClient) {
      await this.watchdogClient.close();
    }
    this.watchdog = null;
    this.dreamingScheduler = null;
    this.watchdogClient = null;
    this.extractor = null;
    this.finalizeDrainPromise = null;
    this.sessionRegistry = null;
  }

  private scheduleFinalizeDrain(extractor: Extractor): void {
    if (this.finalizeDrainPromise) {
      return;
    }
    this.finalizeDrainPromise = this.runFinalizeDrain(extractor)
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        await writeMuninnLog(this.database, 'error', 'server', 'memory_finalize_drain_failed', { message });
      })
      .finally(() => {
        this.finalizeDrainPromise = null;
      });
  }

  private async runFinalizeDrain(extractor: Extractor): Promise<void> {
    while (this.extractor === extractor) {
      const watermark = await extractor.watermark();
      if (watermark.pending.turns.length === 0 && watermark.phases.extractor === 'idle') {
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
        this.database,
      );
    }
    await this.extractor.ensureBootstrapped();
    return this.extractor;
  }

  private ensureSessionRegistry(extractorName: string): IngestSessionRegistry {
    if (!this.sessionRegistry || this.sessionRegistry.extractorName !== extractorName) {
      this.sessionRegistry = new IngestSessionRegistry(this.client, extractorName);
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
      extractor: this.sessionRegistry.extractorName,
      baselineVersion: this.checkpoint.extractor.baseline.turn,
    });
    for (const row of delta) {
      const turn = readTurnRow(row);
      if (!turn.extractor || turn.extractor !== this.sessionRegistry.extractorName) {
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

export async function captureTurn(turnContent: TurnContent, database?: string | null): Promise<void> {
  const databaseName = resolveDatabaseName(database);
  await writeMuninnLog(databaseName, 'info', 'server', 'turn_capture', {
    sessionId: turnContent.sessionId,
    agent: turnContent.agent,
  });
  const backend = await getBackend(databaseName);
  await backend.accept(turnContent);
  if (isHookCapture(turnContent)) {
    await backend.memoryFinalize();
  }
}

export async function captureTurns(turnContents: TurnContent[], database?: string | null): Promise<number> {
  const databaseName = resolveDatabaseName(database);
  await writeMuninnLog(databaseName, 'info', 'server', 'turn_capture_batch', {
    count: turnContents.length,
  });
  return (await getBackend(databaseName)).acceptBatch(turnContents);
}

function isHookCapture(turnContent: TurnContent): boolean {
  return typeof turnContent.metadata?.ingest === 'string'
    && turnContent.metadata.ingest.endsWith('-hook');
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
    project?: string;
    agent?: string;
    sessionId?: string;
    database?: string | null;
  }): Promise<Turn[]> {
    const databaseName = resolveDatabaseName(params.database);
    await writeMuninnLog(databaseName, 'info', 'list', 'turn_list', {
      mode: params.mode.type,
      limit: 'limit' in params.mode ? params.mode.limit : undefined,
      project: params.project,
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
    extractor?: string;
    database?: string | null;
  }): Promise<SessionSnapshot[]> {
    const databaseName = resolveDatabaseName(params.database);
    await writeMuninnLog(databaseName, 'info', 'list', 'session_list', {
      mode: params.mode.type,
      limit: 'limit' in params.mode ? params.mode.limit : undefined,
      extractor: params.extractor,
    });
    return (await getBackend(databaseName)).memories.listSessions(params);
  },

  async index(database?: string | null): Promise<SessionIndexEntry[]> {
    const databaseName = resolveDatabaseName(database);
    await writeMuninnLog(databaseName, 'info', 'list', 'session_index', {});
    return (await getBackend(databaseName)).listSessionIndex();
  },

  async refreshIndex(database?: string | null): Promise<SessionIndexEntry[]> {
    const databaseName = resolveDatabaseName(database);
    await writeMuninnLog(databaseName, 'info', 'refresh', 'session_index_refresh', {});
    return (await getBackend(databaseName)).refreshSessionIndex();
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

export const memoryPipeline = {
  async watermark(database?: string | null): Promise<MemoryWatermark> {
    return (await getBackend(database)).memoryWatermark();
  },
  async flushPending(database?: string | null): Promise<MemoryWatermark> {
    return (await getBackend(database)).memoryFlushPending();
  },
  async finalize(database?: string | null): Promise<MemoryWatermark> {
    return (await getBackend(database)).memoryFinalize();
  },
};

export const dreaming = {
  async listProjects(database?: string | null): Promise<ProjectDreamProjectView[]> {
    const databaseName = resolveDatabaseName(database);
    await writeMuninnLog(databaseName, 'info', 'detail', 'project_dream_projects', {});
    return (await getBackend(databaseName)).listProjectDreams();
  },

  async getProject(project: string, database?: string | null): Promise<DreamingRow | null> {
    const databaseName = resolveDatabaseName(database);
    await writeMuninnLog(databaseName, 'info', 'detail', 'project_dream_get', { project });
    return (await getBackend(databaseName)).latestProjectDream(project);
  },

  async getProjectSignals(project: string, database?: string | null, limit = 5): Promise<ProjectDreamSignals | null> {
    const databaseName = resolveDatabaseName(database);
    await writeMuninnLog(databaseName, 'info', 'detail', 'project_dream_signals', { project });
    return (await getBackend(databaseName)).latestProjectSignals(project, limit);
  },

  async createProject(project: string, database?: string | null): Promise<ProjectDreamCreateResult> {
    const databaseName = resolveDatabaseName(database);
    await writeMuninnLog(databaseName, 'info', 'dreaming', 'project_dream_create', { project });
    return (await getBackend(databaseName)).createProjectDream(project);
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
  captureTurn,
  validateSettings,
  turns,
  sessions,
  memories,
  memoryPipeline,
  dreaming,
  shutdownCoreForTests,
};

export default core;
