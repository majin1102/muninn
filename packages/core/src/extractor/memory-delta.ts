import { createHash } from 'node:crypto';

import { embedText } from '../llm/embedding-provider.js';
import type { NativeTables, SessionObservation as StoredSessionObservation } from '../native.js';
import type { QueuedSessionObservationChange } from '../checkpoint.js';
import type {
  SessionObservation,
  SessionObservationChange,
  ExtractSessionMemoryResult,
  SnapshotContent,
} from './types.js';

export function applySessionObservationChanges(
  currentSessionObservations: SessionObservation[],
  result: ExtractSessionMemoryResult,
): {
  extractionChanges: SessionObservationChange[];
  extractions: SessionObservation[];
} {
  const currentById = new Map<string, SessionObservation>();
  const currentByUnitKey = new Map<string, SessionObservation>();
  for (const row of currentSessionObservations) {
    const normalized = cloneSessionObservation(row, { requireReferences: false });
    if (!normalized.id) {
      continue;
    }
    currentById.set(normalized.id, normalized);
    currentByUnitKey.set(sessionObservationUnitKey(normalized), normalized);
  }

  const nextSessionObservations: SessionObservation[] = [];
  const changes: SessionObservationChange[] = [];
  const seenIds = new Set<string>();

  for (const raw of result.extractions) {
    const normalized = cloneSessionObservation(raw, { requireReferences: true });
    const generatedId = addedSessionObservationId({
      type: 'add',
      text: normalized.text,
      context: normalized.context ?? null,
      references: normalized.references,
      reason: 'state rewrite added session observation',
    });
    const matched = normalized.id
      ? currentById.get(normalized.id)
      : currentById.get(generatedId) ?? currentByUnitKey.get(sessionObservationUnitKey(normalized));
    const id = normalized.id || matched?.id || generatedId;
    if (seenIds.has(id)) {
      throw new Error(`duplicate session observation id in state rewrite: ${id}`);
    }

    const existing = currentById.get(id);
    if (normalized.id && !existing) {
      throw new Error(`unknown session observation id in state rewrite: ${normalized.id}`);
    }

    seenIds.add(id);
    const next = {
      ...normalized,
      id,
      updatedMemory: existing?.updatedMemory ?? normalized.updatedMemory ?? null,
    };
    nextSessionObservations.push(next);

    if (!existing) {
      changes.push({
        type: 'add',
        text: next.text,
        context: next.context ?? null,
        references: next.references,
        reason: 'state rewrite added session observation',
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
        reason: 'state rewrite updated session observation',
      });
    }
  }

  for (const id of currentById.keys()) {
    if (!seenIds.has(id)) {
      changes.push({
        type: 'delete',
        extractionId: id,
        reason: 'state rewrite omitted session observation',
      });
    }
  }

  return {
    extractionChanges: changes,
    extractions: nextSessionObservations,
  };
}

export async function applySessionObservationTableChanges(
  client: NativeTables,
  snapshot: SnapshotContent,
  _snapshotId: string,
  signal?: AbortSignal,
): Promise<QueuedSessionObservationChange[]> {
  throwIfAborted(signal);
  const changes = snapshot.extractionChanges ?? [];
  if (changes.length === 0) {
    return [];
  }
  const cwd = snapshot.cwd?.trim();
  if (!cwd) {
    throw new Error('snapshot cwd is required to write session observations');
  }

  const sourceIds = new Set<string>();
  const deletedIds = new Set<string>();
  const upsertIds = new Set<string>();
  for (const change of changes) {
    if (change.type === 'add') {
      upsertIds.add(addedSessionObservationId(change));
      continue;
    }
    if (change.type === 'merge') {
      for (const extractionId of change.extractionIds) {
        sourceIds.add(extractionId);
        deletedIds.add(extractionId);
      }
      upsertIds.add(mergedSessionObservationId(change));
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
    ? await client.sessionObservationTable.get({ ids: [...sourceIds] })
    : [];
  const existingById = new Map(existingRows.map((row) => [row.id, row]));
  const queued: QueuedSessionObservationChange[] = [];

  if (deletedIds.size > 0) {
    await client.sessionObservationTable.delete({ ids: [...deletedIds] });
    for (const id of deletedIds) {
      const existing = existingById.get(id);
      if (existing) {
        queued.push({ type: 'delete', sessionObservation: existing });
      }
    }
  }

  if (upsertIds.size === 0) {
    return queued;
  }

  const storedUpserts = await client.sessionObservationTable.get({ ids: [...upsertIds] });
  const storedById = new Map(storedUpserts.map((row) => [row.id, row]));
  const observationsById = new Map(
    snapshot.extractions
      .filter((row): row is SessionObservation & { id: string } => Boolean(row.id))
      .map((row) => [row.id, row]),
  );
  const rows: StoredSessionObservation[] = [];

  for (const change of changes) {
    if (change.type === 'delete') {
      continue;
    }
    const id = change.type === 'add'
      ? addedSessionObservationId(change)
      : change.type === 'merge'
        ? mergedSessionObservationId(change)
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
    const title = sessionObservationTitle(observation);
    const summary = sessionObservationSummary(title, observation);
    rows.push({
      id,
      title,
      summary,
      content: sessionObservationContent(title, observation),
      cwd,
      vector: await embedText(summary, signal),
      turnRefs: references,
      globalObservationPaths: existing?.globalObservationPaths ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  if (rows.length > 0) {
    await client.sessionObservationTable.upsert({ rows });
    queued.push(...rows.map((row) => ({ type: 'upsert' as const, sessionObservation: row })));
  }
  return queued;
}

function referencesForChange(
  change: Extract<SessionObservationChange, { type: 'add' | 'merge' | 'update' }>,
  existingById: Map<string, StoredSessionObservation>,
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

function addedSessionObservationId(change: Extract<SessionObservationChange, { type: 'add' }>): string {
  return stableSessionObservationId({
    type: change.type,
    text: change.text,
    context: change.context ?? null,
    references: [...change.references].sort(),
  });
}

function mergedSessionObservationId(change: Extract<SessionObservationChange, { type: 'merge' }>): string {
  return stableSessionObservationId({
    type: change.type,
    extractionIds: [...change.extractionIds].sort(),
    text: change.text,
    context: change.context ?? null,
  });
}

function stableSessionObservationId(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 24);
}

function cloneSessionObservation(
  row: SessionObservation,
  options: { requireReferences: boolean } = { requireReferences: true },
): SessionObservation {
  const text = normalizeText(row.text);
  if (!text) {
    throw new Error('session observation text is required');
  }
  const references = normalizeIds(row.references);
  if (options.requireReferences && references.length === 0) {
    throw new Error('session observation references must include at least one reference');
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

function sessionObservationUnitKey(row: SessionObservation): string {
  return [
    normalizeText(row.title ?? ''),
    normalizeText(row.text),
    [...(row.references ?? [])].sort().join('\u0001'),
  ].join('\u0002');
}

function sessionObservationTitle(row: SessionObservation): string {
  return normalizeText(row.title ?? '') || normalizeText(row.text).slice(0, 80);
}

function sessionObservationSummary(title: string, row: SessionObservation): string {
  return [
    title,
    row.text,
  ].filter(Boolean).join('\n\n');
}

function sessionObservationContent(title: string, row: SessionObservation): string {
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
