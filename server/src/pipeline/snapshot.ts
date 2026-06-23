export type SnapshotThreadKind = 'session' | 'subject';

export type ExtractionUnit = {
  id?: string | null;
  title?: string | null;
  text: string;
  context?: string | null;
  references: string[];
  updatedMemory?: string | null;
};

export type ContextRef = {
  turnId: string;
  summary: string;
};

export type SkillDetails = Record<string, string>;

export type SnapshotSignals = {
  memorySignals: string[];
  skillSignals: string[];
  skillDetails: SkillDetails;
};

export type ExtractionChange =
  | {
    type: 'add';
    text: string;
    context?: string | null;
    references: string[];
    reason: string;
  }
  | {
    type: 'merge';
    extractionIds: string[];
    text: string;
    context?: string | null;
    reason: string;
  }
  | {
    type: 'update';
    extractionId: string;
    text: string;
    context?: string | null;
    references?: string[];
    reason: string;
  }
  | {
    type: 'delete';
    extractionId: string;
    reason: string;
  };

export type SnapshotContent = {
  threadKind?: SnapshotThreadKind;
  sessionId?: string | null;
  project?: string;
  cwd?: string;
  agent?: string;
  snapshotContent: string;
  memorySignals?: string[];
  skillSignals?: string[];
  skillDetails?: SkillDetails;
  extractions: ExtractionUnit[];
  contextRefs: ContextRef[];
  nextSteps?: string[];
  extractionChanges: ExtractionChange[];
};

export type ParsedSnapshotContent = {
  title: string;
  summary: string;
  memorySignals: string[];
  skillSignals: string[];
  skillDetails: SkillDetails;
  snapshotContent: string;
  extractionMarkdown: string;
  extractions: ExtractionUnit[];
};

export type ParsedSnapshotPatch = {
  title?: string;
  summary?: string;
  memorySignals?: string[];
  skillSignals?: string[];
  skillDetails?: SkillDetails;
  skillDetailsDeletes?: string[];
  updates: Array<{
    sequence: number;
    refs: string[];
    title: string;
    summary: string;
    content?: string | null;
  }>;
  additions: Array<{
    refs: string[];
    title: string;
    summary: string;
    content?: string | null;
  }>;
};

type UnitMetadata = {
  sequence?: number;
  references: string[];
};

const SNAPSHOT_SECTION_ORDER = [
  'Summary',
  'Memory Signals',
  'Skill Signals',
  'Skill Details',
  'Extractions',
] as const;

type SnapshotSection = typeof SNAPSHOT_SECTION_ORDER[number];

export function isValidSkillName(value: string): boolean {
  return value.trim() === value && value.length > 0 && !/[`:\r\n]/.test(value);
}

export function skillNamesFromSignals(skillSignals: string[]): Set<string> {
  const names = new Set<string>();
  for (const signal of skillSignals) {
    const match = /^- \[[^\]]+\]\s+([^:\n]+):/.exec(signal.trim());
    if (match && isValidSkillName(match[1]!)) {
      names.add(match[1]!);
    }
  }
  return names;
}

export function signalEvidenceTurnIds(signals: string[]): Set<string> {
  const ids = new Set<string>();
  for (const signal of signals) {
    const labels = parseSignalLabelList(signal.trim());
    if (!labels) {
      continue;
    }
    for (const label of labels) {
      ids.add(label.turnId);
    }
  }
  return ids;
}

export function signalEvidenceLabels(signals: string[]): Set<string> {
  const labels = new Set<string>();
  for (const signal of signals) {
    const parsed = parseSignalLabelList(signal.trim());
    if (!parsed) {
      continue;
    }
    for (const label of parsed) {
      labels.add(signalLabelKey(label));
    }
  }
  return labels;
}

export function parseSnapshotContent(
  raw: string,
  validReferences: Set<string>,
): ParsedSnapshotContent {
  const snapshotContent = stripMarkdownFence(typeof raw === 'string' ? raw.trim() : '');
  if (!snapshotContent) {
    throw new Error('extraction update returned empty snapshot content');
  }
  rejectJson(snapshotContent);

  const lines = snapshotContent.split(/\r?\n/);
  const title = parseRequiredTitle(lines);
  const sections = snapshotSections(lines, 'snapshot content document');
  const summaryIndex = sections.get('Summary');
  if (summaryIndex === undefined) {
    throw new Error('snapshot content document must include ## Summary');
  }
  validateSnapshotSectionOrder(sections, 'snapshot content document');

  const summary = sectionBody(lines, sections, 'Summary') ?? '';
  if (!normalizeText(summary)) {
    throw new Error('snapshot content document summary cannot be empty');
  }
  const memorySignals = parseSignalBlocks(sectionBody(lines, sections, 'Memory Signals') ?? '', 'Memory Signals');
  const skillSignals = parseSignalBlocks(sectionBody(lines, sections, 'Skill Signals') ?? '', 'Skill Signals');
  validateSkillSignals(skillSignals);
  const skillDetails = parseSkillDetails(sectionBody(lines, sections, 'Skill Details') ?? '');
  validateSkillDetailsHaveSignals(skillDetails, skillSignals, 'snapshot content document');

  const extractionMarkdown = sectionBody(lines, sections, 'Extractions') ?? '';

  return {
    title,
    summary,
    memorySignals,
    skillSignals,
    skillDetails,
    snapshotContent,
    extractionMarkdown,
    extractions: parseSnapshotContentUnits(extractionMarkdown, validReferences),
  };
}

export function parseSnapshotPatch(
  raw: string,
  validNewReferences: Set<string>,
  validExistingSignalLabels: Set<string> = new Set(),
): ParsedSnapshotPatch {
  const patch = stripMarkdownFence(typeof raw === 'string' ? raw.trim() : '');
  if (!patch) {
    return { updates: [], additions: [] };
  }
  rejectJson(patch);

  const lines = patch.split(/\r?\n/);
  const title = parseOptionalTitle(lines);
  const sections = snapshotSections(lines, 'snapshot patch');
  validateSnapshotSectionOrder(sections, 'snapshot patch');
  const summary = sections.has('Summary')
    ? sectionBody(lines, sections, 'Summary') ?? ''
    : undefined;
  if (sections.has('Summary') && !normalizeText(summary ?? '')) {
    throw new Error('snapshot patch summary cannot be empty');
  }
  const memorySignals = sections.has('Memory Signals')
    ? parseSignalBlocks(sectionBody(lines, sections, 'Memory Signals') ?? '', 'Memory Signals', {
      validTurnIds: validNewReferences,
      validExistingLabels: validExistingSignalLabels,
    })
    : undefined;
  const skillSignals = sections.has('Skill Signals')
    ? parseSignalBlocks(sectionBody(lines, sections, 'Skill Signals') ?? '', 'Skill Signals', {
      validTurnIds: validNewReferences,
      validExistingLabels: validExistingSignalLabels,
    })
    : undefined;
  if (skillSignals) {
    validateSkillSignals(skillSignals);
  }
  const detailsPatch = sections.has('Skill Details')
    ? parseSkillDetailsPatch(sectionBody(lines, sections, 'Skill Details') ?? '')
    : undefined;

  const extractionMarkdown = sectionBody(lines, sections, 'Extractions') ?? '';
  const units = parsePatchUnits(extractionMarkdown, validNewReferences);
  return {
    ...(title === undefined ? {} : { title }),
    ...(summary === undefined ? {} : { summary }),
    ...(memorySignals === undefined ? {} : { memorySignals }),
    ...(skillSignals === undefined ? {} : { skillSignals }),
    ...(detailsPatch === undefined ? {} : { skillDetails: detailsPatch.skillDetails }),
    ...(detailsPatch === undefined ? {} : { skillDetailsDeletes: detailsPatch.skillDetailsDeletes }),
    updates: units.updates,
    additions: units.additions,
  };
}

export function parseSnapshotContentUnits(
  snapshotContent: string,
  validReferences: Set<string>,
): ExtractionUnit[] {
  if (!snapshotContent.trim()) {
    return [];
  }

  return splitUnits(snapshotContent).map((unit) => {
    const lines = unit.split(/\r?\n/);
    const metadata = parseSnapshotContentMetadata(lines[0] ?? '');
    if (!metadata || metadata.sequence !== undefined) {
      throw new Error('snapshot unit must start with refs metadata comment');
    }
    validateSnapshotContentReferences(metadata.references, validReferences);
    const body = parseTitleSummaryContent(lines.slice(1));
    return {
      title: body.title,
      text: normalizeText(body.summary),
      context: normalizeContext(body.content ?? ''),
      references: metadata.references,
    };
  });
}

export function renderSnapshotContent(
  title: string,
  summary: string,
  signals: SnapshotSignals,
  extractions: ExtractionUnit[],
): string {
  validateSkillSignals(signals.skillSignals);
  validateSkillDetailsHaveSignals(signals.skillDetails, signals.skillSignals, 'snapshot content document');
  return [
    `# ${normalizeRequiredTitle(title)}`,
    '',
    '## Summary',
    summary.trim(),
    '',
    '## Memory Signals',
    renderSignalBlocks(signals.memorySignals),
    '',
    '## Skill Signals',
    renderSignalBlocks(signals.skillSignals),
    '',
    '## Skill Details',
    renderSkillDetails(signals.skillDetails),
    '',
    '## Extractions',
    extractions.map((extraction) => renderExtractionBlock(extraction)).join('\n\n----\n\n'),
  ].join('\n').trimEnd();
}

export function renderExtractionBlock(
  extraction: ExtractionUnit,
  options: { sequence?: number; includeRefs?: boolean } = {},
): string {
  const metadata = renderMetadata({
    sequence: options.sequence,
    references: options.includeRefs === false ? [] : extraction.references,
  });
  return [
    metadata,
    '### Title',
    normalizeRequiredTitle(extraction.title ?? extraction.text),
    '',
    '### Summary',
    extraction.text.trim(),
    ...(normalizeContext(extraction.context ?? '')
      ? ['', '### Content', extraction.context!.trim()]
      : []),
  ].join('\n');
}

export function stripMarkdownFence(value: string): string {
  const match = value.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
  return (match?.[1] ?? value).trim();
}

function snapshotSections(lines: string[], context: string): Map<SnapshotSection, number> {
  const sections = new Map<SnapshotSection, number>();
  const validLabels = new Set<string>(SNAPSHOT_SECTION_ORDER);
  const addSection = (section: SnapshotSection, index: number) => {
    if (sections.has(section)) {
      throw new Error(`snapshot document contains duplicate ## ${section}`);
    }
    sections.set(section, index);
  };
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^##\s+(.+?)\s*$/.exec(lines[index] ?? '');
    const label = match?.[1]?.trim();
    if (!label) {
      continue;
    }
    if (!validLabels.has(label)) {
      throw new Error(`unsupported ${context} heading: ## ${label}`);
    }
    const section = label as SnapshotSection;
    if (section === 'Extractions') {
      addSection(section, index);
      break;
    }
    if (section === 'Skill Details') {
      addSection(section, index);
      const extractionsIndex = findSectionHeading(lines, index + 1, 'Extractions');
      if (extractionsIndex !== undefined) {
        addSection('Extractions', extractionsIndex);
      }
      break;
    }
    addSection(section, index);
  }
  return sections;
}

function findSectionHeading(
  lines: string[],
  start: number,
  label: SnapshotSection,
): number | undefined {
  const regex = new RegExp(`^##\\s+${escapeRegExp(label)}\\s*$`, 'i');
  const index = lines.findIndex((line, lineIndex) => lineIndex >= start && regex.test(line));
  return index >= 0 ? index : undefined;
}

function validateSnapshotSectionOrder(
  sections: Map<SnapshotSection, number>,
  context: string,
): void {
  for (let index = 0; index < SNAPSHOT_SECTION_ORDER.length; index += 1) {
    const left = SNAPSHOT_SECTION_ORDER[index]!;
    const leftIndex = sections.get(left);
    if (leftIndex === undefined) {
      continue;
    }
    for (let rightIndex = index + 1; rightIndex < SNAPSHOT_SECTION_ORDER.length; rightIndex += 1) {
      const right = SNAPSHOT_SECTION_ORDER[rightIndex]!;
      const position = sections.get(right);
      if (position !== undefined && leftIndex > position) {
        throw new Error(`${context} headings must order ## ${left} before ## ${right}`);
      }
    }
  }
}

function sectionBody(
  lines: string[],
  sections: Map<SnapshotSection, number>,
  section: SnapshotSection,
): string | undefined {
  const start = sections.get(section);
  if (start === undefined) {
    return undefined;
  }
  const end = [...sections.values()]
    .filter((index) => index > start)
    .sort((left, right) => left - right)[0] ?? lines.length;
  return lines.slice(start + 1, end).join('\n').trim();
}

function parseSignalBlocks(
  markdown: string,
  section: string,
  options: {
    validTurnIds?: ReadonlySet<string>;
    validExistingLabels?: ReadonlySet<string>;
  } = {},
): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      if (current.length > 0) {
        current.push('');
      }
      continue;
    }
    if (/^- \[[^\]]+\]\s+/.test(line)) {
      validateSignalLabelLine(line, section, options);
      pushSignalBlock(blocks, current);
      current = [line];
      continue;
    }
    if (/^\s+/.test(rawLine) && current.length > 0) {
      current.push(line);
      continue;
    }
    throw new Error(`## ${section} entries must be top-level signal cards`);
  }
  pushSignalBlock(blocks, current);
  return blocks;
}

function pushSignalBlock(blocks: string[], lines: string[]): void {
  const block = lines.join('\n').trim();
  if (block) {
    blocks.push(block);
  }
}

function renderSignalBlocks(signals: string[]): string {
  return signals.map((signal) => signal.trim()).filter(Boolean).join('\n');
}

function validateSkillSignals(skillSignals: string[]): void {
  for (const signal of skillSignals) {
    const match = /^- \[[^\]]+\]\s+([^:\n]+):\s+\S/.exec(signal.trim());
    if (!match) {
      throw new Error('## Skill Signals entries must start with a Skill name card');
    }
    if (!isValidSkillName(match[1]!)) {
      throw new Error(`invalid skill signal name: ${match[1]}`);
    }
  }
}

function validateSignalLabelLine(
  line: string,
  section: string,
  options: {
    validTurnIds?: ReadonlySet<string>;
    validExistingLabels?: ReadonlySet<string>;
  } = {},
): void {
  const labels = parseSignalLabelList(line);
  if (!labels || labels.length === 0) {
    throw new Error(`## ${section} entries must start with evidence labels`);
  }
  const seen = new Set<string>();
  for (const label of labels) {
    if (seen.has(label.turnId)) {
      throw new Error(`## ${section} signal repeats evidence turn id: ${label.turnId}`);
    }
    seen.add(label.turnId);
    if (
      options.validTurnIds
      && !options.validTurnIds.has(label.turnId)
      && !options.validExistingLabels?.has(signalLabelKey(label))
    ) {
      throw new Error(`## ${section} signal referenced unknown evidence turn id: ${label.turnId}`);
    }
  }
}

function parseSignalLabelList(line: string): Array<{ turnId: string; contribution: number }> | null {
  const match = /^- \[([^\]]+)\]\s+/.exec(line);
  if (!match) {
    return null;
  }
  const labels = match[1]!
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean);
  if (labels.length === 0) {
    return null;
  }
  const parsed: Array<{ turnId: string; contribution: number }> = [];
  for (const label of labels) {
    const labelMatch = /^(turn:[^\s,\]]+)\s+\+(1|10)$/.exec(label);
    if (!labelMatch) {
      throw new Error(`invalid signal evidence label: ${label}`);
    }
    parsed.push({
      turnId: labelMatch[1]!,
      contribution: Number(labelMatch[2]),
    });
  }
  return parsed;
}

function signalLabelKey(label: { turnId: string; contribution: number }): string {
  return `${label.turnId} +${label.contribution}`;
}

function parseSkillDetails(markdown: string): SkillDetails {
  return parseSkillDetailsEntries(markdown).skillDetails;
}

function parseSkillDetailsPatch(markdown: string): {
  skillDetails: SkillDetails;
  skillDetailsDeletes: string[];
} {
  return parseSkillDetailsEntries(markdown);
}

function parseSkillDetailsEntries(markdown: string): {
  skillDetails: SkillDetails;
  skillDetailsDeletes: string[];
} {
  const skillDetails: SkillDetails = {};
  const skillDetailsDeletes: string[] = [];
  const lines = markdown.split(/\r?\n/);
  let currentName: string | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (currentName === null) {
      return;
    }
    const body = currentLines.join('\n').trim();
    if (body) {
      skillDetails[currentName] = body;
    } else {
      skillDetailsDeletes.push(currentName);
    }
  };

  for (const line of lines) {
    const match = /^###\s+(.+?)\s*$/.exec(line);
    if (match) {
      flush();
      const name = match[1]!;
      if (!isValidSkillName(name)) {
        throw new Error(`invalid skill detail name: ${name}`);
      }
      if (
        Object.prototype.hasOwnProperty.call(skillDetails, name)
        || skillDetailsDeletes.includes(name)
      ) {
        throw new Error(`duplicate skill detail: ${name}`);
      }
      currentName = name;
      currentLines = [];
      continue;
    }
    if (/^###\s+/.test(line)) {
      throw new Error('## Skill Details headings must use ### Skill name');
    }
    if (currentName === null) {
      if (line.trim()) {
        throw new Error('## Skill Details content must be under ### Skill name headings');
      }
      continue;
    }
    currentLines.push(line);
  }
  flush();
  return { skillDetails, skillDetailsDeletes };
}

function renderSkillDetails(skillDetails: SkillDetails): string {
  const blocks = [];
  for (const [name, body] of Object.entries(skillDetails)) {
    if (!isValidSkillName(name)) {
      throw new Error(`invalid skill detail name: ${name}`);
    }
    blocks.push([
      `### ${name}`,
      body.trim(),
    ].join('\n').trimEnd());
  }
  return blocks.join('\n\n');
}

function validateSkillDetailsHaveSignals(
  skillDetails: SkillDetails,
  skillSignals: string[],
  context: string,
): void {
  const skillNames = skillNamesFromSignals(skillSignals);
  for (const name of Object.keys(skillDetails)) {
    if (!skillNames.has(name)) {
      throw new Error(`${context} ## Skill Details key lacks matching ## Skill Signals card: ${name}`);
    }
  }
}

function parsePatchUnits(
  extractionMarkdown: string,
  validReferences: Set<string>,
): {
  updates: ParsedSnapshotPatch['updates'];
  additions: ParsedSnapshotPatch['additions'];
} {
  const updates: ParsedSnapshotPatch['updates'] = [];
  const additions: ParsedSnapshotPatch['additions'] = [];
  if (!extractionMarkdown.trim()) {
    return { updates, additions };
  }

  for (const unit of splitUnits(extractionMarkdown)) {
    const lines = unit.split(/\r?\n/);
    const metadata = parseSnapshotContentMetadata(lines[0] ?? '');
    if (!metadata) {
      throw new Error('snapshot patch extraction must start with metadata comment');
    }
    validateSnapshotContentReferences(metadata.references, validReferences);
    const body = parseTitleSummaryContent(lines.slice(1));
    const record = {
      refs: metadata.references,
      title: body.title,
      summary: normalizeText(body.summary),
      content: normalizeContext(body.content ?? ''),
    };
    if (metadata.sequence === undefined) {
      additions.push(record);
    } else {
      updates.push({
        sequence: metadata.sequence,
        ...record,
      });
    }
  }
  return { updates, additions };
}

function parseTitleSummaryContent(lines: string[]): { title: string; summary: string; content?: string | null } {
  const titleIndex = headingIndex(lines, 3, 'Title');
  if (titleIndex === undefined) {
    throw new Error('snapshot unit must include ### Title');
  }
  const summaryIndex = headingIndex(lines, 3, 'Summary');
  if (summaryIndex === undefined) {
    throw new Error('snapshot unit must include ### Summary');
  }
  if (titleIndex > summaryIndex) {
    throw new Error('snapshot unit headings must order ### Title before ### Summary');
  }
  const contentIndex = headingIndex(lines, 3, 'Content');
  if (contentIndex !== undefined && contentIndex < summaryIndex) {
    throw new Error('snapshot unit headings must order ### Summary before ### Content');
  }
  const nextUnexpectedHeading = lines.find((line) => /^###\s+(.+?)\s*$/.test(line)
    && !/^###\s+(Title|Summary|Content)\s*$/i.test(line));
  if (nextUnexpectedHeading) {
    throw new Error(`unsupported snapshot unit heading: ${nextUnexpectedHeading.trim()}`);
  }

  const titleEnd = summaryIndex;
  const title = normalizeRequiredTitle(lines.slice(titleIndex + 1, titleEnd).join('\n'));
  const summaryEnd = contentIndex ?? lines.length;
  const summary = lines.slice(summaryIndex + 1, summaryEnd).join('\n').trim();
  if (!normalizeText(summary)) {
    throw new Error('snapshot unit summary cannot be empty');
  }
  const content = contentIndex === undefined
    ? null
    : lines.slice(contentIndex + 1).join('\n').trim() || null;
  return { title, summary, content };
}

function parseSnapshotContentMetadata(value: string): UnitMetadata | null {
  const match = value.match(/^\s*<!--\s*(.*?)\s*-->\s*$/);
  if (!match) {
    return null;
  }
  const body = match[1] ?? '';
  const refsMatch = body.match(/(?:^|;)\s*refs:\s*\[([^\]]*)\]\s*(?:;|$)/i);
  if (!refsMatch) {
    return null;
  }
  const sequenceMatch = body.match(/(?:^|;)\s*sequence:\s*([^;]+?)\s*(?:;|$)/i);
  const sequence = sequenceMatch ? Number(sequenceMatch[1]!.trim()) : undefined;
  if (sequence !== undefined && (!Number.isInteger(sequence) || sequence < 0)) {
    throw new Error(`invalid extraction sequence: ${sequenceMatch?.[1] ?? ''}`);
  }
  return {
    ...(sequence === undefined ? {} : { sequence }),
    references: parseSnapshotContentRefs(refsMatch[1]),
  };
}

function renderMetadata(value: UnitMetadata): string {
  const parts = [];
  if (value.sequence !== undefined) {
    parts.push(`sequence: ${value.sequence}`);
  }
  if (value.references.length > 0) {
    parts.push(`refs: [${value.references.join(', ')}]`);
  }
  return `<!-- ${parts.join('; ')} -->`;
}

function splitUnits(value: string): string[] {
  const units: string[] = [];
  let current: string[] = [];

  for (const line of value.split(/\r?\n/)) {
    if (/^\s*----\s*$/.test(line)) {
      pushCurrentUnit(units, current);
      current = [];
      continue;
    }

    if (current.length > 0 && isUnitMetadataLine(line)) {
      pushCurrentUnit(units, current);
      current = [line];
      continue;
    }

    current.push(line);
  }

  pushCurrentUnit(units, current);
  return units;
}

function pushCurrentUnit(units: string[], lines: string[]): void {
  const unit = lines.join('\n').trim();
  if (unit) {
    units.push(unit);
  }
}

function isUnitMetadataLine(line: string): boolean {
  try {
    return parseSnapshotContentMetadata(line) !== null;
  } catch {
    return false;
  }
}

function parseSnapshotContentRefs(value: string): string[] {
  const references = value
    .split(',')
    .map((reference) => reference.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  if (references.length === 0) {
    throw new Error('snapshot content metadata refs must include at least one reference');
  }
  return [...new Set(references)];
}

function validateSnapshotContentReferences(references: string[], validReferences: Set<string>): void {
  if (references.length === 0) {
    throw new Error('snapshot content metadata must include refs');
  }
  for (const reference of references) {
    if (!validReferences.has(reference)) {
      throw new Error(`snapshot content referenced unknown ref: ${reference}`);
    }
  }
}

function headingIndex(lines: string[], level: number, label: string): number | undefined {
  const hashes = '#'.repeat(level);
  const regex = new RegExp(`^${hashes}\\s+${escapeRegExp(label)}\\s*$`, 'i');
  const index = lines.findIndex((line) => regex.test(line));
  return index >= 0 ? index : undefined;
}

function parseRequiredTitle(lines: string[]): string {
  const title = parseOptionalTitle(lines);
  if (title === undefined) {
    throw new Error('snapshot content document must include # title');
  }
  return title;
}

function parseOptionalTitle(lines: string[]): string | undefined {
  const index = lines.findIndex((line) => /^#\s+(.+?)\s*$/.test(line));
  if (index < 0) {
    return undefined;
  }
  return normalizeRequiredTitle(lines[index]!.replace(/^#\s+/, ''));
}

function normalizeRequiredTitle(value: string): string {
  const title = normalizeText(value);
  if (!title) {
    throw new Error('snapshot title cannot be empty');
  }
  return title;
}

function normalizeText(value: string): string {
  return value.split(/\s+/).join(' ').trim();
}

function rejectJson(value: string): void {
  if (/^\s*\{/.test(value)) {
    throw new Error('extraction result must return snapshot content Markdown, not JSON');
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeContext(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}
