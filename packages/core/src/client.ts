import { __testing as nativeTesting, getCoreBinding, shutdownCoreBindingForTests } from './native.js';
import { validateMuninnConfigContent } from './config.js';
import { Muninn } from './muninn.js';

export interface SessionTurnRecord {
  turnId: string;
  createdAt: string;
  updatedAt: string;
  session_id?: string | null;
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
    indexedSnapshotSequence?: number | null;
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

export interface ObserverWatermarkRecord {
  resolved: boolean;
  pendingTurnIds: string[];
  observingEpoch?: number;
  committedEpoch?: number;
}

export type ListModeInput =
  | { type: 'recency'; limit: number }
  | { type: 'page'; offset: number; limit: number };

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

let singletonMuninn: Muninn | null = null;

function getMuninn(): Muninn {
  if (!singletonMuninn) {
    singletonMuninn = new Muninn(getCoreBinding());
  }
  return singletonMuninn;
}

export async function addMessage(session: SessionMessageInput): Promise<SessionTurnRecord> {
  return getMuninn().accept(session);
}

export async function validateSettings(content: string): Promise<void> {
  await validateMuninnConfigContent(content, getCoreBinding());
}

export const sessions = {
  async get(memoryId: string): Promise<SessionTurnRecord | null> {
    return getMuninn().memories.getSession(memoryId);
  },

  async list(params: {
    mode: ListModeInput;
    agent?: string;
    sessionId?: string;
  }): Promise<SessionTurnRecord[]> {
    return getMuninn().memories.listSessions(params);
  },
};

export const observings = {
  async get(memoryId: string): Promise<ObservingRecord | null> {
    return getMuninn().memories.getObserving(memoryId);
  },

  async list(params: {
    mode: ListModeInput;
    observer?: string;
  }): Promise<ObservingRecord[]> {
    return getMuninn().memories.listObservings(params);
  },
};

export const memories = {
  async get(memoryId: string): Promise<RenderedMemoryRecord | null> {
    return getMuninn().memories.get(memoryId);
  },

  async list(params: {
    mode: ListModeInput;
  }): Promise<RenderedMemoryRecord[]> {
    return getMuninn().memories.list(params);
  },

  async timeline(params: {
    memoryId: string;
    beforeLimit?: number;
    afterLimit?: number;
  }): Promise<RenderedMemoryRecord[]> {
    return getMuninn().memories.timeline(params);
  },

  async recall(query: string, limit?: number): Promise<RecallHitRecord[]> {
    return getMuninn().recallMemories(query, limit);
  },
};

export const observer = {
  async watermark(): Promise<ObserverWatermarkRecord> {
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
