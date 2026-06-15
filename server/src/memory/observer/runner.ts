import { getObserverRuntimeConfig } from '../config.js';
import { embedText } from '../llm/embedding-provider.js';
import { observeCwdScope, type ObserverExtractionInput } from '../llm/observing.js';
import type { Extraction, NativeTables, Observation, ObservationContext } from '../native.js';
import type { QueuedExtractionChange } from '../checkpoint.js';
import type { ParsedObserverDocument, ParsedObserverSection } from './types.js';

type ObserveCwdScopeImpl = typeof observeCwdScope;

type ExistingTree = {
  rows: ObservationContext[];
  rootRows: ObservationContext[];
  byPath: Map<string, ObservationContext>;
  byParent: Map<string | null, ObservationContext[]>;
};

type NextNode = {
  id: string;
  heading: string;
  path: string;
  parentId: string | null;
  position: number;
  content: string;
  sourceRefs: string[];
  expandRefs: string[];
  rewritten: boolean;
  children: NextNode[];
};

type RefHints = {
  sourceRefs: string[];
  expandRefs: string[];
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
  cwd?: string;
  extractionChanges?: QueuedExtractionChange[];
  baselineVersion?: number;
  cwdThreshold?: number;
  finalize?: boolean;
  database?: string;
  signal?: AbortSignal;
  observeCwdScopeImpl?: ObserveCwdScopeImpl;
}): Promise<ObserverRunResult> {
  throwIfAborted(params.signal);
  const cwdThreshold = params.cwdThreshold ?? getObserverRuntimeConfig().cwdThreshold;
  if (params.cwd && params.extractionChanges) {
    return runQueuedObserver({
      client: params.client,
      observerName: params.observerName,
      cwd: params.cwd,
      extractionChanges: params.extractionChanges,
      signal: params.signal,
      database: params.database,
      observeCwdScopeImpl: params.observeCwdScopeImpl,
    });
  }
  const baselineInput = params.baselineVersion ?? 0;
  const { extractions, baselineVersion } = await loadChangedExtractions(params.client, baselineInput);
  const allContexts = await params.client.observationContextTable.list({ observer: params.observerName });
  const groups = groupByCwd(extractions);
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
    : groups.some((group) => group.extractions.length >= cwdThreshold);
  if (!shouldObserveAny) {
    return {
      observed,
      skipped: groups.length,
      baselineVersion: baselineInput,
    };
  }

  for (const group of groups) {
    throwIfAborted(params.signal);
    const tree = contextsForCwd(allContexts, group.cwd);
    const currentObservationRefs = stripChangedExtractionRefs(refHintsById(tree.rows), group.extractions);
    const rewriteScope = buildRewriteScope(tree, group.extractions);
    const extractions = group.extractions.map(toObserverExtractionInput);
    const result = await (params.observeCwdScopeImpl ?? observeCwdScope)({
      cwdScope: group.cwd,
      outline: renderOutline(group.cwd, tree.rootRows),
      observedDocument: renderObservedDocument(group.cwd, tree.rows, rewriteScope.paths, currentObservationRefs),
      extractions,
      validRefs: [...currentObservationRefs.values()].flatMap(allRefs),
      getObservation: createGetObservationTool(group.cwd, tree, currentObservationRefs),
      signal: params.signal,
      database: params.database,
    });
    await applyDocument({
      client: params.client,
      observerName: params.observerName,
      cwd: group.cwd,
      tree,
      result,
      linkExtractions: group.extractions,
      signal: params.signal,
    });
    observed += 1;
  }

  return { observed, skipped, baselineVersion };
}

async function runQueuedObserver(params: {
  client: NativeTables;
  observerName: string;
  cwd: string;
  extractionChanges: QueuedExtractionChange[];
  signal?: AbortSignal;
  database?: string;
  observeCwdScopeImpl?: ObserveCwdScopeImpl;
}): Promise<ObserverRunResult> {
  const changedExtractions = params.extractionChanges.map((change) => change.extraction);
  const upsertExtractions = params.extractionChanges
    .filter((change) => change.type === 'upsert')
    .map((change) => change.extraction);
  const allContexts = await params.client.observationContextTable.list({ observer: params.observerName });
  const tree = contextsForCwd(allContexts, params.cwd);
  const currentObservationRefs = stripChangedExtractionRefs(refHintsById(tree.rows), changedExtractions);
  const rewriteScope = buildRewriteScope(tree, changedExtractions);
  const result = await (params.observeCwdScopeImpl ?? observeCwdScope)({
    cwdScope: params.cwd,
    outline: renderOutline(params.cwd, tree.rootRows),
    observedDocument: renderObservedDocument(params.cwd, tree.rows, rewriteScope.paths, currentObservationRefs),
    extractions: upsertExtractions.map(toObserverExtractionInput),
    validRefs: [...currentObservationRefs.values()].flatMap(allRefs),
    getObservation: createGetObservationTool(params.cwd, tree, currentObservationRefs),
    signal: params.signal,
    database: params.database,
  });
  await applyDocument({
    client: params.client,
    observerName: params.observerName,
    cwd: params.cwd,
    tree,
    result,
    linkExtractions: upsertExtractions,
    signal: params.signal,
  });
  return { observed: 1, skipped: 0, baselineVersion: 0 };
}

export async function hasPendingObserverWork(params: {
  client: NativeTables;
  baselineVersion: number;
  cwdThreshold?: number;
  finalize?: boolean;
  signal?: AbortSignal;
}): Promise<boolean> {
  return (await getObserverWorkStatus(params)).pending;
}

export async function getObserverWorkStatus(params: {
  client: NativeTables;
  baselineVersion: number;
  cwdThreshold?: number;
  finalize?: boolean;
  signal?: AbortSignal;
}): Promise<ObserverWorkStatus> {
  throwIfAborted(params.signal);
  const cwdThreshold = params.cwdThreshold ?? getObserverRuntimeConfig().cwdThreshold;
  const { extractions, baselineVersion } = await loadChangedExtractions(params.client, params.baselineVersion);
  const groups = groupByCwd(extractions);
  const pending = params.finalize
    ? groups.length > 0
    : groups.some((group) => group.extractions.length >= cwdThreshold);
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

function groupByCwd(extractions: Extraction[]): Array<{ cwd: string; extractions: Extraction[] }> {
  const groups = new Map<string, { cwd: string; extractions: Extraction[] }>();
  const order: string[] = [];
  for (const extraction of extractions) {
    const cwd = normalizeCwd(extraction.cwd);
    if (!cwd) {
      continue;
    }
    let group = groups.get(cwd);
    if (!group) {
      group = { cwd, extractions: [] };
      groups.set(cwd, group);
      order.push(cwd);
    }
    group.extractions.push(extraction);
  }
  return order.map((key) => groups.get(key)!);
}

function normalizeCwd(cwd: string): string {
  return cwd.trim().replace(/\/+$/, '') || cwd.trim();
}

function toObserverExtractionInput(extraction: Extraction): ObserverExtractionInput {
  return {
    id: extraction.id,
    status: extraction.observationPaths.length > 0 ? 'changed' : 'new',
    text: extraction.summary,
    context: extraction.content,
    cwd: extraction.cwd,
    turnRefs: extraction.turnRefs,
  };
}

function contextsForCwd(rows: ObservationContext[], cwdScope: string): ExistingTree {
  const prefix = `${cwdScope} / `;
  const rootRows = rows
    .filter((row) => row.path === cwdScope || row.path.startsWith(prefix))
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    rows: rootRows,
    rootRows: rootRows.sort(byPosition),
    byPath: new Map(rootRows.map((row) => [row.path, row])),
    byParent: groupByParent(rootRows),
  };
}

async function applyDocument(params: {
  client: NativeTables;
  observerName: string;
  cwd: string;
  tree: ExistingTree;
  result: ParsedObserverDocument;
  linkExtractions: Extraction[];
  signal?: AbortSignal;
}): Promise<void> {
  const now = new Date().toISOString();
  validateHeadingOnlySections(params.result.sections, params.tree.byPath);
  const next = flattenNodes(buildNodes({
    sections: params.result.sections,
    parentId: null,
    parentPath: params.cwd,
    existing: params.tree.byPath,
    now,
    observerName: params.observerName,
  }));
  const nodesToWrite = next.filter((node) => shouldUpsertNode(node, params.tree.byPath));
  const returnedPaths = new Set(next.map((node) => node.path));
  const writablePaths = writableScopePaths(params.tree.rows, params.result.sections);
  const deletedContextIds = deletedPaths(writablePaths, returnedPaths);
  const deletedObservationIds = unique([
    ...deletedContextIds,
    ...next
      .filter((node) => node.children.length > 0)
      .map((node) => node.id),
  ]);

  const rows: ObservationContext[] = nodesToWrite.map((node) => ({
    id: node.id,
    path: node.path,
    parentId: node.parentId,
    position: node.position,
    content: node.content,
    sourceRefs: node.sourceRefs,
    expandRefs: node.expandRefs,
    createdAt: params.tree.byPath.get(node.path)?.createdAt ?? now,
    updatedAt: now,
    observer: params.observerName,
  }));
  if (rows.length > 0) {
    await params.client.observationContextTable.upsert({ rows });
  }
  if (deletedContextIds.length > 0) {
    await params.client.observationContextTable.delete({ ids: deletedContextIds });
  }
  if (deletedObservationIds.length > 0) {
    await params.client.observationTable.delete({ ids: deletedObservationIds });
  }

  const observationRows = await buildObservationRows(nodesToWrite, params.tree.byPath, now, params.signal);
  if (observationRows.length > 0) {
    await params.client.observationTable.upsert({ rows: observationRows });
  }
  await updateExtractionLinks(params.client, {
    extractions: params.linkExtractions,
    existingRows: params.tree.rows,
    writablePaths,
    nodes: next,
    now,
  });
}

function writableScopePaths(
  treeRows: ObservationContext[],
  returnedSections: ParsedObserverSection[],
): Set<string> {
  const scopeRoots = rewrittenScopeRoots(returnedSections).map((section) => section.path);
  const protectedRoots = protectedKeepRoots(returnedSections).map((section) => section.path);
  const paths = new Set<string>();
  for (const row of treeRows) {
    const inScope = scopeRoots.some((root) => pathInSubtree(row.path, root));
    const protectedByKeepMarker = protectedRoots.some((root) => pathInSubtree(row.path, root));
    if (inScope && !protectedByKeepMarker) {
      paths.add(row.path);
    }
  }
  return paths;
}

function deletedPaths(writablePaths: Set<string>, returnedPaths: Set<string>): string[] {
  return [...writablePaths].filter((path) => !returnedPaths.has(path));
}

function validateHeadingOnlySections(
  sections: ParsedObserverSection[],
  existing: Map<string, ObservationContext>,
): void {
  for (const section of walkSections(sections)) {
    if (sectionIsRewritten(section)) {
      continue;
    }
    if (existing.has(section.path) || hasRewrittenDescendant(section)) {
      continue;
    }
    throw new Error(`heading-only observer section does not exist: ${section.path}`);
  }
}

function rewrittenScopeRoots(sections: ParsedObserverSection[]): ParsedObserverSection[] {
  const roots: ParsedObserverSection[] = [];
  const visit = (section: ParsedObserverSection, ancestorRewritten: boolean): void => {
    const rewritten = sectionIsRewritten(section);
    if (rewritten && !ancestorRewritten) {
      roots.push(section);
    }
    for (const child of section.children) {
      visit(child, ancestorRewritten || rewritten);
    }
  };
  for (const section of sections) {
    visit(section, false);
  }
  return roots;
}

function protectedKeepRoots(sections: ParsedObserverSection[]): ParsedObserverSection[] {
  return walkSections(sections).filter((section) => !sectionIsRewritten(section) && !hasRewrittenDescendant(section));
}

function sectionIsRewritten(section: ParsedObserverSection): boolean {
  return section.rewritten ?? Boolean(section.body.trim() || section.sourceRefs.length > 0);
}

function hasRewrittenDescendant(section: ParsedObserverSection): boolean {
  return section.children.some((child) => sectionIsRewritten(child) || hasRewrittenDescendant(child));
}

function walkSections(sections: ParsedObserverSection[]): ParsedObserverSection[] {
  return sections.flatMap((section) => [section, ...walkSections(section.children)]);
}

function pathInSubtree(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root} / `);
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
    .map((section, index) => {
      const path = section.path;
      const id = path;
      const existing = params.existing.get(path);
      const parentId = params.parentId;
      const children = buildNodes({
        ...params,
        sections: section.children,
        parentId: id,
        parentPath: path,
      });
      return {
        id,
        heading: section.heading,
        path,
        parentId,
        position: existing?.position ?? index,
        content: section.body,
        sourceRefs: section.sourceRefs,
        expandRefs: section.expandRefs,
        rewritten: sectionIsRewritten(section),
        children,
      };
    });
}

function shouldUpsertNode(node: NextNode, existing: Map<string, ObservationContext>): boolean {
  const existingNode = existing.get(node.path);
  return node.rewritten
    || (!existingNode && hasRewrittenDescendantNode(node))
    || Boolean(existingNode && node.children.length > 0 && allRefs({
      sourceRefs: existingNode.sourceRefs ?? [],
      expandRefs: existingNode.expandRefs ?? [],
    }).length > 0);
}

function hasRewrittenDescendantNode(node: NextNode): boolean {
  return node.children.some((child) => child.rewritten || hasRewrittenDescendantNode(child));
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
    const expandRefs = unique(node.expandRefs ?? []);
    const text = leafObservationText(node);
    rows.push({
      id: node.id,
      path: node.path,
      text,
      vector: await embedText(text, signal),
      extractionRefs: expandRefs,
      createdAt: existing.get(node.id)?.createdAt ?? now,
      updatedAt: now,
    });
  }
  return rows;
}

function leafObservationText(node: NextNode): string {
  return `${node.path}\n\n${node.content.trim()}`.trim();
}

async function updateExtractionLinks(
  client: NativeTables,
  params: {
    extractions: Extraction[];
    existingRows: ObservationContext[];
    writablePaths: Set<string>;
    nodes: NextNode[];
    now: string;
  },
): Promise<void> {
  const leafByRef = new Map<string, string[]>();
  for (const node of params.nodes) {
    if (node.children.length > 0) {
      continue;
    }
    for (const ref of allNodeRefs(node)) {
      const paths = leafByRef.get(ref) ?? [];
      paths.push(node.path);
      leafByRef.set(ref, paths);
    }
  }
  const inputById = new Map(params.extractions.map((extraction) => [extraction.id, extraction]));
  const affectedIds = unique([
    ...params.extractions.map((extraction) => extraction.id),
    ...params.existingRows
      .filter((row) => params.writablePaths.has(row.path))
      .flatMap((row) => allRefs(row)),
    ...leafByRef.keys(),
  ]);
  const storedRows = affectedIds.length > 0
    ? await client.extractionTable.get({ ids: affectedIds.filter((id) => !inputById.has(id)) })
    : [];
  const extractionById = new Map([
    ...storedRows.map((extraction) => [extraction.id, extraction] as const),
    ...inputById,
  ]);
  const rows = affectedIds
    .map((id) => extractionById.get(id))
    .filter((extraction): extraction is Extraction => Boolean(extraction))
    .filter((extraction) => leafByRef.has(extraction.id) || extraction.observationPaths.some((path) => params.writablePaths.has(path)))
    .map((extraction) => {
      const observationPaths = unique([
        ...extraction.observationPaths.filter((path) => !params.writablePaths.has(path)),
        ...(leafByRef.get(extraction.id) ?? []),
      ]);
      if (sameStringSet(extraction.observationPaths, observationPaths)) {
        return null;
      }
      return {
        ...extraction,
        observationPaths,
        updatedAt: params.now,
      };
    })
    .filter((row): row is Extraction => Boolean(row));
  if (rows.length > 0) {
    await client.extractionTable.upsert({ rows });
  }
}

function refHintsById(contexts: ObservationContext[]): Map<string, RefHints> {
  return new Map(contexts.map((context) => [context.path, {
    sourceRefs: context.sourceRefs ?? [],
    expandRefs: context.expandRefs ?? [],
  }]));
}

function stripChangedExtractionRefs(
  refsById: Map<string, RefHints>,
  extractions: Extraction[],
): Map<string, RefHints> {
  const changedRefs = new Set(extractions.flatMap(extractionRefVariants));
  return new Map([...refsById].map(([id, refs]) => [id, {
    sourceRefs: refs.sourceRefs.filter((ref) => !changedRefs.has(ref)),
    expandRefs: refs.expandRefs.filter((ref) => !changedRefs.has(ref)),
  }]));
}

function extractionRefVariants(extraction: Extraction): string[] {
  return extraction.id.startsWith('extraction:')
    ? [extraction.id, extraction.id.slice('extraction:'.length)]
    : [extraction.id, `extraction:${extraction.id}`];
}

function renderTree(
  cwdScope: string,
  roots: ObservationContext[],
  refsById: Map<string, RefHints>,
  selectedPaths?: Set<string>,
): string {
  if (roots.length === 0) {
    return `# ${cwdScope}`;
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
  return [`# ${cwdScope}`, ...renderContextRows(byParent, null, refsById, selectedPaths)].join('\n\n');
}

function renderObservedDocument(
  cwdScope: string,
  rows: ObservationContext[],
  selectedPaths: Set<string>,
  refsById: Map<string, RefHints>,
): string {
  return renderTree(cwdScope, rows, refsById, selectedPaths);
}

function renderOutline(cwdScope: string, roots: ObservationContext[]): string {
  if (roots.length === 0) {
    return `# ${cwdScope}\n\n(empty)`;
  }
  const byParent = groupByParent(roots);
  return [`# ${cwdScope}`, ...renderOutlineRows(byParent, null, 0)].join('\n');
}

function renderOutlineRows(
  byParent: Map<string | null, ObservationContext[]>,
  parentId: string | null,
  depth: number,
): string[] {
  return (byParent.get(parentId) ?? []).flatMap((row) => {
    const hasChildren = byParent.has(row.path);
    const indent = '  '.repeat(depth);
    return [
      `${indent}- ${hasChildren ? 'non-leaf' : 'leaf'}: ${row.path}`,
      ...renderOutlineRows(byParent, row.path, depth + 1),
    ];
  });
}

function buildRewriteScope(tree: ExistingTree, extractions: Extraction[]): { rows: ObservationContext[]; paths: Set<string> } {
  const paths = new Set<string>();
  for (const extraction of extractions) {
    for (const path of extraction.observationPaths) {
      if (!tree.byPath.has(path)) {
        continue;
      }
      addAncestors(paths, tree, path);
      addDescendants(paths, tree, path);
    }
  }
  return {
    rows: tree.rows.filter((row) => paths.has(row.path)).sort(byPosition),
    paths,
  };
}

function addAncestors(paths: Set<string>, tree: ExistingTree, path: string): void {
  let current = tree.byPath.get(path);
  while (current) {
    paths.add(current.path);
    current = current.parentId ? tree.byPath.get(current.parentId) : undefined;
  }
}

function addDescendants(paths: Set<string>, tree: ExistingTree, path: string): void {
  const stack = [...(tree.byParent.get(path) ?? [])];
  while (stack.length > 0) {
    const row = stack.pop()!;
    paths.add(row.path);
    stack.push(...(tree.byParent.get(row.path) ?? []));
  }
}

function createGetObservationTool(
  cwdScope: string,
  tree: ExistingTree,
  refsById: Map<string, RefHints>,
): (paths: string[]) => string {
  return (inputPaths) => {
    const paths = unique(inputPaths.map((path) => path.trim()).filter(Boolean));
    if (paths.length === 0) {
      throw new Error('get_observation requires at least one path');
    }
    for (const path of paths) {
      if (!tree.byPath.has(path)) {
        throw new Error(`get_observation path is not visible in the outline: ${path}`);
      }
    }
    return paths.map((path) => renderObservationSelection(cwdScope, tree, path, refsById)).join('\n\n----\n\n');
  };
}

function renderObservationSelection(
  cwdScope: string,
  tree: ExistingTree,
  path: string,
  refsById: Map<string, RefHints>,
): string {
  const selected = tree.byPath.get(path);
  if (!selected) {
    throw new Error(`unknown observation path: ${path}`);
  }
  const paths = new Set<string>();
  addAncestors(paths, tree, path);
  addDescendants(paths, tree, path);
  return renderTree(
    cwdScope,
    tree.rows.filter((row) => paths.has(row.path)),
    refsById,
    paths,
  );
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
  refsById: Map<string, RefHints>,
  selectedPaths?: Set<string>,
): string[] {
  return (byParent.get(parentId) ?? []).flatMap((row) => [
    renderContextRow(
      row,
      byParent.has(row.path),
      refsById.get(row.path) ?? emptyRefs(),
      selectedPaths?.has(row.path) ?? true,
    ),
    ...renderContextRows(byParent, row.path, refsById, selectedPaths),
  ]);
}

function renderContextRow(
  row: ObservationContext,
  hasChildren: boolean,
  refs: RefHints,
  selected: boolean,
): string {
  const level = headingLevel(row.path);
  const lines = [`${level} ${lastPathSegment(row.path)} <!-- path: ${row.path} -->`];
  if (selected && row.content.trim()) {
    lines.push('', row.content.trim());
  }
  if (selected && !hasChildren) {
    lines.push(...renderSourceExtractionLines(refs, row.content));
  }
  return lines.join('\n').trim();
}

function byPosition(left: ObservationContext, right: ObservationContext): number {
  return left.position - right.position || left.path.localeCompare(right.path);
}

function flattenNodes(nodes: NextNode[]): NextNode[] {
  return nodes.flatMap((node) => [node, ...flattenNodes(node.children)]);
}

function lastPathSegment(path: string): string {
  return path.split('/').map((part) => part.trim()).filter(Boolean).at(-1) ?? path;
}

function headingLevel(path: string): string {
  const depth = Math.max(1, path.split('/').map((part) => part.trim()).filter(Boolean).length - 1);
  return '#'.repeat(Math.min(depth + 1, 4));
}

function allRefs(refs: RefHints): string[] {
  return unique(refs.sourceRefs);
}

function allNodeRefs(node: Pick<NextNode, 'sourceRefs'>): string[] {
  return unique(node.sourceRefs);
}

function emptyRefs(): RefHints {
  return { sourceRefs: [], expandRefs: [] };
}

function renderRefsHint(_refs: RefHints): string {
  return '';
}

function renderSourceExtractionLines(refs: RefHints, content: string): string[] {
  if (/^Source extractions:\s*$/im.test(content)) {
    return [];
  }
  return ['', 'Source extractions:', ...allRefs(refs).map((ref) => `- [${ref}]`)];
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
  groupByCwd,
  getObserverWorkStatus,
  runObserver,
};
