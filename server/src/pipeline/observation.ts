import { embedText } from '../llm/embedding-provider.js';
import { generateObservationPatch, type ObservationExtractionInput } from '../llm/observer.js';
import type { Extraction, NativeTables, Observation, ObservationContext } from '../native.js';
import type { QueuedExtractionChange } from '../checkpoint.js';

type GenerateObservationPatchImpl = typeof generateObservationPatch;

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

export type ObservationBatchResult = {
  observed: number;
  skipped: number;
};

export async function applyObservationBatch(params: {
  client: NativeTables;
  observerName: string;
  cwd: string;
  extractionChanges: QueuedExtractionChange[];
  database?: string;
  signal?: AbortSignal;
  generateObservationPatchImpl?: GenerateObservationPatchImpl;
}): Promise<ObservationBatchResult> {
  throwIfAborted(params.signal);
  const changedExtractions = params.extractionChanges.map((change) => change.extraction);
  const upsertExtractions = params.extractionChanges
    .filter((change) => change.type === 'upsert')
    .map((change) => change.extraction);
  const allContexts = await params.client.observationContextTable.list({ observer: params.observerName });
  const tree = contextsForCwd(allContexts, params.cwd);
  const currentObservationRefs = stripChangedExtractionRefs(refHintsById(tree.rows), changedExtractions);
  const rewriteScope = buildRewriteScope(tree, changedExtractions);
  const result = await (params.generateObservationPatchImpl ?? generateObservationPatch)({
    cwdScope: params.cwd,
    outline: renderOutline(params.cwd, tree.rootRows),
    observedDocument: renderObservedDocument(params.cwd, tree.rows, rewriteScope.paths, currentObservationRefs),
    extractions: upsertExtractions.map(toObservationExtractionInput),
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
  return { observed: 1, skipped: 0 };
}

function toObservationExtractionInput(extraction: Extraction): ObservationExtractionInput {
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
  result: ParsedObservationDocument;
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
  returnedSections: ParsedObservationSection[],
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
  sections: ParsedObservationSection[],
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

function rewrittenScopeRoots(sections: ParsedObservationSection[]): ParsedObservationSection[] {
  const roots: ParsedObservationSection[] = [];
  const visit = (section: ParsedObservationSection, ancestorRewritten: boolean): void => {
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

function protectedKeepRoots(sections: ParsedObservationSection[]): ParsedObservationSection[] {
  return walkSections(sections).filter((section) => !sectionIsRewritten(section) && !hasRewrittenDescendant(section));
}

function sectionIsRewritten(section: ParsedObservationSection): boolean {
  return section.rewritten ?? Boolean(section.body.trim() || section.sourceRefs.length > 0);
}

function hasRewrittenDescendant(section: ParsedObservationSection): boolean {
  return section.children.some((child) => sectionIsRewritten(child) || hasRewrittenDescendant(child));
}

function walkSections(sections: ParsedObservationSection[]): ParsedObservationSection[] {
  return sections.flatMap((section) => [section, ...walkSections(section.children)]);
}

function pathInSubtree(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root} / `);
}

function buildNodes(params: {
  sections: ParsedObservationSection[];
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

export type ParsedObservationSection = {
  level: 2 | 3 | 4;
  heading: string;
  path: string;
  sourceRefs: string[];
  expandRefs: string[];
  body: string;
  rewritten: boolean;
  children: ParsedObservationSection[];
};

export type ParsedObservationDocument = {
  title: string;
  sections: ParsedObservationSection[];
};

type DraftSection = ParsedObservationSection & {
  parent?: DraftSection;
  declaredSources?: boolean;
};

export function parseObservationDocument(raw: string, validRefs: Set<string>): ParsedObservationDocument {
  return parseObservationMarkdown(raw, validRefs, {});
}

export function parseObservationSubtree(
  raw: string,
  validRefs: Set<string>,
  fallbackTitle: string,
): ParsedObservationDocument {
  return parseObservationMarkdown(raw, validRefs, { fallbackTitle, allowRootlessSubtree: true });
}

function parseObservationMarkdown(
  raw: string,
  validRefs: Set<string>,
  options: {
    fallbackTitle?: string;
    allowRootlessSubtree?: boolean;
  },
): ParsedObservationDocument {
  const content = stripFence(typeof raw === 'string' ? raw.trim() : '');
  if (!content) {
    throw new Error('observer document is empty');
  }
  if (/^\s*\{/.test(content)) {
    throw new Error('observer document must be Markdown, not JSON');
  }

  const lines = content.split(/\r?\n/);
  const titleIndexes = lines.flatMap((line, index) => /^#\s+(.+?)\s*$/.test(line) ? [index] : []);
  if (titleIndexes.length === 0 && options.allowRootlessSubtree) {
    const title = clean(options.fallbackTitle ?? '');
    if (!title) {
      throw new Error('observer document title cannot be empty');
    }
    validateTitle(title);
    const sections = parseSections(lines, validRefs, title, { allowRootlessSubtree: true });
    validateTree(sections, validRefs);
    return { title, sections: sections.map(stripParent) };
  }
  if (titleIndexes.length !== 1) {
    throw new Error('observer document must include exactly one # root title');
  }
  const title = clean(lines[titleIndexes[0]]!.replace(/^#\s+/, ''));
  if (!title) {
    throw new Error('observer document title cannot be empty');
  }
  validateTitle(title);

  const sections = parseSections(lines.slice(titleIndexes[0] + 1), validRefs, title, {
    allowRootlessSubtree: options.allowRootlessSubtree,
  });
  validateTree(sections, validRefs);
  return { title, sections: sections.map(stripParent) };
}

export function stripFence(value: string): string {
  const match = value.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
  return (match?.[1] ?? value).trim();
}

function parseSections(
  lines: string[],
  validRefs: Set<string>,
  title: string,
  options: { allowRootlessSubtree?: boolean } = {},
): DraftSection[] {
  const roots: DraftSection[] = [];
  const stack: DraftSection[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const match = line.match(/^(#{2,4})\s+(.+?)\s+<!--\s*(.*?)\s*-->\s*$/)
      ?? line.match(/^(#{2,4})\s+(.+?)\s*$/);
    if (!match) {
      const current = stack.at(-1);
      if (current) {
        current.body = `${current.body}${current.body ? '\n' : ''}${line}`;
      } else if (line.trim()) {
        throw new Error('observer document text cannot appear before the first ## section');
      }
      continue;
    }

    const level = match[1]!.length as 2 | 3 | 4;
    const heading = clean(match[2] ?? '');
    if (!heading) {
      throw new Error('observer section heading cannot be empty');
    }
    if (heading.includes('/')) {
      throw new Error(`observer section heading cannot contain "/": ${heading}`);
    }
    if (level > 2 && !stack.some((section) => section.level === level - 1)) {
      throw new Error(`observer ${'#'.repeat(level)} section must belong to a ${'#'.repeat(level - 1)} section`);
    }

    while (stack.length > 0 && stack.at(-1)!.level >= level) {
      stack.pop();
    }
    const hint = parseHint(match[3] ?? '', validRefs);
    const parent = stack.at(-1);
    const path = `${parent?.path ?? title} / ${heading}`;
    const section: DraftSection = {
      level,
      heading,
      path,
      sourceRefs: hint.sourceRefs,
      expandRefs: hint.expandRefs,
      body: '',
      rewritten: false,
      children: [],
      parent,
      declaredSources: hint.declaredSources,
    };
    if (parent) {
      parent.children.push(section);
    } else {
      roots.push(section);
    }
    stack.push(section);
  }

  trimBodies(roots);
  parseSourceExtractionSections(roots, validRefs);
  markRewritten(roots);
  return roots;
}

function parseHint(
  value: string,
  validRefs: Set<string>,
): { sourceRefs: string[]; expandRefs: string[]; declaredSources: boolean } {
  const hint = value.trim();
  const result: {
    sourceRefs: string[];
    expandRefs: string[];
    declaredSources: boolean;
  } = {
    sourceRefs: [],
    expandRefs: [],
    declaredSources: false,
  };
  if (!hint) {
    return result;
  }
  const [rawKey] = hint.split(':');
  const key = clean(rawKey ?? hint).toLowerCase();
  throw new Error(`unknown observer heading hint: ${key}`);
}

function parseRefs(value: string, validRefs: Set<string>, label: string): string[] {
  const match = value.match(/^\[([^\]]*)\]$/);
  if (!match) {
    throw new Error(`observer ${label} refs must use [extraction-id, ...]`);
  }
  const refs = unique((match[1] ?? '').split(',').map((ref) => ref.trim()).filter(Boolean));
  return refs.map((ref) => resolveRef(ref, validRefs));
}

function resolveRef(ref: string, validRefs: Set<string>): string {
  if (validRefs.has(ref)) {
    return ref;
  }
  if (ref.length < 12) {
    throw new Error(`observer referenced unknown extraction id: ${ref}`);
  }
  const matches = [...validRefs].filter((validRef) => validRef.startsWith(ref));
  if (matches.length === 1) {
    return matches[0]!;
  }
  if (matches.length > 1) {
    throw new Error(`observer referenced ambiguous extraction id prefix: ${ref}`);
  }
  const nearMatches = nearExtractionRefMatches(ref, validRefs);
  if (nearMatches.length === 1) {
    return nearMatches[0]!;
  }
  if (nearMatches.length > 1) {
    throw new Error(`observer referenced ambiguous extraction id near-match: ${ref}`);
  }
  throw new Error(`observer referenced unknown extraction id: ${ref}`);
}

function nearExtractionRefMatches(ref: string, validRefs: Set<string>): string[] {
  if (!/^[0-9a-f]{12,}$/i.test(ref)) {
    return [];
  }
  return [...validRefs].filter((validRef) => {
    if (!/^[0-9a-f]{12,}$/i.test(validRef)) {
      return false;
    }
    const sharedPrefix = commonPrefixLength(ref, validRef);
    if (sharedPrefix < Math.min(16, validRef.length - 2, ref.length - 2)) {
      return false;
    }
    return editDistanceAtMost(ref, validRef, 2);
  });
}

function commonPrefixLength(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  for (let index = 0; index < max; index += 1) {
    if (left[index] !== right[index]) {
      return index;
    }
  }
  return max;
}

function editDistanceAtMost(left: string, right: string, limit: number): boolean {
  if (Math.abs(left.length - right.length) > limit) {
    return false;
  }
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    let rowMin = current[0]!;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      const value = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + cost,
      );
      current[j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > limit) {
      return false;
    }
    previous = current;
  }
  return previous[right.length]! <= limit;
}

function validateTree(sections: DraftSection[], validRefs: Set<string>): void {
  const paths = new Set<string>();
  for (const section of walk(sections)) {
    if (paths.has(section.path)) {
      throw new Error(`duplicate observer section path: ${section.path}`);
    }
    paths.add(section.path);
    const sectionRefs = refsForSection(section);
    if (section.children.length > 0 && sectionRefs.length > 0) {
      throw new Error(`non-leaf observer section cannot declare refs: ${section.heading}`);
    }
    if (section.children.length === 0) {
      if (!section.rewritten) {
        continue;
      }
      if (!section.declaredSources) {
        throw new Error(`leaf observer section must include Source extractions: ${section.heading}`);
      }
      if (sectionRefs.length === 0) {
        throw new Error(`leaf observer section source extraction ids cannot be empty: ${section.heading}`);
      }
      if (!clean(section.body)) {
        throw new Error(`rewritten leaf observer section cannot be empty: ${section.heading}`);
      }
    }
    for (const ref of sectionRefs) {
      if (!validRefs.has(ref)) {
        throw new Error(`observer referenced unknown extraction id: ${ref}`);
      }
    }
  }
}

function validateTitle(_title: string): void {
  // The root title can be a cwd scope such as /Users/Nathan/workspace/muninn.
  // Section headings still reject "/" so path segments stay unambiguous.
}

function trimBodies(sections: DraftSection[]): void {
  for (const section of walk(sections)) {
    section.body = section.body.trim();
  }
}

function parseSourceExtractionSections(sections: DraftSection[], validRefs: Set<string>): void {
  for (const section of walk(sections)) {
    if (!clean(section.body)) {
      continue;
    }
    if (/<!--[\s\S]*?-->/i.test(section.body)) {
      throw new Error(`observer section body cannot contain HTML comments: ${section.heading}`);
    }
    const lines = section.body.split(/\r?\n/);
    const sourceIndex = lines.findIndex((line) => /^Source extractions:\s*$/i.test(line.trim()));
    if (sourceIndex < 0) {
      continue;
    }
    const before = lines.slice(0, sourceIndex).join('\n').trim();
    if (!before) {
      throw new Error(`rewritten leaf observer section cannot be empty: ${section.heading}`);
    }
    const sourceLines = lines.slice(sourceIndex + 1).filter((line) => line.trim());
    if (sourceLines.length === 0) {
      throw new Error(`Source extractions cannot be empty: ${section.heading}`);
    }
    const normalizedSourceLines: string[] = [];
    for (const line of sourceLines) {
      const match = line.match(/^\s*-\s*(\[[^\]]+\])\s*(.*)$/);
      if (!match) {
        throw new Error(`Source extractions must use "- [extraction-id]": ${section.heading}`);
      }
      const refs = parseRefs(match[1]!, validRefs, 'source extraction');
      const rewritten = (match[2] ?? '').trim();
      if (rewritten && refs.length === 1) {
        throw new Error(`single Source extraction bullets must not rewrite source content: ${section.heading}`);
      }
      if (!rewritten && refs.length !== 1) {
        throw new Error(`placeholder Source extraction bullets must contain exactly one id: ${section.heading}`);
      }
      if (rewritten) {
        section.sourceRefs = unique([...section.sourceRefs, ...refs]);
        normalizedSourceLines.push(`- [${refs.join(', ')}] ${rewritten}`);
      } else {
        section.sourceRefs = unique([...section.sourceRefs, refs[0]!]);
        section.expandRefs = unique([...section.expandRefs, refs[0]!]);
        normalizedSourceLines.push(`- [${refs[0]}]`);
      }
    }
    section.declaredSources = true;
    section.body = `${before}\n\nSource extractions:\n${normalizedSourceLines.join('\n')}`.trim();
  }
}

function markRewritten(sections: DraftSection[]): void {
  for (const section of walk(sections)) {
    section.rewritten = Boolean(clean(section.body) || section.declaredSources);
  }
}

function walk(sections: DraftSection[]): DraftSection[] {
  return sections.flatMap((section) => [section, ...walk(section.children)]);
}

function stripParent(section: DraftSection): ParsedObservationSection {
  return {
    level: section.level,
    heading: section.heading,
    path: section.path,
    sourceRefs: section.sourceRefs,
    expandRefs: section.expandRefs,
    body: section.body,
    rewritten: section.rewritten,
    children: section.children.map(stripParent),
  };
}

function refsForSection(section: Pick<ParsedObservationSection, 'sourceRefs'>): string[] {
  return unique(section.sourceRefs);
}

function clean(value: string): string {
  return value.split(/\s+/).join(' ').trim();
}

export const __testing = {
  applyObservationBatch,
  parseObservationDocument,
  parseObservationSubtree,
};
