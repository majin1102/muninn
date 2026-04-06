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

function getMuninn(): Muninn {
  if (!singletonMuninn) {
    singletonMuninn = new Muninn(getCoreBinding());
  }
  return singletonMuninn;
}

export async function addMessage(session: SessionMessageInput): Promise<SessionTurn> {
  return getMuninn().accept(session);
}

export async function validateSettings(content: string): Promise<void> {
  const config = validateMuninnConfigInput(content);
  const storage = resolveStorageTarget(config);
  const description = await describeSemanticIndexForStorage(storage);
  await validateMuninnConfigStorage(config, description);
}

export const sessions = {
  async get(memoryId: string): Promise<SessionTurn | null> {
    return getMuninn().memories.getSession(memoryId);
  },

  async list(params: {
    mode: ListModeInput;
    agent?: string;
    sessionId?: string;
  }): Promise<SessionTurn[]> {
    return getMuninn().memories.listSessions(params);
  },
};

export const observings = {
  async get(memoryId: string): Promise<ObservingSnapshot | null> {
    return getMuninn().memories.getObserving(memoryId);
  },

  async list(params: {
    mode: ListModeInput;
    observer?: string;
  }): Promise<ObservingSnapshot[]> {
    return getMuninn().memories.listObservings(params);
  },
};

export const memories = {
  async get(memoryId: string): Promise<RenderedMemory | null> {
    return getMuninn().memories.get(memoryId);
  },

  async list(params: {
    mode: ListModeInput;
  }): Promise<RenderedMemory[]> {
    return getMuninn().memories.list(params);
  },

  async timeline(params: {
    memoryId: string;
    beforeLimit?: number;
    afterLimit?: number;
  }): Promise<RenderedMemory[]> {
    return getMuninn().memories.timeline(params);
  },

  async recall(query: string, limit?: number): Promise<RecallHit[]> {
    return getMuninn().recallMemories(query, limit);
  },
};

export const observer = {
  async watermark(): Promise<ObserverWatermark> {
    return getMuninn().observerWatermark();
  },
};

export async function shutdownCoreForTests(): Promise<void> {
  if (singletonMuninn) {
    await singletonMuninn.shutdown();
  }
  singletonMuninn = null;
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
