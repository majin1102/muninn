import type { ParsedObserverDocument, ParsedObserverSection } from './types.js';

type DraftSection = ParsedObserverSection & {
  parent?: DraftSection;
  declaredSources?: boolean;
};

export function parseObserverDocument(raw: string, validRefs: Set<string>): ParsedObserverDocument {
  return parseObserverMarkdown(raw, validRefs, {});
}

export function parseObserverSubtree(
  raw: string,
  validRefs: Set<string>,
  fallbackTitle: string,
): ParsedObserverDocument {
  return parseObserverMarkdown(raw, validRefs, { fallbackTitle, allowRootlessSubtree: true });
}

function parseObserverMarkdown(
  raw: string,
  validRefs: Set<string>,
  options: {
    fallbackTitle?: string;
    allowRootlessSubtree?: boolean;
  },
): ParsedObserverDocument {
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
    const globalPath = `${parent?.globalPath ?? title} / ${heading}`;
    const section: DraftSection = {
      level,
      heading,
      globalPath,
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
    if (paths.has(section.globalPath)) {
      throw new Error(`duplicate observer section path: ${section.globalPath}`);
    }
    paths.add(section.globalPath);
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
  // Section headings still reject "/" so global_path segments stay unambiguous.
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

function stripParent(section: DraftSection): ParsedObserverSection {
  return {
    level: section.level,
    heading: section.heading,
    globalPath: section.globalPath,
    sourceRefs: section.sourceRefs,
    expandRefs: section.expandRefs,
    body: section.body,
    rewritten: section.rewritten,
    children: section.children.map(stripParent),
  };
}

function refsForSection(section: Pick<ParsedObserverSection, 'sourceRefs'>): string[] {
  return unique(section.sourceRefs);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function clean(value: string): string {
  return value.split(/\s+/).join(' ').trim();
}

export const __testing = {
  parseObserverDocument,
  parseObserverSubtree,
};
