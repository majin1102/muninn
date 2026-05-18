import { randomUUID } from 'node:crypto';

import { getObserverRuntimeConfig } from '../config.js';
import { embedText } from '../llm/embedding-provider.js';
import { observeAnchor, type ObserverExtractionInput } from '../llm/observing.js';
import type { Extraction, NativeTables, Observation, ObservationContext } from '../native.js';
import type { QueuedExtractionChange } from '../checkpoint.js';
import type { ParsedObserverDocument, ParsedObserverSection } from './types.js';

type ObserveAnchorImpl = typeof observeAnchor;

type ExistingTree = {
  rows: ObservationContext[];
  rootRows: ObservationContext[];
  byId: Map<string, ObservationContext>;
  byParent: Map<string | null, ObservationContext[]>;
};

type NextNode = {
  id: string;
  heading: string;
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
  baselineVersion: number;
};

export type ObserverWorkStatus = {
  changed: boolean;
  pending: boolean;
  groupCount: number;
  baselineVersion: number;
};

export async function runObserver(params: {
  client: NativeTables;
  observerName: string;
  anchor?: string;
  extractionChanges?: QueuedExtractionChange[];
  baselineVersion?: number;
  anchorThreshold?: number;
  finalize?: boolean;
  database?: string;
  signal?: AbortSignal;
  observeAnchorImpl?: ObserveAnchorImpl;
}): Promise<ObserverRunResult> {
  throwIfAborted(params.signal);
  const anchorThreshold = params.anchorThreshold ?? getObserverRuntimeConfig().anchorThreshold;
  if (params.anchor && params.extractionChanges) {
    return runQueuedObserver({
      client: params.client,
      observerName: params.observerName,
      anchor: params.anchor,
      extractionChanges: params.extractionChanges,
      signal: params.signal,
      database: params.database,
      observeAnchorImpl: params.observeAnchorImpl,
    });
  }
  const baselineInput = params.baselineVersion ?? 0;
  const { extractions, baselineVersion } = await loadChangedExtractions(params.client, baselineInput);
  const allContexts = await params.client.observationContextTable.list({ observer: params.observerName });
  const groups = groupByEntityAnchor(extractions);
  let observed = 0;
  let skipped = 0;

  if (groups.length === 0) {
    return {
      observed,
      skipped,
      baselineVersion,
    };
  }
  const shouldObserveAny = params.finalize
    ? groups.length > 0
    : groups.some((group) => group.extractions.length >= anchorThreshold);
  if (!shouldObserveAny) {
    return {
      observed,
      skipped: groups.length,
      baselineVersion: baselineInput,
    };
  }

  for (const group of groups) {
    throwIfAborted(params.signal);
    const tree = contextsForAnchor(allContexts, group.anchor);
    const currentObservationRefs = stripChangedExtractionRefs(
      await loadObservationRefs(params.client, tree.rows, group.extractions),
      group.extractions,
    );
    const rewriteScope = buildRewriteScope(tree, group.extractions);
    const extractions = group.extractions.map(toObserverExtractionInput);
    const result = await (params.observeAnchorImpl ?? observeAnchor)({
      entityAnchor: group.anchor,
      outline: renderOutline(group.anchor, tree.rootRows),
      rewriteContent: renderRewriteContent(group.anchor, rewriteScope.rows, currentObservationRefs),
      extractions,
      validRefs: [...currentObservationRefs.values()].flat(),
      getObservation: createGetObservationTool(group.anchor, tree, currentObservationRefs),
      signal: params.signal,
      database: params.database,
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

  return { observed, skipped, baselineVersion };
}

async function runQueuedObserver(params: {
  client: NativeTables;
  observerName: string;
  anchor: string;
  extractionChanges: QueuedExtractionChange[];
  signal?: AbortSignal;
  database?: string;
  observeAnchorImpl?: ObserveAnchorImpl;
}): Promise<ObserverRunResult> {
  const changedExtractions = params.extractionChanges.map((change) => change.extraction);
  const upsertExtractions = params.extractionChanges
    .filter((change) => change.type === 'upsert')
    .map((change) => change.extraction);
  const allContexts = await params.client.observationContextTable.list({ observer: params.observerName });
  const tree = contextsForAnchor(allContexts, params.anchor);
  const currentObservationRefs = stripChangedExtractionRefs(
    await loadObservationRefs(params.client, tree.rows, changedExtractions),
    changedExtractions,
  );
  const rewriteScope = buildRewriteScope(tree, changedExtractions);
  const result = await (params.observeAnchorImpl ?? observeAnchor)({
    entityAnchor: params.anchor,
    outline: renderOutline(params.anchor, tree.rootRows),
    rewriteContent: renderRewriteContent(params.anchor, rewriteScope.rows, currentObservationRefs),
    extractions: upsertExtractions.map(toObserverExtractionInput),
    validRefs: [...currentObservationRefs.values()].flat(),
    getObservation: createGetObservationTool(params.anchor, tree, currentObservationRefs),
    signal: params.signal,
    database: params.database,
  });
  await applyDocument({
    client: params.client,
    observerName: params.observerName,
    anchor: params.anchor,
    tree,
    result,
    extractions: changedExtractions,
    signal: params.signal,
  });
  return { observed: 1, skipped: 0, baselineVersion: 0 };
}

export async function hasPendingObserverWork(params: {
  client: NativeTables;
  baselineVersion: number;
  anchorThreshold?: number;
  finalize?: boolean;
  signal?: AbortSignal;
}): Promise<boolean> {
  return (await getObserverWorkStatus(params)).pending;
}

export async function getObserverWorkStatus(params: {
  client: NativeTables;
  baselineVersion: number;
  anchorThreshold?: number;
  finalize?: boolean;
  signal?: AbortSignal;
}): Promise<ObserverWorkStatus> {
  throwIfAborted(params.signal);
  const anchorThreshold = params.anchorThreshold ?? getObserverRuntimeConfig().anchorThreshold;
  const { extractions, baselineVersion } = await loadChangedExtractions(params.client, params.baselineVersion);
  const groups = groupByEntityAnchor(extractions);
  const pending = params.finalize
    ? groups.length > 0
    : groups.some((group) => group.extractions.length >= anchorThreshold);
  return {
    changed: baselineVersion !== params.baselineVersion,
    pending,
    groupCount: groups.length,
    baselineVersion,
  };
}

async function loadChangedExtractions(
  client: NativeTables,
  baselineVersion: number,
): Promise<{ extractions: Extraction[]; baselineVersion: number }> {
  const stats = await client.extractionTable.stats();
  const nextBaselineVersion = stats?.version ?? baselineVersion;
  if (nextBaselineVersion <= baselineVersion) {
    return {
      extractions: [],
      baselineVersion,
    };
  }
  const extractions = await client.extractionTable.delta({ baselineVersion });
  return {
    extractions,
    baselineVersion: nextBaselineVersion,
  };
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
    status: extraction.observationIds.length > 0 ? 'changed' : 'new',
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
    byParent: groupByParent(rootRows),
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
  validateExistingIds(params.result.sections, params.tree.byId);
  validateRootSections(params.result.sections);
  const next = flattenNodes(buildNodes({
    sections: params.result.sections,
    parentId: null,
    parentPath: params.anchor,
    existing: params.tree.byId,
    now,
    observerName: params.observerName,
  }));
  const explicitDeletes = deletedIds(params.result.sections, params.tree);
  const deletedContextIds = [...explicitDeletes];
  const deletedObservationIds = unique([
    ...deletedContextIds,
    ...next
      .filter((node) => node.children.length > 0)
      .map((node) => node.id),
  ]);

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
  if (deletedContextIds.length > 0) {
    await params.client.observationContextTable.delete({ ids: deletedContextIds });
  }
  if (deletedObservationIds.length > 0) {
    await params.client.observationTable.delete({ ids: deletedObservationIds });
  }

  const observationRows = await buildObservationRows(next, params.tree.byId, now, params.signal);
  if (observationRows.length > 0) {
    await params.client.observationTable.upsert({ rows: observationRows });
  }
  await updateExtractionLinks(params.client, params.extractions, params.tree, next, now);
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
      const existing = section.id ? params.existing.get(section.id) : undefined;
      const parentId = params.parentId ?? (section.level === 3 ? existing?.parentId ?? null : null);
      const parentPath = params.parentId || !existing?.parentId
        ? params.parentPath
        : parentPathForExisting(params.existing, existing);
      const observingPath = `${parentPath} / ${section.heading}`;
      const children = buildNodes({
        ...params,
        sections: section.children,
        parentId: id,
        parentPath: observingPath,
      });
      return {
        id,
        heading: section.heading,
        observingPath,
        parentId,
        position: params.parentId === null && section.level === 3 && existing ? existing.position : index,
        content: section.body,
        refs: section.refs,
        children,
      };
    });
}

function parentPathForExisting(existing: Map<string, ObservationContext>, row: ObservationContext): string {
  const parent = row.parentId ? existing.get(row.parentId) : undefined;
  if (parent) {
    return parent.observingPath;
  }
  return row.observingPath.split('/').map((part) => part.trim()).filter(Boolean).slice(0, -1).join(' / ');
}

async function buildObservationRows(
  nodes: NextNode[],
  existing: Map<string, ObservationContext>,
  now: string,
  signal?: AbortSignal,
): Promise<Observation[]> {
  const rows: Observation[] = [];
  for (const node of nodes) {
    if (node.children.length > 0) {
      continue;
    }
    if (!node.content.trim()) {
      continue;
    }
    const extractionRefs = unique(node.refs ?? []);
    if (extractionRefs.length === 0) {
      continue;
    }
    const text = leafObservationText(node);
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

function leafObservationText(node: NextNode): string {
  return `${node.observingPath}\n\n${node.content.trim()}`.trim();
}

async function updateExtractionLinks(
  client: NativeTables,
  extractions: Extraction[],
  tree: ExistingTree,
  nodes: NextNode[],
  now: string,
): Promise<void> {
  const leafByRef = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.children.length > 0) {
      continue;
    }
    for (const ref of node.refs) {
      const ids = leafByRef.get(ref) ?? [];
      ids.push(node.id);
      leafByRef.set(ref, ids);
    }
  }
  const contextIds = new Set(tree.rows.map((row) => row.id));
  const rows = extractions
    .filter((extraction) => leafByRef.has(extraction.id) || extraction.observationIds.some((id) => contextIds.has(id)))
    .map((extraction) => {
      const observationIds = unique([
        ...extraction.observationIds.filter((id) => !contextIds.has(id)),
        ...(leafByRef.get(extraction.id) ?? []),
      ]);
      if (sameStringSet(extraction.observationIds, observationIds)) {
        return null;
      }
      return {
        ...extraction,
        observationIds,
        updatedAt: now,
      };
    })
    .filter((row): row is Extraction => Boolean(row));
  if (rows.length > 0) {
    await client.extractionTable.upsert({ rows });
  }
}

async function loadObservationRefs(
  client: NativeTables,
  contexts: ObservationContext[],
  extractions: Extraction[],
): Promise<Map<string, string[]>> {
  const ids = unique([
    ...contexts.map((context) => context.id),
    ...extractions.flatMap((extraction) => extraction.observationIds),
  ]);
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await client.observationTable.get({ ids });
  return new Map(rows.map((row) => [row.id, row.extractionRefs]));
}

function stripChangedExtractionRefs(
  refsById: Map<string, string[]>,
  extractions: Extraction[],
): Map<string, string[]> {
  const changedRefs = new Set(extractions.flatMap(extractionRefVariants));
  return new Map([...refsById].map(([id, refs]) => [
    id,
    refs.filter((ref) => !changedRefs.has(ref)),
  ]));
}

function extractionRefVariants(extraction: Extraction): string[] {
  return extraction.id.startsWith('extraction:')
    ? [extraction.id, extraction.id.slice('extraction:'.length)]
    : [extraction.id, `extraction:${extraction.id}`];
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

function renderRewriteContent(anchor: string, rows: ObservationContext[], refsById: Map<string, string[]>): string {
  return rows.length === 0 ? '' : renderTree(anchor, rows, refsById);
}

function renderOutline(anchor: string, roots: ObservationContext[]): string {
  if (roots.length === 0) {
    return `# ${anchor}\n\n(empty)`;
  }
  const byParent = groupByParent(roots);
  return [`# ${anchor}`, ...renderOutlineRows(byParent, null, 0)].join('\n');
}

function renderOutlineRows(
  byParent: Map<string | null, ObservationContext[]>,
  parentId: string | null,
  depth: number,
): string[] {
  return (byParent.get(parentId) ?? []).flatMap((row) => {
    const hasChildren = byParent.has(row.id);
    const level = row.parentId ? '###' : '##';
    const indent = '  '.repeat(depth);
    return [
      `${indent}- ${level} ${lastPathSegment(row.observingPath)} <!-- id: ${row.id}; ${hasChildren ? 'non-leaf' : 'leaf'} -->`,
      ...renderOutlineRows(byParent, row.id, depth + 1),
    ];
  });
}

function buildRewriteScope(tree: ExistingTree, extractions: Extraction[]): { rows: ObservationContext[]; ids: Set<string> } {
  const ids = new Set<string>();
  for (const extraction of extractions) {
    for (const id of extraction.observationIds) {
      if (!tree.byId.has(id)) {
        continue;
      }
      addAncestors(ids, tree, id);
      addDescendants(ids, tree, id);
    }
  }
  return {
    rows: tree.rows.filter((row) => ids.has(row.id)).sort(byPosition),
    ids,
  };
}

function addAncestors(ids: Set<string>, tree: ExistingTree, id: string): void {
  let current = tree.byId.get(id);
  while (current) {
    ids.add(current.id);
    current = current.parentId ? tree.byId.get(current.parentId) : undefined;
  }
}

function addDescendants(ids: Set<string>, tree: ExistingTree, id: string): void {
  const stack = [...(tree.byParent.get(id) ?? [])];
  while (stack.length > 0) {
    const row = stack.pop()!;
    ids.add(row.id);
    stack.push(...(tree.byParent.get(row.id) ?? []));
  }
}

function createGetObservationTool(
  anchor: string,
  tree: ExistingTree,
  refsById: Map<string, string[]>,
): (id: string) => string {
  return (id) => {
    if (!tree.byId.has(id)) {
      throw new Error(`get_observation id is not visible in the outline: ${id}`);
    }
    return renderObservationSelection(anchor, tree, id, refsById);
  };
}

function renderObservationSelection(
  anchor: string,
  tree: ExistingTree,
  id: string,
  refsById: Map<string, string[]>,
): string {
  const selected = tree.byId.get(id);
  if (!selected) {
    throw new Error(`unknown observation id: ${id}`);
  }
  const ids = new Set<string>();
  addAncestors(ids, tree, id);
  addDescendants(ids, tree, id);
  return renderTree(anchor, tree.rows.filter((row) => ids.has(row.id)), refsById);
}

function groupByParent(rows: ObservationContext[]): Map<string | null, ObservationContext[]> {
  const byParent = new Map<string | null, ObservationContext[]>();
  for (const row of rows) {
    const siblings = byParent.get(row.parentId ?? null) ?? [];
    siblings.push(row);
    byParent.set(row.parentId ?? null, siblings);
  }
  for (const siblings of byParent.values()) {
    siblings.sort(byPosition);
  }
  return byParent;
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

function validateExistingIds(sections: ParsedObserverSection[], existing: Map<string, ObservationContext>): void {
  for (const section of walkSections(sections)) {
    if (section.id && !existing.has(section.id)) {
      throw new Error(`observer returned unknown observation id: ${section.id}`);
    }
  }
}

function validateRootSections(sections: ParsedObserverSection[]): void {
  for (const section of sections) {
    if (section.level === 3 && !section.id) {
      throw new Error('rootless observer leaf rewrites must preserve an existing id');
    }
  }
}

function deletedIds(sections: ParsedObserverSection[], tree: ExistingTree): string[] {
  const ids = new Set<string>();
  for (const section of walkSections(sections)) {
    if (!section.delete || !section.id) {
      continue;
    }
    ids.add(section.id);
    addDescendants(ids, tree, section.id);
  }
  return [...ids];
}

function walkSections(sections: ParsedObserverSection[]): ParsedObserverSection[] {
  return sections.flatMap((section) => [section, ...walkSections(section.children)]);
}

function byPosition(left: ObservationContext, right: ObservationContext): number {
  return left.position - right.position || left.observingPath.localeCompare(right.observingPath);
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

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
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
  getObserverWorkStatus,
  runObserver,
};
