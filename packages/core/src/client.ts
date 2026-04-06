import {
  __testing as nativeTesting,
  describeSemanticIndexForStorage,
  getCoreBinding,
  shutdownCoreBindingForTests,
} from './native.js';
import {
  resolveStorageTarget,
  validateMuninnConfigInput,
  validateMuninnConfigStorage,
} from './config.js';
import { Muninn } from './muninn.js';

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

export interface SessionMessageInput {
  sessionId?: string;
  agent: string;
  title?: string;
  summary?: string;
  toolCalling?: string[];
  artifacts?: Record<string, string>;
  prompt?: string;
  response?: string;
}

let singletonMuninn: Muninn | null = null;
let singletonMuninnPromise: Promise<Muninn> | null = null;

async function getMuninn(): Promise<Muninn> {
  if (singletonMuninn) {
    return singletonMuninn;
  }
  if (!singletonMuninnPromise) {
    singletonMuninnPromise = getCoreBinding()
      .then((binding) => {
        singletonMuninn = new Muninn(binding);
        return singletonMuninn;
      })
      .catch((error) => {
        singletonMuninnPromise = null;
        throw error;
      });
  }
  return singletonMuninnPromise;
}

export async function addMessage(session: SessionMessageInput): Promise<SessionTurn> {
  return (await getMuninn()).accept(session);
}

export async function validateSettings(content: string): Promise<void> {
  const config = validateMuninnConfigInput(content);
  const storage = resolveStorageTarget(config);
  const description = await describeSemanticIndexForStorage(storage);
  await validateMuninnConfigStorage(config, description);
}

export const sessions = {
  async get(memoryId: string): Promise<SessionTurn | null> {
    return (await getMuninn()).memories.getSession(memoryId);
  },

  async list(params: {
    mode: ListModeInput;
    agent?: string;
    sessionId?: string;
  }): Promise<SessionTurn[]> {
    return (await getMuninn()).memories.listSessions(params);
  },
};

export const observings = {
  async get(memoryId: string): Promise<ObservingSnapshot | null> {
    return (await getMuninn()).memories.getObserving(memoryId);
  },

  async list(params: {
    mode: ListModeInput;
    observer?: string;
  }): Promise<ObservingSnapshot[]> {
    return (await getMuninn()).memories.listObservings(params);
  },
};

export const memories = {
  async get(memoryId: string): Promise<RenderedMemory | null> {
    return (await getMuninn()).memories.get(memoryId);
  },

  async list(params: {
    mode: ListModeInput;
  }): Promise<RenderedMemory[]> {
    return (await getMuninn()).memories.list(params);
  },

  async timeline(params: {
    memoryId: string;
    beforeLimit?: number;
    afterLimit?: number;
  }): Promise<RenderedMemory[]> {
    return (await getMuninn()).memories.timeline(params);
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
  singletonMuninn = null;
  singletonMuninnPromise = null;
  await shutdownCoreBindingForTests();
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
