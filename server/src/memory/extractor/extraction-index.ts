import { createHash } from 'node:crypto';

import { embedText } from '../llm/embedding-provider.js';
import type { NativeTables, Extraction as StoredExtraction } from '../native.js';
import type { QueuedExtractionChange } from '../checkpoint.js';
import type {
  Extraction,
  ExtractionChange,
  ExtractSessionMemoryResult,
  SnapshotContent,
  SessionMemoryThread,
} from './types.js';
import {
  getPendingIndex,
  snapshotRef,
  threadIdentityKey,
} from './snapshot.js';

export function applyExtractionChanges(
  currentExtractions: Extraction[],
  result: ExtractSessionMemoryResult,
): {
  extractionChanges: ExtractionChange[];
  extractions: Extraction[];
} {
  const currentById = new Map<string, Extraction>();
  const currentByUnitKey = new Map<string, Extraction>();
  for (const row of currentExtractions) {
    const normalized = cloneExtraction(row, { requireReferences: false });
    if (!normalized.id) {
      continue;
    }
    currentById.set(normalized.id, normalized);
    currentByUnitKey.set(extractionUnitKey(normalized), normalized);
  }

  const nextExtractions: Extraction[] = [];
  const changes: ExtractionChange[] = [];
  const seenIds = new Set<string>();

  for (const raw of result.extractions) {
    const normalized = cloneExtraction(raw, { requireReferences: true });
    const generatedId = addedExtractionId({
      type: 'add',
      text: normalized.text,
      context: normalized.context ?? null,
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
    const next = {
      ...normalized,
      id,
      updatedMemory: existing?.updatedMemory ?? normalized.updatedMemory ?? null,
    };
    nextExtractions.push(next);

    if (!existing) {
      changes.push({
        type: 'add',
        text: next.text,
        context: next.context ?? null,
        references: next.references,
        reason: 'state rewrite added extraction',
      });
      continue;
    }

    if (
      existing.text !== next.text
      || (existing.context ?? null) !== (next.context ?? null)
      || !sameStringSet(existing.references, next.references)
    ) {
      changes.push({
        type: 'update',
        extractionId: id,
        text: next.text,
        references: next.references,
        context: next.context ?? null,
        reason: 'state rewrite updated extraction',
      });
    }
  }

  for (const id of currentById.keys()) {
    if (!seenIds.has(id)) {
      changes.push({
        type: 'delete',
        extractionId: id,
        reason: 'state rewrite omitted extraction',
      });
    }
  }

  return {
    extractionChanges: changes,
    extractions: nextExtractions,
  };
}

export async function applyExtractionTableChanges(
  client: NativeTables,
  snapshot: SnapshotContent,
  _snapshotId: string,
  signal?: AbortSignal,
): Promise<QueuedExtractionChange[]> {
  throwIfAborted(signal);
  const changes = snapshot.extractionChanges ?? [];
  if (changes.length === 0) {
    return [];
  }
  const cwd = snapshot.cwd?.trim();
  if (!cwd) {
    throw new Error('snapshot cwd is required to write extractions');
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
  const observationsById = new Map(
    snapshot.extractions
      .filter((row): row is Extraction & { id: string } => Boolean(row.id))
      .map((row) => [row.id, row]),
  );
  const rows: StoredExtraction[] = [];

  for (const change of changes) {
    if (change.type === 'delete') {
      continue;
    }
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
    const observation = observationsById.get(id);
    const text = observation?.text.trim() ?? '';
    if (!observation || !text) {
      continue;
    }
    const existing = storedById.get(id) ?? (change.type === 'update' ? existingById.get(id) : undefined);
    const references = referencesForChange(change, existingById);
    const now = new Date().toISOString();
    const title = extractionTitle(observation);
    const summary = extractionSummary(title, observation);
    rows.push({
      id,
      title,
      summary,
      content: extractionContent(title, observation),
      cwd,
      vector: await embedText(summary, signal),
      turnRefs: references,
      observationPaths: existing?.observationPaths ?? [],
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

async function catchUpIndex(
  client: NativeTables,
  thread: SessionMemoryThread,
  signal?: AbortSignal,
): Promise<QueuedExtractionChange[]> {
  const pending = getPendingIndex(thread);
  if (!pending) {
    return [];
  }

  let latestIndexedSequence = thread.indexedSnapshotSequence ?? null;
  const queued: QueuedExtractionChange[] = [];
  for (let snapshotIndex = pending.start; snapshotIndex <= pending.end; snapshotIndex += 1) {
    throwIfAborted(signal);
    const current = thread.snapshots[snapshotIndex];
    const previous = snapshotIndex > 0 ? thread.snapshots[snapshotIndex - 1] : undefined;
    const previousIds = new Set((previous?.extractions ?? [])
      .map((extraction) => extraction.id)
      .filter((id): id is string => Boolean(id)));
    const diff = applyExtractionChanges(previous?.extractions ?? [], {
      title: thread.title,
      summary: thread.summary,
      signals: current.signals ?? '',
      snapshotContent: current.snapshotContent,
      extractions: current.extractions.map((extraction) => (
        extraction.id && previousIds.has(extraction.id)
          ? extraction
          : { ...extraction, id: undefined }
      )),
      openQuestions: current.openQuestions ?? [],
      nextSteps: current.nextSteps ?? [],
      contextRefs: current.contextRefs,
    });
    queued.push(...await applyExtractionTableChanges(
      client,
      {
        ...current,
        extractions: diff.extractions,
        extractionChanges: diff.extractionChanges,
      },
      snapshotRef(thread, snapshotIndex),
      signal,
    ));
    latestIndexedSequence = snapshotIndex;
  }

  if (latestIndexedSequence !== thread.indexedSnapshotSequence) {
    thread.indexedSnapshotSequence = latestIndexedSequence;
  }
  return queued;
}

export async function buildExtraction(
  client: NativeTables,
  threads: SessionMemoryThread[],
  signal?: AbortSignal,
): Promise<QueuedExtractionChange[]> {
  let firstError: unknown = null;
  const queued: QueuedExtractionChange[] = [];
  for (const thread of threads) {
    throwIfAborted(signal);
    if (!getPendingIndex(thread)) {
      continue;
    }
    try {
      queued.push(...await catchUpIndex(client, thread, signal));
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) {
    throw firstError;
  }
  return queued;
}

export async function buildTouchedIndex(
  client: NativeTables,
  threads: SessionMemoryThread[],
  touchedIds: Set<string>,
  signal?: AbortSignal,
): Promise<QueuedExtractionChange[]> {
  let firstError: unknown = null;
  const queued: QueuedExtractionChange[] = [];
  for (const thread of threads) {
    throwIfAborted(signal);
    if (!touchedIds.has(threadIdentityKey(thread)) || !getPendingIndex(thread)) {
      continue;
    }
    try {
      queued.push(...await catchUpIndex(client, thread, signal));
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) {
    throw firstError;
  }
  return queued;
}

export const __testing = {
  buildTouchedIndex,
  buildExtraction,
};

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
    context: change.context ?? null,
    references: [...change.references].sort(),
  });
}

function mergedExtractionId(change: Extract<ExtractionChange, { type: 'merge' }>): string {
  return stableExtractionId({
    type: change.type,
    extractionIds: [...change.extractionIds].sort(),
    text: change.text,
    context: change.context ?? null,
  });
}

function stableExtractionId(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 24);
}

function cloneExtraction(
  row: Extraction,
  options: { requireReferences: boolean } = { requireReferences: true },
): Extraction {
  const text = normalizeText(row.text);
  if (!text) {
    throw new Error('extraction text is required');
  }
  const references = normalizeIds(row.references);
  if (options.requireReferences && references.length === 0) {
    throw new Error('extraction references must include at least one reference');
  }
  return {
    id: row.id?.trim() || null,
    title: normalizeText(row.title ?? '') || null,
    text,
    context: normalizeContext(row.context ?? null),
    references,
    updatedMemory: row.updatedMemory?.trim() || null,
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

function normalizeText(value: string): string {
  return value.split(/\s+/).join(' ').trim();
}

function normalizeContext(value: string | null): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed || null;
}

function extractionUnitKey(row: Extraction): string {
  return [
    normalizeText(row.title ?? ''),
    normalizeText(row.text),
    [...(row.references ?? [])].sort().join('\u0001'),
  ].join('\u0002');
}

function extractionTitle(row: Extraction): string {
  return normalizeText(row.title ?? '') || normalizeText(row.text).slice(0, 80);
}

function extractionSummary(title: string, row: Extraction): string {
  return [
    title,
    row.text,
  ].filter(Boolean).join('\n\n');
}

function extractionContent(title: string, row: Extraction): string {
  return [
    '## Title',
    '',
    title,
    '',
    '## Summary',
    '',
    normalizeText(row.text),
    '',
    '## Content',
    '',
    row.context?.trim() ?? '',
  ].join('\n');
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
