import { randomUUID } from 'node:crypto';

import { getEmbeddingConfig } from '../config.js';
import type { NativeTables } from '../native.js';
import { embedText } from '../llm/embedding-provider.js';
import type { LlmFieldUpdate, ObserveResult, ObservedMemory, SemanticIndexRow, SnapshotContent } from './types.js';

export function applyMemoriesDelta(
  currentMemories: ObservedMemory[],
  result: ObserveResult,
): {
  memoryDelta: LlmFieldUpdate<ObservedMemory>;
  memories: ObservedMemory[];
} {
  const before = result.memoryDelta.before;
  const after = materializeMemoryIds(result.memoryDelta.after);

  const currentIds = new Set(currentMemories.map((memory) => memory.id).filter(Boolean));
  const beforeIds = new Set(before.map((memory) => memory.id).filter(Boolean));
  const afterIds = new Set(after.map((memory) => memory.id).filter(Boolean));

  for (const beforeId of beforeIds) {
    if (!currentIds.has(beforeId)) {
      throw new Error('observing delta referenced unknown memory id');
    }
  }

  const deletedIds = new Set([...beforeIds].filter((id) => !afterIds.has(id)));
  const merged = currentMemories
    .filter((memory) => !memory.id || !deletedIds.has(memory.id))
    .map(cloneMemory);

  for (const memory of after) {
    const id = memory.id;
    if (!id) {
      throw new Error('materialized memory missing id');
    }
    const existing = merged.find((candidate) => candidate.id === id);
    if (existing) {
      Object.assign(existing, cloneMemory(memory));
    } else {
      merged.push(cloneMemory(memory));
    }
  }

  return {
    memoryDelta: { before, after },
    memories: merged,
  };
}

export async function applySemanticMemoryDelta(
  client: NativeTables,
  snapshot: SnapshotContent,
  memoryId: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const delta = snapshot.memoryDelta;
  const afterIds = new Set(delta.after.map((memory) => memory.id).filter(Boolean));
  const deletedIds = delta.before
    .map((memory) => memory.id)
    .filter((id): id is string => Boolean(id) && !afterIds.has(id));
  if (deletedIds.length > 0) {
    await client.semanticIndexTable.delete({ ids: deletedIds });
  }

  const upsertIds = delta.after
    .map((memory) => memory.id)
    .filter((id): id is string => Boolean(id));
  const existingRows = upsertIds.length > 0
    ? await client.semanticIndexTable.loadByIds({ ids: upsertIds })
    : [];
  const existingById = new Map(existingRows.map((row) => [row.id, row]));
  const embeddingConfig = getEmbeddingConfig();
  const rows: SemanticIndexRow[] = [];

  for (const memory of delta.after) {
    const id = memory.id;
    const text = memory.text.trim();
    if (!id || !text) {
      continue;
    }
    const existing = existingById.get(id);
    rows.push({
      id,
      memoryId,
      text,
      vector: await embedText(text, signal),
      importance: existing?.importance ?? embeddingConfig.defaultImportance,
      category: semanticCategory(memory.category),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    });
  }

  if (rows.length > 0) {
    await client.semanticIndexTable.upsert({ rows });
  }
}

function materializeMemoryIds(memories: ObservedMemory[]): ObservedMemory[] {
  const seen = new Set<string>();
  return memories.map((memory) => {
    const id = memory.id?.trim() || randomUUID();
    if (seen.has(id)) {
      throw new Error('observing update materialized duplicate memory id');
    }
    seen.add(id);
    return {
      ...cloneMemory(memory),
      id,
    };
  });
}

function cloneMemory(memory: ObservedMemory): ObservedMemory {
  return {
    id: memory.id ?? null,
    text: memory.text,
    category: memory.category,
    updatedMemory: memory.updatedMemory ?? null,
  };
}

function semanticCategory(category: ObservedMemory['category']): string {
  switch (category) {
    case 'Preference':
      return 'preference';
    case 'Fact':
      return 'fact';
    case 'Decision':
      return 'decision';
    case 'Entity':
      return 'entity';
    case 'Concept':
    case 'Other':
      return 'other';
    default:
      return 'other';
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  const reason = signal.reason;
  if (reason instanceof Error) {
    throw reason;
  }
  const error = new Error('operation aborted');
  error.name = 'AbortError';
  throw error;
}
