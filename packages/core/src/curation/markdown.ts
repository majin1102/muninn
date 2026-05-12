import type { CurationObservationDraft, ParsedCurationDocument } from './types.js';

type Section = {
  level: 2 | 3;
  heading: string;
  refs: string[];
  body: string;
  parent?: Section;
};

export function parseCurationDocument(raw: string, validRefs: Set<string>): ParsedCurationDocument {
  const content = stripFence(typeof raw === 'string' ? raw.trim() : '');
  if (!content) {
    throw new Error('curation document is empty');
  }
  if (/^\s*\{/.test(content)) {
    throw new Error('curation document must be Markdown, not JSON');
  }

  const lines = content.split(/\r?\n/);
  const titleIndexes = lines.flatMap((line, index) => /^#\s+(.+?)\s*$/.test(line) ? [index] : []);
  if (titleIndexes.length !== 1) {
    throw new Error('curation document must include exactly one # title');
  }
  const title = clean(lines[titleIndexes[0]]!.replace(/^#\s+/, ''));
  if (!title) {
    throw new Error('curation document title cannot be empty');
  }

  const sections = parseSections(lines.slice(titleIndexes[0] + 1), validRefs);
  if (sections.length === 0) {
    throw new Error('curation document must include at least one ## section');
  }

  const firstBody = sections.find((section) => section.level === 2)?.body ?? '';
  return {
    title,
    content,
    summary: clean(firstBody),
    observations: deriveObservations(sections),
  };
}

export function stripFence(value: string): string {
  const match = value.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
  return (match?.[1] ?? value).trim();
}

function parseSections(lines: string[], validRefs: Set<string>): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  let currentParent: Section | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const heading = line.match(/^(#{2,3})\s+(.+?)\s*$/);
    if (!heading) {
      if (current) {
        current.body = `${current.body}\n${line}`;
      } else if (line.trim()) {
        throw new Error('curation document text cannot appear before the first ## section');
      }
      continue;
    }

    const level = heading[1]!.length;
    if (level !== 2 && level !== 3) {
      throw new Error('curation document headings deeper than ### are not supported');
    }
    if (level === 3 && !currentParent) {
      throw new Error('curation document ### section must belong to a ## section');
    }

    const title = clean(heading[2] ?? '');
    if (!title) {
      throw new Error('curation section heading cannot be empty');
    }

    const refsLine = lines[index + 1] ?? '';
    const refs = parseRefs(refsLine);
    validateRefs(refs, validRefs);
    index += 1;

    const section: Section = {
      level,
      heading: title,
      refs,
      body: '',
      parent: level === 3 ? currentParent ?? undefined : undefined,
    };
    sections.push(section);
    current = section;
    if (level === 2) {
      currentParent = section;
    }
  }

  for (const section of sections) {
    section.body = section.body.trim();
    if (!clean(section.body)) {
      throw new Error(`curation section "${section.heading}" cannot be empty`);
    }
  }
  return sections;
}

function deriveObservations(sections: Section[]): CurationObservationDraft[] {
  return sections.map((section) => {
    if (section.level === 2) {
      return {
        heading: section.heading,
        text: `${section.heading}\n\n${section.body}`.trim(),
        references: section.refs,
      };
    }
    const parent = section.parent;
    if (!parent) {
      throw new Error('curation child section missing parent');
    }
    return {
      heading: `${parent.heading} / ${section.heading}`,
      text: `${parent.heading}\n${section.heading}\n\n${section.body}`.trim(),
      references: unique([...parent.refs, ...section.refs]),
    };
  });
}

function parseRefs(line: string): string[] {
  const match = line.match(/^\s*<refs:\s*\[([^\]]+)\]>\s*$/i);
  if (!match) {
    throw new Error('curation heading must be followed by <refs: [extraction:id, ...]>');
  }
  const refs = (match[1] ?? '')
    .split(',')
    .map((ref) => ref.trim())
    .filter(Boolean);
  if (refs.length === 0) {
    throw new Error('curation refs cannot be empty');
  }
  return unique(refs);
}

function validateRefs(refs: string[], validRefs: Set<string>): void {
  for (const ref of refs) {
    if (!ref.startsWith('extraction:')) {
      throw new Error(`curation ref must use extraction memory id: ${ref}`);
    }
    if (!validRefs.has(ref)) {
      throw new Error(`curation referenced unknown extraction ref: ${ref}`);
    }
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function clean(value: string): string {
  return value.split(/\s+/).join(' ').trim();
}

export const __testing = {
  parseCurationDocument,
};
