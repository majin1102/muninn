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
  type CheckpointFile,
  type ObserverCheckpoint,
  type OpenTurnRef,
} from './checkpoint.js';
import { Memories } from './memories/memories.js';
import { Observer } from './observer/observer.js';
import { hasText, sessionKey } from './session/key.js';
import { SessionRegistry } from './session/registry.js';
import { readSessionTurn, serializeSessionTurn, toSessionTurn } from './session/types.js';
import { Watchdog } from './watchdog.js';
import type { OpenTurnSourceRef } from './native.js';
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

type CheckpointExport = {
  checkpoint: CheckpointFile;
  content: string;
};

let singletonBackend: MuninnBackend | null = null;
let singletonBackendPromise: Promise<MuninnBackend> | null = null;
let bootstrapPromise: Promise<void> | null = null;
const REPAIR_PAGE_SIZE = 1_000;

export class MuninnBackend {
  readonly memories: Memories;
  private observer: Observer | null = null;
  private sessionRegistry: SessionRegistry | null = null;
  private watchdog: Watchdog | null = null;

  constructor(
    private readonly client: NativeTables,
    private readonly checkpoint: CheckpointFile | null = null,
  ) {
    this.memories = new Memories(client);
  }

  static async create(client: NativeTables): Promise<MuninnBackend> {
    const checkpoint = await readCheckpointFile();
    const backend = new MuninnBackend(client, checkpoint);
    const watchdogConfig = getWatchdogConfig();
    if (watchdogConfig.enabled) {
      const lastCheckpointContent = checkpoint
        ? backend.serializeCheckpointContent(checkpoint)
        : null;
      backend.watchdog = new Watchdog(
        client,
        watchdogConfig,
        backend,
        lastCheckpointContent,
      );
      backend.watchdog.start();
    }
    return backend;
  }

  async accept(turnContent: TurnContent): Promise<SessionTurn> {
    const observer = await this.ensureObserver();
    const registry = this.ensureSessionRegistry(observer.name);
    return toSessionTurn(await observer.accept(turnContent, registry));
  }

  async observerWatermark(): Promise<ObserverWatermark> {
    return (await this.ensureObserver()).watermark();
  }

  async recallMemories(query: string, limit?: number): Promise<RecallHit[]> {
    return this.memories.recall(query, limit);
  }

  async exportCheckpoint(): Promise<CheckpointExport | null> {
    const fragment = this.observer?.exportCheckpointFragment();
    if (!fragment) {
      if (!this.checkpoint) {
        return null;
      }
      return {
        checkpoint: this.checkpoint,
        content: this.serializeCheckpointContent(this.checkpoint),
      };
    }
    const openTurns = await this.exportOpenTurns();
    const observerCheckpoint: ObserverCheckpoint = {
      baseline: {
        turn: openTurns.version,
        observing: fragment.baseline.observing,
        semanticIndex: fragment.baseline.semanticIndex,
      },
      committedEpoch: fragment.committedEpoch,
      nextEpoch: fragment.nextEpoch,
      openTurns: openTurns.grouped.get(fragment.observerName) ?? [],
      threads: fragment.threads,
    };
    const checkpoint: CheckpointFile = {
      schemaVersion: 1,
      writtenAt: new Date().toISOString(),
      writerPid: process.pid,
      observers: {
        [fragment.observerName]: observerCheckpoint,
      },
    };
    return {
      checkpoint,
      content: this.serializeCheckpointContent(checkpoint),
    };
  }

  async shutdown(): Promise<void> {
    if (this.watchdog) {
      await this.watchdog.stop({ flushCheckpoint: true });
    }
    this.watchdog = null;
    if (this.observer) {
      await this.observer.shutdown();
    }
    this.observer = null;
    this.sessionRegistry = null;
  }

  private async ensureObserver(): Promise<Observer> {
    if (!this.observer) {
      const observerName = getObserverLlmConfig()?.name;
      const checkpoint = observerName
        ? this.checkpoint?.observers[observerName] ?? null
        : null;
      this.observer = new Observer(this.client, checkpoint);
    }
    await this.observer.ensureBootstrapped();
    return this.observer;
  }

  private ensureSessionRegistry(observerName: string): SessionRegistry {
    if (!this.sessionRegistry || this.sessionRegistry.observerName !== observerName) {
      this.sessionRegistry = new SessionRegistry(
        this.client,
        observerName,
        (sessionId, agent) => this.observer?.checkpointOpenTurnId(sessionId, agent),
      );
    }
    return this.sessionRegistry;
  }

  private serializeCheckpointContent(checkpoint: CheckpointFile): string {
    return JSON.stringify({
      schemaVersion: checkpoint.schemaVersion,
      observers: checkpoint.observers,
    });
  }

  private async exportOpenTurns(): Promise<{
    version: number;
    grouped: Map<string, OpenTurnRef[]>;
  }> {
    if (typeof this.client.sessionTable.exportOpenTurnRefs !== 'function') {
      return {
        version: 0,
        grouped: new Map(),
      };
    }
    const exported = await this.client.sessionTable.exportOpenTurnRefs();
    return {
      version: exported.version,
      grouped: groupOpenTurnsByObserver(exported.turns),
    };
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

function groupOpenTurnsByObserver(turns: OpenTurnSourceRef[]): Map<string, OpenTurnRef[]> {
  const grouped = new Map<string, OpenTurnRef[]>();
  for (const turn of turns) {
    const group = grouped.get(turn.observer);
    const entry: OpenTurnRef = {
      sessionId: turn.sessionId ?? null,
      agent: turn.agent,
      turnId: turn.turnId,
      updatedAt: turn.updatedAt,
    };
    if (group) {
      group.push(entry);
    } else {
      grouped.set(turn.observer, [entry]);
    }
  }
  return grouped;
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
