import {
  __testing as nativeTesting,
  describeSemanticIndexForStorage,
  getNativeTables,
  shutdownNativeTablesForTests,
} from './native.js';
import {
  resolveStorageTarget,
  getEmbeddingConfig,
  getWatchdogConfig,
  validateMuninnConfigInput,
  validateMuninnConfigStorage,
} from './config.js';
import { Memories } from './memories/memories.js';
import { Muninn } from './muninn.js';
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

let singletonMuninn: Muninn | null = null;
let singletonMuninnPromise: Promise<Muninn> | null = null;
let bootstrapPromise: Promise<void> | null = null;
let watchdog: Watchdog | null = null;

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
  const embedding = getEmbeddingConfig();
  await tables.semanticIndexTable.validateDimensions({ expected: embedding.dimensions });
  await tables.sessionTable.reconcileOpenTurns();

  const watchdogConfig = getWatchdogConfig();
  if (!watchdogConfig.enabled) {
    watchdog = null;
    return;
  }

  watchdog = new Watchdog(tables, watchdogConfig);
  watchdog.start();
}

async function getMuninn(): Promise<Muninn> {
  if (singletonMuninn) {
    return singletonMuninn;
  }
  if (!singletonMuninnPromise) {
    singletonMuninnPromise = ensureBootstrapped()
      .then((tables) => {
        singletonMuninn = new Muninn(tables);
        return singletonMuninn;
      })
      .catch((error) => {
        singletonMuninnPromise = null;
        throw error;
      });
  }
  return singletonMuninnPromise;
}

export async function addMessage(turnContent: TurnContent): Promise<SessionTurn> {
  return (await getMuninn()).accept(turnContent);
}

export async function validateSettings(content: string): Promise<void> {
  const config = validateMuninnConfigInput(content);
  const storage = resolveStorageTarget(config);
  const description = await describeSemanticIndexForStorage(storage);
  await validateMuninnConfigStorage(config, description);
}

export const sessions = {
  async get(memoryId: string): Promise<SessionTurn | null> {
    return new Memories(await getNativeTables()).getSession(memoryId);
  },

  async list(params: {
    mode: ListModeInput;
    agent?: string;
    sessionId?: string;
  }): Promise<SessionTurn[]> {
    return new Memories(await getNativeTables()).listSessions(params);
  },
};

export const observings = {
  async get(memoryId: string): Promise<ObservingSnapshot | null> {
    return new Memories(await getNativeTables()).getObserving(memoryId);
  },

  async list(params: {
    mode: ListModeInput;
    observer?: string;
  }): Promise<ObservingSnapshot[]> {
    return new Memories(await getNativeTables()).listObservings(params);
  },
};

export const memories = {
  async get(memoryId: string): Promise<RenderedMemory | null> {
    return new Memories(await getNativeTables()).get(memoryId);
  },

  async list(params: {
    mode: ListModeInput;
  }): Promise<RenderedMemory[]> {
    return new Memories(await getNativeTables()).list(params);
  },

  async timeline(params: {
    memoryId: string;
    beforeLimit?: number;
    afterLimit?: number;
  }): Promise<RenderedMemory[]> {
    return new Memories(await getNativeTables()).timeline(params);
  },

  async recall(query: string, limit?: number): Promise<RecallHit[]> {
    return (await getMuninn()).recallMemories(query, limit);
  },
};

export const observer = {
  async watermark(): Promise<ObserverWatermark> {
    return (await getMuninn()).observerWatermark();
  },
};

export async function shutdownCoreForTests(): Promise<void> {
  const muninn = singletonMuninn ?? (singletonMuninnPromise ? await singletonMuninnPromise : null);
  if (muninn) {
    await muninn.shutdown();
  }
  if (watchdog) {
    await watchdog.stop();
  }
  singletonMuninn = null;
  singletonMuninnPromise = null;
  bootstrapPromise = null;
  watchdog = null;
  await shutdownNativeTablesForTests();
}

export const __testing = {
  ...nativeTesting,
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
