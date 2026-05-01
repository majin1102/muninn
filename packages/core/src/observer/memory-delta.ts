import { randomUUID } from 'node:crypto';

import { getEmbeddingConfig } from '../config.js';
import type { NativeTables, Observation as StoredObservation } from '../native.js';
import { embedText } from '../llm/embedding-provider.js';
import type { LlmFieldUpdate, Observation, ObserveResult, SnapshotContent } from './types.js';

export function applyObservationDelta(
  currentObservations: Observation[],
  result: ObserveResult,
): {
  observationDelta: LlmFieldUpdate<Observation>;
  observations: Observation[];
} {
  const before = result.observationDelta.before;
  const after = materializeObservationIds(result.observationDelta.after);

  const currentIds = new Set(currentObservations.map((observation) => observation.id).filter(Boolean));
  const beforeIds = new Set(before.map((observation) => observation.id).filter(Boolean));
  const afterIds = new Set(after.map((observation) => observation.id).filter(Boolean));

  for (const beforeId of beforeIds) {
    if (!currentIds.has(beforeId)) {
      throw new Error('observing delta referenced unknown observation id');
    }
  }

  const deletedIds = new Set([...beforeIds].filter((id) => !afterIds.has(id)));
  const merged = currentObservations
    .filter((observation) => !observation.id || !deletedIds.has(observation.id))
    .map(cloneObservation);

  for (const observation of after) {
    const id = observation.id;
    if (!id) {
      throw new Error('materialized observation missing id');
    }
    const existing = merged.find((candidate) => candidate.id === id);
    if (existing) {
      Object.assign(existing, cloneObservation(observation));
    } else {
      merged.push(cloneObservation(observation));
    }
  }

  return {
    observationDelta: { before, after },
    observations: merged,
  };
}

export async function applyObservationTableDelta(
  client: NativeTables,
  snapshot: SnapshotContent,
  memoryId: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const delta = snapshot.observationDelta;
  const afterIds = new Set(delta.after.map((observation) => observation.id).filter(Boolean));
  const deletedIds = delta.before
    .map((observation) => observation.id)
    .filter((id): id is string => Boolean(id) && !afterIds.has(id));
  if (deletedIds.length > 0) {
    await client.observationTable.delete({ ids: deletedIds });
  }

  const upsertIds = delta.after
    .map((observation) => observation.id)
    .filter((id): id is string => Boolean(id));
  const existingRows = upsertIds.length > 0
    ? await client.observationTable.loadByIds({ ids: upsertIds })
    : [];
  const existingById = new Map(existingRows.map((row) => [row.id, row]));
  const embeddingConfig = getEmbeddingConfig();
  const rows: StoredObservation[] = [];

  for (const observation of delta.after) {
    const id = observation.id;
    const text = observation.text.trim();
    if (!id || !text) {
      continue;
    }
    const existing = existingById.get(id);
    rows.push({
      id,
      text,
      vector: await embedText(text, signal),
      importance: existing?.importance ?? embeddingConfig.defaultImportance,
      category: semanticCategory(observation.category),
      references: [memoryId],
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    });
  }

  if (rows.length > 0) {
    await client.observationTable.upsert({ rows });
  }
}

function materializeObservationIds(observations: Observation[]): Observation[] {
  const seen = new Set<string>();
  return observations.map((observation) => {
    const id = observation.id?.trim() || randomUUID();
    if (seen.has(id)) {
      throw new Error('observing update materialized duplicate observation id');
    }
    seen.add(id);
    return {
      ...cloneObservation(observation),
      id,
    };
  });
}

function cloneObservation(observation: Observation): Observation {
  return {
    id: observation.id ?? null,
    text: observation.text,
    category: observation.category,
    updatedMemory: observation.updatedMemory ?? null,
  };
}

function semanticCategory(category: Observation['category']): string {
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
