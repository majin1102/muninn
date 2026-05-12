import { createHash } from 'node:crypto';

import { getCurationConfig } from '../config.js';
import { embedText } from '../llm/embedding-provider.js';
import { curate, type CurationExtractionInput } from '../llm/curating.js';
import type { CurationSnapshot, Extraction, NativeTables, Observation } from '../native.js';
import type { ParsedCurationDocument } from './types.js';

type CurateImpl = typeof curate;

export type CurationRunResult = {
  curated: number;
  skipped: number;
};

export async function runCuration(params: {
  client: NativeTables;
  observerName: string;
  anchorThreshold?: number;
  signal?: AbortSignal;
  curateImpl?: CurateImpl;
}): Promise<CurationRunResult> {
  throwIfAborted(params.signal);
  const anchorThreshold = params.anchorThreshold ?? getCurationConfig().anchorThreshold;
  const extractions = await params.client.extractionTable.list({ limit: 10_000 });
  const groups = groupByEntityAnchor(extractions);
  let curated = 0;
  let skipped = 0;

  for (const group of groups) {
    throwIfAborted(params.signal);
    const curationId = curationIdForAnchor(group.anchor);
    const latest = await params.client.curationTable.latest({ curationId });
    const covered = new Set(latest?.references ?? []);
    const pending = group.extractions
      .filter((extraction) => !covered.has(extractionMemoryId(extraction.id)))
      .map(toCurationExtractionInput);

    if (!latest && group.extractions.length < anchorThreshold) {
      skipped += 1;
      continue;
    }
    if (latest && pending.length === 0) {
      skipped += 1;
      continue;
    }

    const result = await (params.curateImpl ?? curate)({
      entityAnchor: group.anchor,
      content: latest?.content ?? '',
      extractions: group.extractions.map(toCurationExtractionInput),
      signal: params.signal,
    });
    const inserted = await insertCuration({
      client: params.client,
      observerName: params.observerName,
      curationId,
      anchor: group.anchor,
      latest,
      result,
      signal: params.signal,
    });
    await replaceObservations(params.client, inserted, result, params.signal);
    curated += 1;
  }

  return { curated, skipped };
}

function groupByEntityAnchor(extractions: Extraction[]): Array<{ anchor: string; extractions: Extraction[] }> {
  const groups = new Map<string, { anchor: string; extractions: Extraction[] }>();
  const order: string[] = [];
  for (const extraction of extractions) {
    for (const anchor of entityAnchors(extraction)) {
      const key = normalizeAnchor(anchor);
      let group = groups.get(key);
      if (!group) {
        group = { anchor, extractions: [] };
        groups.set(key, group);
        order.push(key);
      }
      group.extractions.push(extraction);
    }
  }
  return order.map((key) => groups.get(key)!);
}

function entityAnchors(extraction: Extraction): string[] {
  return extraction.anchors
    .map((anchor) => anchor.match(/^Entity:\s*(.+?)\s*$/i)?.[1]?.trim() ?? '')
    .filter(Boolean);
}

function toCurationExtractionInput(extraction: Extraction): CurationExtractionInput {
  return {
    id: extraction.id,
    text: extraction.text,
    context: extraction.context ?? null,
    anchors: extraction.anchors,
    references: extraction.references,
  };
}

async function insertCuration(params: {
  client: NativeTables;
  observerName: string;
  curationId: string;
  anchor: string;
  latest: CurationSnapshot | null;
  result: ParsedCurationDocument;
  signal?: AbortSignal;
}): Promise<CurationSnapshot> {
  throwIfAborted(params.signal);
  const now = new Date().toISOString();
  const references = unique(params.result.observations.flatMap((observation) => observation.references));
  const rows = await params.client.curationTable.insert({
    snapshots: [{
      snapshotId: 'curation:18446744073709551615',
      curationId: params.curationId,
      snapshotSequence: (params.latest?.snapshotSequence ?? -1) + 1,
      createdAt: params.latest?.createdAt ?? now,
      updatedAt: now,
      observer: params.observerName,
      anchor: params.anchor,
      title: params.result.title,
      summary: params.result.summary,
      content: params.result.content,
      references,
    }],
  });
  const inserted = rows[0];
  if (!inserted) {
    throw new Error('curation insert returned no snapshot');
  }
  return inserted;
}

async function replaceObservations(
  client: NativeTables,
  snapshot: CurationSnapshot,
  result: ParsedCurationDocument,
  signal?: AbortSignal,
): Promise<void> {
  const rows: Observation[] = [];
  for (const observation of result.observations) {
    throwIfAborted(signal);
    rows.push({
      id: observationId(snapshot.curationId, observation.text, observation.references),
      curationId: snapshot.curationId,
      snapshotId: snapshot.snapshotId,
      text: observation.text,
      vector: await embedText(observation.text, signal),
      references: observation.references,
      createdAt: snapshot.updatedAt,
    });
  }
  await client.observationTable.replaceForCuration({
    curationId: snapshot.curationId,
    rows,
  });
}

function curationIdForAnchor(anchor: string): string {
  return `entity:${normalizeAnchor(anchor)}`;
}

function normalizeAnchor(anchor: string): string {
  return anchor.trim().toLowerCase().replace(/\s+/g, ' ');
}

function extractionMemoryId(id: string): string {
  return id.startsWith('extraction:') ? id : `extraction:${id}`;
}

function observationId(curationId: string, text: string, refs: string[]): string {
  return createHash('sha256')
    .update(curationId)
    .update('\0')
    .update(text)
    .update('\0')
    .update([...refs].sort().join('\0'))
    .digest('hex')
    .slice(0, 24);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
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

export const __testing = {
  curationIdForAnchor,
  groupByEntityAnchor,
  runCuration,
};
