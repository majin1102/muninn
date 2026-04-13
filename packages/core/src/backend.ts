import {
  __testing as nativeTesting,
  describeSemanticIndexForStorage,
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
} from './checkpoint.js';
import { Memories } from './memories/memories.js';
import { Observer } from './observer/observer.js';
import { hasText, sessionKey } from './session/key.js';
import { SessionRegistry } from './session/registry.js';
import { readSessionTurn, serializeSessionTurn, toSessionTurn } from './session/types.js';
import { Watchdog } from './watchdog.js';
import type { TurnContent } from '@muninn/types';

export interface SessionTurn {
  turnId: string;
  createdAt: string;
  updatedAt: string;
  sessionId?: string | null;
  agent: string;
  observer: string;
  title?: string | null;
  summary?: string | null;
  toolCalling?: string[] | null;
  artifacts?: Record<string, string> | null;
  prompt?: string | null;
  response?: string | null;
  observingEpoch?: number | null;
}

export interface ObservingSnapshot {
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
    indexedSnapshotSequence?: number | null;
  };
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
}

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
const REPAIR_PAGE_SIZE = 1_000;

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
          observers: checkpoint.observers,
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

  async accept(turnContent: TurnContent): Promise<SessionTurn> {
    return this.checkpointLock.shared(async () => {
      const observer = await this.ensureObserver();
      const registry = this.ensureSessionRegistry(observer.name);
      return toSessionTurn(await observer.accept(turnContent, registry));
    });
  }

  async observerWatermark(): Promise<ObserverWatermark> {
    return this.checkpointLock.shared(async () => (await this.ensureObserver()).watermark());
  }

  async recallMemories(query: string, limit?: number): Promise<RecallHit[]> {
    return this.memories.recall(query, limit);
  }

  async exportCheckpoint(): Promise<CheckpointContent | null> {
    return this.checkpointLock.exclusive(async () => {
      const observer = this.observer;
      const observerCheckpoint = observer?.exportCheckpoint();
      if (!observer || !observerCheckpoint) {
        return null;
      }
      const [turnStats, observingStats, semanticIndexStats] = await Promise.all([
        this.client.sessionTable.stats(),
        this.client.observingTable.stats(),
        this.client.semanticIndexTable.stats(),
      ]);
      const checkpoint: ObserverCheckpoint = {
        baseline: {
          turn: turnStats?.version ?? 0,
          observing: observingStats?.version ?? 0,
          semanticIndex: semanticIndexStats?.version ?? 0,
        },
        committedEpoch: observerCheckpoint.committedEpoch,
        nextEpoch: observerCheckpoint.nextEpoch,
        openTurns: this.sessionRegistry?.exportOpenTurns() ?? [],
        threads: observerCheckpoint.threads,
      };
      return {
        schemaVersion: 1,
        observers: {
          [observer.name]: checkpoint,
        },
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
      const observerName = getObserverLlmConfig()?.name;
      const checkpoint = observerName
        ? this.checkpoint?.observers[observerName] ?? null
        : null;
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
    const section = this.checkpoint.observers[this.sessionRegistry.observerName];
    if (!section) {
      return;
    }
    for (const turnRef of section.openTurns) {
      const row = await this.client.sessionTable.getTurn(turnRef.turnId);
      const turn = row ? readSessionTurn(row) : null;
      if (!turn || !matchesOpenTurn(turn, turnRef.sessionId ?? undefined, turnRef.agent, this.sessionRegistry.observerName)) {
        throw new Error(`invalid checkpoint open turn: ${turnRef.turnId}`);
      }
      this.sessionRegistry.restoreSession(turnRef.sessionId ?? undefined, turnRef.agent, turn);
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
    await tables.semanticIndexTable.validateDimensions({ expected: embedding.dimensions });
  }
  await repairOpenTurns(tables);
}

async function repairOpenTurns(tables: NativeTables): Promise<number> {
  const openTurns = await listOpenTurns(tables);
  const turnsByKey = new Map<string, SessionTurn[]>();
  for (const turn of openTurns) {
    const key = sessionKey(turn.sessionId ?? undefined, turn.agent, turn.observer);
    const group = turnsByKey.get(key);
    if (group) {
      group.push(turn);
    } else {
      turnsByKey.set(key, [turn]);
    }
  }

  let repaired = 0;
  for (const turns of turnsByKey.values()) {
    if (turns.length < 2) {
      continue;
    }
    const { canonicalTurn, discardedTurnIds } = mergeOpenTurns(turns);
    await tables.sessionTable.update({
      turns: [serializeSessionTurn(canonicalTurn)],
    });
    if (discardedTurnIds.length > 0) {
      await tables.sessionTable.deleteTurns({ turnIds: discardedTurnIds });
    }
    repaired += 1;
  }
  return repaired;
}

async function listOpenTurns(tables: NativeTables): Promise<SessionTurn[]> {
  const turns: SessionTurn[] = [];
  for (let offset = 0; ; offset += REPAIR_PAGE_SIZE) {
    const page = await tables.sessionTable.listTurns({
      mode: { type: 'page', offset, limit: REPAIR_PAGE_SIZE },
    });
    const normalized = page.map(readSessionTurn).filter((turn) => !hasText(turn.response));
    turns.push(...normalized);
    if (page.length < REPAIR_PAGE_SIZE) {
      return turns;
    }
  }
}

function mergeOpenTurns(turns: SessionTurn[]): {
  canonicalTurn: SessionTurn;
  discardedTurnIds: string[];
} {
  const sorted = [...turns].sort((left, right) => {
    const leftId = turnRowId(left.turnId);
    const rightId = turnRowId(right.turnId);
    if (leftId < rightId) {
      return -1;
    }
    if (leftId > rightId) {
      return 1;
    }
    return 0;
  });
  const canonicalSource = sorted[sorted.length - 1];
  const discardedTurnIds = sorted.slice(0, -1).map((turn) => turn.turnId);

  let prompt: string | undefined;
  let toolCalling: string[] | undefined;
  let artifacts: Record<string, string> | undefined;
  let latestUpdatedAt = canonicalSource.updatedAt;

  for (const turn of sorted) {
    prompt = mergePrompt(prompt, turn.prompt ?? undefined);
    toolCalling = mergeToolCalling(toolCalling, turn.toolCalling ?? undefined);
    artifacts = mergeArtifacts(artifacts, turn.artifacts ?? undefined);
    if (Date.parse(turn.updatedAt) > Date.parse(latestUpdatedAt)) {
      latestUpdatedAt = turn.updatedAt;
    }
  }

  return {
    canonicalTurn: {
      ...canonicalSource,
      prompt: prompt ?? null,
      toolCalling: toolCalling ?? null,
      artifacts: artifacts ?? null,
      response: null,
      observingEpoch: null,
      updatedAt: latestUpdatedAt,
    },
    discardedTurnIds,
  };
}

function mergePrompt(current?: string, incoming?: string): string | undefined {
  const currentText = hasText(current) ? current.trim() : undefined;
  const incomingText = hasText(incoming) ? incoming.trim() : undefined;
  if (currentText && incomingText) {
    return currentText === incomingText ? currentText : `${currentText}\n\n${incomingText}`;
  }
  return currentText ?? incomingText;
}

function mergeToolCalling(current?: string[], incoming?: string[]): string[] | undefined {
  if (!incoming || incoming.length === 0) {
    return current;
  }
  return [...(current ?? []), ...incoming];
}

function mergeArtifacts(
  current?: Record<string, string>,
  incoming?: Record<string, string> | null,
): Record<string, string> | undefined {
  if (!incoming || Object.keys(incoming).length === 0) {
    return current;
  }
  return {
    ...(current ?? {}),
    ...incoming,
  };
}

function turnRowId(turnId: string): bigint {
  const [, rawRowId = '0'] = turnId.split(':', 2);
  return BigInt(rawRowId);
}

function matchesOpenTurn(
  turn: SessionTurn | null,
  sessionId: string | undefined,
  agent: string,
  observer: string,
): boolean {
  if (!turn) {
    return false;
  }
  return sessionKey(turn.sessionId ?? undefined, turn.agent, turn.observer) === sessionKey(sessionId, agent, observer)
    && !hasText(turn.response);
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

export async function addMessage(turnContent: TurnContent): Promise<SessionTurn> {
  return (await getBackend()).accept(turnContent);
}

export async function validateSettings(content: string): Promise<void> {
  const config = validateMuninnConfigInput(content);
  const storage = resolveStorageTarget(config);
  const description = await describeSemanticIndexForStorage(storage);
  await validateMuninnConfigStorage(config, description);
}

export const sessions = {
  async get(memoryId: string): Promise<SessionTurn | null> {
    return (await getBackend()).memories.getSession(memoryId);
  },

  async list(params: {
    mode: ListModeInput;
    agent?: string;
    sessionId?: string;
  }): Promise<SessionTurn[]> {
    return (await getBackend()).memories.listSessions(params);
  },
};

export const observings = {
  async get(memoryId: string): Promise<ObservingSnapshot | null> {
    return (await getBackend()).memories.getObserving(memoryId);
  },

  async list(params: {
    mode: ListModeInput;
    observer?: string;
  }): Promise<ObservingSnapshot[]> {
    return (await getBackend()).memories.listObservings(params);
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

  async recall(query: string, limit?: number): Promise<RecallHit[]> {
    return (await getBackend()).recallMemories(query, limit);
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
  repairOpenTurns,
  shutdownCoreForTests,
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
