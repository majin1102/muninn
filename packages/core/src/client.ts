import {
  __testing as nativeTesting,
  describeSemanticIndexForStorage,
  getNativeTables,
  shutdownNativeTablesForTests,
} from './native.js';
import type { NativeTables } from './native.js';
import {
  resolveStorageTarget,
  getEmbeddingConfig,
  getWatchdogConfig,
  validateMuninnConfigInput,
  validateMuninnConfigStorage,
} from './config.js';
import { Memories } from './memories/memories.js';
import { Muninn } from './muninn.js';
import { hasText, sessionKey } from './session/key.js';
import { readSessionTurn, serializeSessionTurn } from './session/types.js';
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
const REPAIR_PAGE_SIZE = 1_000;

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
  await repairOpenTurns(tables);

  const watchdogConfig = getWatchdogConfig();
  if (!watchdogConfig.enabled) {
    watchdog = null;
    return;
  }

  watchdog = new Watchdog(tables, watchdogConfig);
  watchdog.start();
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
