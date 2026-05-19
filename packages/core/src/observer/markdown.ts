import type { ParsedObserverDocument, ParsedObserverSection } from './types.js';

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type DraftSection = ParsedObserverSection & {
  parent?: DraftSection;
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
    const sections = parseSections(lines, validRefs, { allowRootlessSubtree: true });
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

  const sections = parseSections(lines.slice(titleIndexes[0] + 1), validRefs, {
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
  options: { allowRootlessSubtree?: boolean } = {},
): DraftSection[] {
  const roots: DraftSection[] = [];
  const stack: DraftSection[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const match = line.match(/^(#{2,3})\s+(.+?)(?:\s+<!--\s*(.*?)\s*-->)?\s*$/);
    if (!match) {
      const current = stack.at(-1);
      if (current) {
        current.body = `${current.body}${current.body ? '\n' : ''}${line}`;
      } else if (line.trim()) {
        throw new Error('observer document text cannot appear before the first ## section');
      }
      continue;
    }

    const level = match[1]!.length as 2 | 3;
    const heading = clean(match[2] ?? '');
    if (!heading) {
      throw new Error('observer section heading cannot be empty');
    }
    if (level === 3 && !stack.some((section) => section.level === 2) && !options.allowRootlessSubtree) {
      throw new Error('observer ### section must belong to a ## section');
    }

    while (stack.length > 0 && stack.at(-1)!.level >= level) {
      stack.pop();
    }
    const hint = parseHint(match[3] ?? '', validRefs);
    const parent = stack.at(-1);
    const section: DraftSection = {
      id: hint.id,
      level,
      heading,
      refs: hint.refs,
      delete: hint.delete,
      body: '',
      children: [],
      parent,
    };
    if (parent) {
      parent.children.push(section);
    } else {
      roots.push(section);
    }
    stack.push(section);
  }

  trimBodies(roots);
  return roots;
}

function parseHint(value: string, validRefs: Set<string>): { id?: string; refs: string[]; delete: boolean } {
  const hint = value.trim();
  const result: { id?: string; refs: string[]; delete: boolean } = { refs: [], delete: false };
  if (!hint) {
    return result;
  }
  for (const part of hint.split(';')) {
    const [rawKey, ...rawValue] = part.split(':');
    const key = clean(rawKey ?? '').toLowerCase();
    const field = rawValue.join(':').trim();
    if (key === 'id') {
      if (!ID_RE.test(field)) {
        throw new Error(`observer section id must be a UUID: ${field}`);
      }
      result.id = field;
    } else if (key === 'refs') {
      result.refs = parseRefs(field, validRefs);
    } else if (key === 'delete') {
      result.delete = field.toLowerCase() === 'true';
    } else if (key) {
      throw new Error(`unknown observer heading hint: ${key}`);
    }
  }
  return result;
}

function parseRefs(value: string, validRefs: Set<string>): string[] {
  const match = value.match(/^\[([^\]]+)\]$/);
  if (!match) {
    throw new Error('observer refs must use [extraction-id, ...]');
  }
  const refs = unique((match[1] ?? '').split(',').map((ref) => ref.trim()).filter(Boolean));
  if (refs.length === 0) {
    throw new Error('observer refs cannot be empty');
  }
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
  const ids = new Set<string>();
  for (const section of walk(sections)) {
    if (section.id) {
      if (ids.has(section.id)) {
        throw new Error(`duplicate observer section id: ${section.id}`);
      }
      ids.add(section.id);
    }
    if (section.delete) {
      if (!section.id) {
        throw new Error('observer delete section must preserve an existing id');
      }
      continue;
    }
    if (section.children.length > 0 && section.refs.length > 0) {
      throw new Error(`non-leaf observer section cannot declare refs: ${section.heading}`);
    }
    if (section.children.length === 0) {
      if (section.refs.length === 0) {
        throw new Error(`leaf observer section must declare refs: ${section.heading}`);
      }
      if (!clean(section.body)) {
        throw new Error(`leaf observer section cannot be empty: ${section.heading}`);
      }
    }
    for (const ref of section.refs) {
      if (!validRefs.has(ref)) {
        throw new Error(`observer referenced unknown extraction id: ${ref}`);
      }
    }
  }
}

function trimBodies(sections: DraftSection[]): void {
  for (const section of walk(sections)) {
    section.body = section.body.trim();
  }
}

function walk(sections: DraftSection[]): DraftSection[] {
  return sections.flatMap((section) => [section, ...walk(section.children)]);
}

function stripParent(section: DraftSection): ParsedObserverSection {
  return {
    id: section.id,
    level: section.level,
    heading: section.heading,
    refs: section.refs,
    delete: section.delete,
    body: section.body,
    children: section.children.map(stripParent),
  };
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
