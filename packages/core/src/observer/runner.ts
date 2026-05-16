import { randomUUID } from 'node:crypto';

import { getObserverRuntimeConfig } from '../config.js';
import { embedText } from '../llm/embedding-provider.js';
import { observeAnchor, type ObserverExtractionInput } from '../llm/observing.js';
import type { Extraction, NativeTables, Observation, ObservationContext } from '../native.js';
import type { ParsedObserverDocument, ParsedObserverSection } from './types.js';

type ObserveAnchorImpl = typeof observeAnchor;

type ExistingTree = {
  rows: ObservationContext[];
  rootRows: ObservationContext[];
  byId: Map<string, ObservationContext>;
};

type NextNode = {
  id: string;
  observingPath: string;
  parentId: string | null;
  position: number;
  content: string;
  refs: string[];
  children: NextNode[];
};

export type ObserverRunResult = {
  observed: number;
  skipped: number;
};

export async function runObserver(params: {
  client: NativeTables;
  observerName: string;
  anchorThreshold?: number;
  signal?: AbortSignal;
  observeAnchorImpl?: ObserveAnchorImpl;
}): Promise<ObserverRunResult> {
  throwIfAborted(params.signal);
  const anchorThreshold = params.anchorThreshold ?? getObserverRuntimeConfig().anchorThreshold;
  const extractions = await params.client.extractionTable.list({ limit: 10_000 });
  const allContexts = await params.client.observationContextTable.list({ observer: params.observerName });
  const groups = groupByEntityAnchor(extractions);
  let observed = 0;
  let skipped = 0;

  for (const group of groups) {
    throwIfAborted(params.signal);
    const pending = pendingExtractions(group.anchor, group.extractions);
    if (pending.length < anchorThreshold) {
      skipped += 1;
      continue;
    }

    const tree = contextsForAnchor(allContexts, group.anchor);
    const currentObservationRefs = await loadObservationRefs(params.client, group.extractions);
    const result = await (params.observeAnchorImpl ?? observeAnchor)({
      entityAnchor: group.anchor,
      content: renderTree(group.anchor, tree.rootRows, currentObservationRefs),
      extractions: pending.slice(0, anchorThreshold),
      signal: params.signal,
    });
    await applyDocument({
      client: params.client,
      observerName: params.observerName,
      anchor: group.anchor,
      tree,
      result,
      extractions: group.extractions,
      signal: params.signal,
    });
    observed += 1;
  }

  return { observed, skipped };
}

export async function hasPendingObserverWork(params: {
  client: NativeTables;
  anchorThreshold?: number;
  signal?: AbortSignal;
}): Promise<boolean> {
  throwIfAborted(params.signal);
  const anchorThreshold = params.anchorThreshold ?? getObserverRuntimeConfig().anchorThreshold;
  const extractions = await params.client.extractionTable.list({ limit: 10_000 });
  return groupByEntityAnchor(extractions)
    .some((group) => pendingExtractions(group.anchor, group.extractions).length >= anchorThreshold);
}

function pendingExtractions(anchor: string, extractions: Extraction[]): ObserverExtractionInput[] {
  const root = normalizeAnchor(anchor);
  return extractions
    .filter((extraction) => !extraction.observedRootAnchors.map(normalizeAnchor).includes(root))
    .map(toObserverExtractionInput);
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

function toObserverExtractionInput(extraction: Extraction): ObserverExtractionInput {
  return {
    id: extraction.id,
    text: extraction.text,
    context: extraction.context ?? null,
    anchors: extraction.anchors,
    turnRefs: extraction.turnRefs,
  };
}

function contextsForAnchor(rows: ObservationContext[], anchor: string): ExistingTree {
  const prefix = `${anchor} / `;
  const rootRows = rows
    .filter((row) => row.observingPath === anchor || row.observingPath.startsWith(prefix))
    .sort((left, right) => left.observingPath.localeCompare(right.observingPath));
  return {
    rows: rootRows,
    rootRows: rootRows.sort(byPosition),
    byId: new Map(rootRows.map((row) => [row.id, row])),
  };
}

async function applyDocument(params: {
  client: NativeTables;
  observerName: string;
  anchor: string;
  tree: ExistingTree;
  result: ParsedObserverDocument;
  extractions: Extraction[];
  signal?: AbortSignal;
}): Promise<void> {
  const now = new Date().toISOString();
  const next = flattenNodes(buildNodes({
    sections: params.result.sections,
    parentId: null,
    parentPath: params.anchor,
    existing: params.tree.byId,
    now,
    observerName: params.observerName,
  }));
  const nextIds = new Set(next.map((node) => node.id));
  const deleteIds = params.tree.rows
    .filter((row) => !nextIds.has(row.id))
    .map((row) => row.id);

  const rows: ObservationContext[] = next.map((node) => ({
    id: node.id,
    observingPath: node.observingPath,
    parentId: node.parentId,
    position: node.position,
    content: node.content,
    createdAt: params.tree.byId.get(node.id)?.createdAt ?? now,
    updatedAt: now,
    observer: params.observerName,
  }));
  await params.client.observationContextTable.upsert({ rows });
  if (deleteIds.length > 0) {
    await params.client.observationContextTable.delete({ ids: deleteIds });
    await params.client.observationTable.delete({ ids: deleteIds });
  }

  const observationRows = await buildObservationRows(next, params.tree.byId, now, params.signal);
  if (observationRows.length > 0) {
    await params.client.observationTable.upsert({ rows: observationRows });
  }
  await updateExtractionLinks(params.client, params.anchor, params.extractions, next, now);
}

function buildNodes(params: {
  sections: ParsedObserverSection[];
  parentId: string | null;
  parentPath: string;
  existing: Map<string, ObservationContext>;
  now: string;
  observerName: string;
}): NextNode[] {
  return params.sections
    .filter((section) => !section.delete)
    .map((section, index) => {
      const id = section.id ?? randomUUID();
      const observingPath = `${params.parentPath} / ${section.heading}`;
      const children = buildNodes({
        ...params,
        sections: section.children,
        parentId: id,
        parentPath: observingPath,
      });
      return {
        id,
        observingPath,
        parentId: params.parentId,
        position: index,
        content: section.body,
        refs: section.refs,
        children,
      };
    });
}

async function buildObservationRows(
  nodes: NextNode[],
  existing: Map<string, ObservationContext>,
  now: string,
  signal?: AbortSignal,
): Promise<Observation[]> {
  const rows: Observation[] = [];
  for (const node of flattenNodes(nodes)) {
    if (!node.content.trim()) {
      continue;
    }
    const extractionRefs = collectRefs(node);
    if (extractionRefs.length === 0) {
      continue;
    }
    const text = `${node.observingPath}\n\n${node.content.trim()}`;
    rows.push({
      id: node.id,
      observingPath: node.observingPath,
      text,
      vector: await embedText(text, signal),
      extractionRefs,
      createdAt: existing.get(node.id)?.createdAt ?? now,
      updatedAt: now,
    });
  }
  return rows;
}

async function updateExtractionLinks(
  client: NativeTables,
  anchor: string,
  extractions: Extraction[],
  nodes: NextNode[],
  now: string,
): Promise<void> {
  const root = normalizeAnchor(anchor);
  const leafByRef = new Map<string, string[]>();
  for (const node of flattenNodes(nodes)) {
    if (node.children.length > 0) {
      continue;
    }
    for (const ref of node.refs) {
      const ids = leafByRef.get(ref) ?? [];
      ids.push(node.id);
      leafByRef.set(ref, ids);
    }
  }
  const rows = extractions
    .filter((extraction) => leafByRef.has(extraction.id) || extraction.observedRootAnchors.map(normalizeAnchor).includes(root))
    .map((extraction) => ({
      ...extraction,
      observationIds: unique([
        ...extraction.observationIds.filter((id) => !flattenNodes(nodes).some((node) => node.id === id)),
        ...(leafByRef.get(extraction.id) ?? []),
      ]),
      observedRootAnchors: unique([...extraction.observedRootAnchors, anchor]),
      updatedAt: now,
    }));
  if (rows.length > 0) {
    await client.extractionTable.upsert({ rows });
  }
}

async function loadObservationRefs(
  client: NativeTables,
  extractions: Extraction[],
): Promise<Map<string, string[]>> {
  const ids = unique(extractions.flatMap((extraction) => extraction.observationIds));
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await client.observationTable.loadByIds({ ids });
  return new Map(rows.map((row) => [row.id, row.extractionRefs]));
}

function renderTree(anchor: string, roots: ObservationContext[], refsById: Map<string, string[]>): string {
  if (roots.length === 0) {
    return `# ${anchor}`;
  }
  const byParent = new Map<string | null, ObservationContext[]>();
  for (const row of roots) {
    const rows = byParent.get(row.parentId ?? null) ?? [];
    rows.push(row);
    byParent.set(row.parentId ?? null, rows);
  }
  for (const rows of byParent.values()) {
    rows.sort(byPosition);
  }
  return [`# ${anchor}`, ...renderContextRows(byParent, null, refsById)].join('\n\n');
}

function renderContextRows(
  byParent: Map<string | null, ObservationContext[]>,
  parentId: string | null,
  refsById: Map<string, string[]>,
): string[] {
  return (byParent.get(parentId) ?? []).flatMap((row) => [
    renderContextRow(row, byParent.has(row.id), refsById.get(row.id) ?? []),
    ...renderContextRows(byParent, row.id, refsById),
  ]);
}

function renderContextRow(row: ObservationContext, hasChildren: boolean, refs: string[]): string {
  const level = row.parentId ? '###' : '##';
  const refsHint = !hasChildren && refs.length > 0 ? `; refs: [${refs.join(', ')}]` : '';
  return `${level} ${lastPathSegment(row.observingPath)} <!-- id: ${row.id}${refsHint} -->\n\n${row.content}`.trim();
}

function byPosition(left: ObservationContext, right: ObservationContext): number {
  return left.position - right.position || left.observingPath.localeCompare(right.observingPath);
}

function collectRefs(node: NextNode): string[] {
  return unique([...(node.refs ?? []), ...node.children.flatMap(collectRefs)]);
}

function flattenNodes(nodes: NextNode[]): NextNode[] {
  return nodes.flatMap((node) => [node, ...flattenNodes(node.children)]);
}

function normalizeAnchor(anchor: string): string {
  return anchor.trim().toLowerCase().replace(/\s+/g, ' ');
}

function lastPathSegment(path: string): string {
  return path.split('/').map((part) => part.trim()).filter(Boolean).at(-1) ?? path;
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
  groupByEntityAnchor,
  pendingExtractions,
  runObserver,
};
