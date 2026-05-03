import { createHash } from 'node:crypto';

import { getEmbeddingConfig } from '../config.js';
import { embedText } from '../llm/embedding-provider.js';
import type { NativeTables, Observation as StoredObservation } from '../native.js';
import type {
  Observation,
  ObservationCategory,
  ObservationChange,
  ObserveResult,
  SnapshotContent,
} from './types.js';

export function applyObservationChanges(
  currentObservations: Observation[],
  result: ObserveResult,
): {
  observationChanges: ObservationChange[];
  observations: Observation[];
} {
  const observations = new Map<string, Observation>();
  for (const observation of currentObservations) {
    const normalized = cloneObservation(observation);
    if (!normalized.id) {
      continue;
    }
    observations.set(normalized.id, normalized);
  }

  const changes = normalizeChanges(result.observationChanges, observations);
  for (const change of changes) {
    if (change.type === 'add') {
      const id = addedObservationId(change);
      observations.set(id, {
        id,
        text: change.text,
        category: change.category,
        updatedMemory: null,
      });
      continue;
    }
    if (change.type === 'merge') {
      for (const observationId of change.observationIds) {
        observations.delete(observationId);
      }
      const id = mergedObservationId(change);
      observations.set(id, {
        id,
        text: change.text,
        category: change.category,
        updatedMemory: null,
      });
      continue;
    }
    if (change.type === 'update') {
      const existing = observations.get(change.observationId);
      if (!existing) {
        throw new Error(`observation change referenced unknown observationId: ${change.observationId}`);
      }
      observations.set(change.observationId, {
        ...existing,
        text: change.text,
        category: change.category ?? existing.category,
      });
      continue;
    }
    observations.delete(change.observationId);
  }

  return {
    observationChanges: changes,
    observations: [...observations.values()],
  };
}

export async function applyObservationTableChanges(
  client: NativeTables,
  snapshot: SnapshotContent,
  _memoryId: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const changes = snapshot.observationChanges ?? [];
  if (changes.length === 0) {
    return;
  }

  const sourceIds = new Set<string>();
  const deletedIds = new Set<string>();
  const upsertIds = new Set<string>();
  for (const change of changes) {
    if (change.type === 'add') {
      upsertIds.add(addedObservationId(change));
      continue;
    }
    if (change.type === 'merge') {
      for (const observationId of change.observationIds) {
        sourceIds.add(observationId);
        deletedIds.add(observationId);
      }
      upsertIds.add(mergedObservationId(change));
      continue;
    }
    if (change.type === 'update') {
      sourceIds.add(change.observationId);
      upsertIds.add(change.observationId);
      continue;
    }
    sourceIds.add(change.observationId);
    deletedIds.add(change.observationId);
  }

  const existingRows = sourceIds.size > 0
    ? await client.observationTable.loadByIds({ ids: [...sourceIds] })
    : [];
  const existingById = new Map(existingRows.map((row) => [row.id, row]));

  if (deletedIds.size > 0) {
    await client.observationTable.delete({ ids: [...deletedIds] });
  }

  if (upsertIds.size === 0) {
    return;
  }

  const storedUpserts = await client.observationTable.loadByIds({ ids: [...upsertIds] });
  const storedById = new Map(storedUpserts.map((row) => [row.id, row]));
  const observationsById = new Map(
    snapshot.observations
      .filter((observation): observation is Observation & { id: string } => Boolean(observation.id))
      .map((observation) => [observation.id, observation]),
  );
  const embeddingConfig = getEmbeddingConfig();
  const rows: StoredObservation[] = [];

  for (const change of changes) {
    const id = change.type === 'add'
      ? addedObservationId(change)
      : change.type === 'merge'
        ? mergedObservationId(change)
        : change.type === 'update'
          ? change.observationId
          : null;
    if (!id || !upsertIds.has(id)) {
      continue;
    }
    const observation = observationsById.get(id);
    const text = observation?.text.trim() ?? '';
    if (!observation || !text) {
      continue;
    }
    const existing = storedById.get(id) ?? (change.type === 'update' ? existingById.get(id) : undefined);
    const references = change.type === 'delete' ? [] : referencesForChange(change, existingById);
    rows.push({
      id,
      text,
      vector: await embedText(text, signal),
      importance: existing?.importance ?? embeddingConfig.defaultImportance,
      category: semanticCategory(observation.category),
      references,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    });
  }

  if (rows.length > 0) {
    await client.observationTable.upsert({ rows });
  }
}

function normalizeChanges(
  changes: ObservationChange[],
  observations: Map<string, Observation>,
): ObservationChange[] {
  if (!Array.isArray(changes)) {
    throw new Error('observationChanges must be an array');
  }
  const modifiedIds = new Set<string>();
  return changes.map((change) => {
    const reason = normalizeText(change.reason);
    if (!reason) {
      throw new Error('observation change missing reason');
    }
    if (change.type === 'add') {
      const text = normalizeText(change.text);
      if (!text) {
        throw new Error('add change missing text');
      }
      const references = normalizeIds(change.references);
      if (references.length === 0) {
        throw new Error('add change must include references');
      }
      return {
        type: 'add',
        text,
        category: normalizeCategory(change.category),
        references,
        reason,
      };
    }
    if (change.type === 'merge') {
      const observationIds = normalizeIds(change.observationIds);
      if (observationIds.length < 2) {
        throw new Error('merge change must include at least two observationIds');
      }
      for (const observationId of observationIds) {
        claimObservationId(observationId, observations, modifiedIds);
      }
      const text = normalizeText(change.text);
      if (!text) {
        throw new Error('merge change missing text');
      }
      return {
        type: 'merge',
        observationIds,
        text,
        category: normalizeCategory(change.category),
        reason,
      };
    }
    if (change.type === 'update') {
      const observationId = change.observationId?.trim();
      claimObservationId(observationId, observations, modifiedIds);
      const text = normalizeText(change.text);
      if (!text) {
        throw new Error('update change missing text');
      }
      return {
        type: 'update',
        observationId,
        text,
        ...(change.category ? { category: normalizeCategory(change.category) } : {}),
        ...(Array.isArray(change.references) ? { references: normalizeIds(change.references) } : {}),
        reason,
      };
    }
    if (change.type === 'delete') {
      const observationId = change.observationId?.trim();
      claimObservationId(observationId, observations, modifiedIds);
      return {
        type: 'delete',
        observationId,
        reason,
      };
    }
    throw new Error('unknown observation change type');
  });
}

function claimObservationId(
  observationId: string | undefined,
  observations: Map<string, Observation>,
  modifiedIds: Set<string>,
): asserts observationId is string {
  if (!observationId || !observations.has(observationId)) {
    throw new Error(`observation change referenced unknown observationId: ${observationId ?? ''}`);
  }
  if (observationId.startsWith('session:')) {
    throw new Error(`observation change cannot modify source turn id: ${observationId}`);
  }
  if (modifiedIds.has(observationId)) {
    throw new Error(`observation change modified observationId more than once: ${observationId}`);
  }
  modifiedIds.add(observationId);
}

function referencesForChange(
  change: Extract<ObservationChange, { type: 'add' | 'merge' | 'update' }>,
  existingById: Map<string, StoredObservation>,
): string[] {
  if (change.type === 'add') {
    return change.references;
  }
  if (change.type === 'update') {
    return [
      ...new Set([
        ...(existingById.get(change.observationId)?.references ?? []),
        ...(change.references ?? []),
      ]),
    ];
  }
  const references = [];
  for (const observationId of change.observationIds) {
    references.push(...(existingById.get(observationId)?.references ?? []));
  }
  return [...new Set(references)];
}

function addedObservationId(change: Extract<ObservationChange, { type: 'add' }>): string {
  return stableObservationId({
    type: change.type,
    text: change.text,
    category: change.category,
    references: [...change.references].sort(),
  });
}

function mergedObservationId(change: Extract<ObservationChange, { type: 'merge' }>): string {
  return stableObservationId({
    type: change.type,
    observationIds: [...change.observationIds].sort(),
    text: change.text,
    category: change.category,
  });
}

function stableObservationId(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 24);
}

function cloneObservation(observation: Observation): Observation {
  return {
    id: observation.id?.trim() || null,
    text: normalizeText(observation.text),
    category: normalizeCategory(observation.category),
    updatedMemory: observation.updatedMemory?.trim() || null,
  };
}

function normalizeIds(ids: string[]): string[] {
  return [...new Set((ids ?? []).map((id) => id.trim()).filter(Boolean))];
}

function normalizeCategory(category: ObservationCategory): ObservationCategory {
  if ([
    'Preference',
    'Fact',
    'Decision',
    'Entity',
    'Concept',
    'Other',
  ].includes(category)) {
    return category;
  }
  throw new Error(`invalid observation category: ${category}`);
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

function normalizeText(value: string): string {
  return value.split(/\s+/).join(' ').trim();
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
