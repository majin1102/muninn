import { createHash } from 'node:crypto';

import { getEmbeddingConfig } from '../config.js';
import { embedText } from '../llm/embedding-provider.js';
import type { NativeTables, Extraction as StoredExtraction } from '../native.js';
import type { QueuedExtractionChange } from '../checkpoint.js';
import type {
  Extraction,
  ExtractionChange,
  ObserveResult,
  SnapshotContent,
} from './types.js';

export function applyExtractionChanges(
  currentExtractions: Extraction[],
  result: ObserveResult,
): {
  extractionChanges: ExtractionChange[];
  extractions: Extraction[];
} {
  const currentById = new Map<string, Extraction>();
  const currentByUnitKey = new Map<string, Extraction>();
  for (const extraction of currentExtractions) {
    const normalized = cloneExtraction(extraction, { requireReferences: false });
    if (!normalized.id) {
      continue;
    }
    currentById.set(normalized.id, normalized);
    const key = extractionUnitKey(normalized);
    if (key) {
      currentByUnitKey.set(key, normalized);
    }
  }

  const nextExtractions: Extraction[] = [];
  const changes: ExtractionChange[] = [];
  const seenIds = new Set<string>();

  for (const rawExtraction of result.extractions) {
    const normalized = cloneExtraction(rawExtraction, { requireReferences: true });
    const generatedId = addedExtractionId({
      type: 'add',
      text: normalized.text,
      references: normalized.references,
      reason: 'state rewrite added extraction',
    });
    const matched = normalized.id
      ? currentById.get(normalized.id)
      : currentById.get(generatedId) ?? currentByUnitKey.get(extractionUnitKey(normalized));
    const id = normalized.id || matched?.id || generatedId;
    if (seenIds.has(id)) {
      throw new Error(`duplicate extraction id in state rewrite: ${id}`);
    }

    const existing = currentById.get(id);
    if (normalized.id && !existing) {
      throw new Error(`unknown extraction id in state rewrite: ${normalized.id}`);
    }

    seenIds.add(id);
    const nextExtraction = {
      ...normalized,
      id,
      updatedMemory: existing?.updatedMemory ?? normalized.updatedMemory ?? null,
    };
    nextExtractions.push(nextExtraction);

    if (!existing) {
      changes.push({
        type: 'add',
        text: nextExtraction.text,
        context: nextExtraction.context ?? null,
        anchors: nextExtraction.anchors ?? [],
        references: nextExtraction.references,
        reason: 'state rewrite added extraction',
      });
      continue;
    }

    if (
      existing.text !== nextExtraction.text
      || (existing.context ?? null) !== (nextExtraction.context ?? null)
      || !sameStringSet(existing.anchors ?? [], nextExtraction.anchors ?? [])
      || !sameStringSet(existing.references, nextExtraction.references)
    ) {
      changes.push({
        type: 'update',
        extractionId: id,
        text: nextExtraction.text,
        references: nextExtraction.references,
        context: nextExtraction.context ?? null,
        anchors: nextExtraction.anchors ?? [],
        reason: 'state rewrite updated extraction',
      });
    }
  }

  for (const extractionId of currentById.keys()) {
    if (!seenIds.has(extractionId)) {
      changes.push({
        type: 'delete',
        extractionId,
        reason: 'state rewrite omitted extraction',
      });
    }
  }

  return {
    extractionChanges: changes,
    extractions: nextExtractions,
  };
}

function extractionUnitKey(extraction: Extraction): string {
  return [
    [...(extraction.anchors ?? [])].sort().join('\u0001'),
    [...(extraction.references ?? [])].sort().join('\u0001'),
  ].join('\u0002');
}

export async function applyExtractionTableChanges(
  client: NativeTables,
  snapshot: SnapshotContent,
  _memoryId: string,
  signal?: AbortSignal,
): Promise<QueuedExtractionChange[]> {
  throwIfAborted(signal);
  const changes = snapshot.extractionChanges ?? [];
  if (changes.length === 0) {
    return [];
  }

  const sourceIds = new Set<string>();
  const deletedIds = new Set<string>();
  const upsertIds = new Set<string>();
  for (const change of changes) {
    if (change.type === 'add') {
      upsertIds.add(addedExtractionId(change));
      continue;
    }
    if (change.type === 'merge') {
      for (const extractionId of change.extractionIds) {
        sourceIds.add(extractionId);
        deletedIds.add(extractionId);
      }
      upsertIds.add(mergedExtractionId(change));
      continue;
    }
    if (change.type === 'update') {
      sourceIds.add(change.extractionId);
      upsertIds.add(change.extractionId);
      continue;
    }
    sourceIds.add(change.extractionId);
    deletedIds.add(change.extractionId);
  }

  const existingRows = sourceIds.size > 0
    ? await client.extractionTable.get({ ids: [...sourceIds] })
    : [];
  const existingById = new Map(existingRows.map((row) => [row.id, row]));
  const queued: QueuedExtractionChange[] = [];

  if (deletedIds.size > 0) {
    await client.extractionTable.delete({ ids: [...deletedIds] });
    for (const id of deletedIds) {
      const existing = existingById.get(id);
      if (existing) {
        queued.push({ type: 'delete', extraction: existing });
      }
    }
  }

  if (upsertIds.size === 0) {
    return queued;
  }

  const storedUpserts = await client.extractionTable.get({ ids: [...upsertIds] });
  const storedById = new Map(storedUpserts.map((row) => [row.id, row]));
  const extractionsById = new Map(
    snapshot.extractions
      .filter((extraction): extraction is Extraction & { id: string } => Boolean(extraction.id))
      .map((extraction) => [extraction.id, extraction]),
  );
  const embeddingConfig = getEmbeddingConfig();
  const rows: StoredExtraction[] = [];

  for (const change of changes) {
    const id = change.type === 'add'
      ? addedExtractionId(change)
      : change.type === 'merge'
        ? mergedExtractionId(change)
        : change.type === 'update'
          ? change.extractionId
          : null;
    if (!id || !upsertIds.has(id)) {
      continue;
    }
    const extraction = extractionsById.get(id);
    const text = extraction?.text.trim() ?? '';
    if (!extraction || !text) {
      continue;
    }
    const existing = storedById.get(id) ?? (change.type === 'update' ? existingById.get(id) : undefined);
    const references = change.type === 'delete' ? [] : referencesForChange(change, existingById);
    const now = new Date().toISOString();
    rows.push({
      id,
      text,
      context: extraction.context ?? null,
      anchors: extraction.anchors ?? [],
      vector: await embedText(embeddingText(extraction), signal),
      importance: existing?.importance ?? embeddingConfig.defaultImportance,
      turnRefs: references,
      observationPaths: existing?.observationPaths ?? [],
      observedRootAnchors: existing?.observedRootAnchors ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  if (rows.length > 0) {
    await client.extractionTable.upsert({ rows });
    queued.push(...rows.map((row) => ({ type: 'upsert' as const, extraction: row })));
  }
  return queued;
}

function normalizeChanges(
  changes: ExtractionChange[],
  extractions: Map<string, Extraction>,
): ExtractionChange[] {
  if (!Array.isArray(changes)) {
    throw new Error('extractionChanges must be an array');
  }
  const modifiedIds = new Set<string>();
  return changes.map((change) => {
    const reason = normalizeText(change.reason);
    if (!reason) {
      throw new Error('extraction change missing reason');
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
        ...(change.context ? { context: normalizeText(change.context) } : {}),
        references,
        reason,
      };
    }
    if (change.type === 'merge') {
      const extractionIds = normalizeIds(change.extractionIds);
      if (extractionIds.length < 2) {
        throw new Error('merge change must include at least two extractionIds');
      }
      for (const extractionId of extractionIds) {
        claimExtractionId(extractionId, extractions, modifiedIds);
      }
      const text = normalizeText(change.text);
      if (!text) {
        throw new Error('merge change missing text');
      }
      return {
        type: 'merge',
        extractionIds,
        text,
        ...(change.context ? { context: normalizeText(change.context) } : {}),
        reason,
      };
    }
    if (change.type === 'update') {
      const extractionId = change.extractionId?.trim();
      claimExtractionId(extractionId, extractions, modifiedIds);
      const text = normalizeText(change.text);
      if (!text) {
        throw new Error('update change missing text');
      }
      return {
        type: 'update',
        extractionId,
        text,
        ...(change.context ? { context: normalizeText(change.context) } : {}),
        ...(Array.isArray(change.references) ? { references: normalizeIds(change.references) } : {}),
        reason,
      };
    }
    if (change.type === 'delete') {
      const extractionId = change.extractionId?.trim();
      claimExtractionId(extractionId, extractions, modifiedIds);
      return {
        type: 'delete',
        extractionId,
        reason,
      };
    }
    throw new Error('unknown extraction change type');
  });
}

function claimExtractionId(
  extractionId: string | undefined,
  extractions: Map<string, Extraction>,
  modifiedIds: Set<string>,
): asserts extractionId is string {
  if (!extractionId || !extractions.has(extractionId)) {
    throw new Error(`extraction change referenced unknown extractionId: ${extractionId ?? ''}`);
  }
  if (extractionId.startsWith('session:')) {
    throw new Error(`extraction change cannot modify source turn id: ${extractionId}`);
  }
  if (modifiedIds.has(extractionId)) {
    throw new Error(`extraction change modified extractionId more than once: ${extractionId}`);
  }
  modifiedIds.add(extractionId);
}

function referencesForChange(
  change: Extract<ExtractionChange, { type: 'add' | 'merge' | 'update' }>,
  existingById: Map<string, StoredExtraction>,
): string[] {
  if (change.type === 'add') {
    return change.references;
  }
  if (change.type === 'update') {
    return change.references ?? existingById.get(change.extractionId)?.turnRefs ?? [];
  }
  const references = [];
  for (const extractionId of change.extractionIds) {
    references.push(...(existingById.get(extractionId)?.turnRefs ?? []));
  }
  return [...new Set(references)];
}

function addedExtractionId(change: Extract<ExtractionChange, { type: 'add' }>): string {
  return stableExtractionId({
    type: change.type,
    text: change.text,
    references: [...change.references].sort(),
  });
}

function mergedExtractionId(change: Extract<ExtractionChange, { type: 'merge' }>): string {
  return stableExtractionId({
    type: change.type,
    extractionIds: [...change.extractionIds].sort(),
    text: change.text,
  });
}

function stableExtractionId(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 24);
}

function cloneExtraction(
  extraction: Extraction,
  options: { requireReferences: boolean } = { requireReferences: true },
): Extraction {
  const text = normalizeText(extraction.text);
  if (!text) {
    throw new Error('extraction text is required');
  }
  const references = normalizeIds(extraction.references);
  if (options.requireReferences && references.length === 0) {
    throw new Error('extraction references must include at least one reference');
  }
  return {
    id: extraction.id?.trim() || null,
    text,
    context: normalizeText(extraction.context ?? '') || null,
    anchors: normalizeAnchors(extraction.anchors ?? []),
    references,
    updatedMemory: extraction.updatedMemory?.trim() || null,
  };
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function normalizeIds(ids: string[]): string[] {
  return [...new Set((ids ?? []).map((id) => id.trim()).filter(Boolean))];
}

function normalizeAnchors(anchors: string[]): string[] {
  return [...new Set((anchors ?? []).map((anchor) => normalizeText(anchor)).filter(Boolean))];
}

function normalizeText(value: string): string {
  return value.split(/\s+/).join(' ').trim();
}

function embeddingText(extraction: Extraction): string {
  const anchors = normalizeAnchors(extraction.anchors ?? []);
  const context = normalizeText(extraction.context ?? '');
  return [
    anchors.length > 0 ? `Anchors: ${anchors.join('; ')}` : '',
    context,
    extraction.text,
  ].filter(Boolean).join('\n');
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
