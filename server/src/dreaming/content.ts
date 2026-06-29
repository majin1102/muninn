import type { DreamingRow, DreamingSupportTurn } from '../native.js';

export type ProjectSignalKind = 'memory' | 'skill';

export type ProjectSignalLabel =
  | { type: 'signal'; signalId: string }
  | { type: 'turn'; turnId: string; contribution: number };

export type ProjectSignalBlock = {
  labels: ProjectSignalLabel[];
  kind: ProjectSignalKind;
  content: string;
  skillName?: string;
};

export type ProjectSignalView = {
  row: DreamingRow;
  kind: ProjectSignalKind;
  score: number;
  lastSupportedAt: string | null;
  text?: string;
  name?: string;
  summary?: string;
  detail?: string;
};

export type ProjectDreamSignals = {
  project: string;
  memorySignals: Array<{
    score: number;
    text: string;
    updatedAt: string | null;
    supportTurns: Array<{
      turnId: string;
      createdAt: string;
      contribution: number;
      score: number;
    }>;
  }>;
  skillSignals: Array<{ score: number; name: string; summary: string; detail: string }>;
};

const HALF_LIFE_DAYS = 90;
const SIGNAL_LABEL_PATTERN = /^signal:(?:0|[1-9]\d*)$/;
const TURN_LABEL_PATTERN = /^(turn:(?:0|[1-9]\d*)) \+(1|10)$/;

export function validateProjectSignalContent(content: string): void {
  parseProjectSignalContent(content);
}

export function parseProjectSignalContent(content: string): Omit<ProjectSignalBlock, 'labels'> {
  const text = stripFence(content).trim();
  if (!text) {
    throw new Error('project signal content must not be empty');
  }
  if (/^# Project Dream:/m.test(text) || /^# Project Signals/m.test(text)) {
    throw new Error('project signal row content must not include project dream document headings');
  }
  if (/^## Open Questions\b/m.test(text)) {
    throw new Error('project signal content must not include ## Open Questions');
  }
  if (hasUnsupportedMetadata(text)) {
    throw new Error('project signal content must not include provenance refs, session ids, or metadata comments');
  }
  if (/^- \[\d+\]\s+/m.test(text)) {
    throw new Error('project signal content must not use old [N] weight markers');
  }

  const lines = text.split(/\r?\n/);
  const heading = lines[0]?.trim();
  if (heading === '## Instruction Signal') {
    const body = lines.slice(1).join('\n').trim();
    if (!body) {
      throw new Error('Instruction Signal content must not be empty');
    }
    if (/^##\s+/m.test(body)) {
      throw new Error('Instruction Signal content must contain one signal, not nested sections');
    }
    return {
      kind: 'memory',
      content: ['## Instruction Signal', body].join('\n'),
    };
  }

  if (heading !== '## Skill Signal') {
    throw new Error('project signal content must start with ## Instruction Signal or ## Skill Signal');
  }
  const skillHeadingIndex = lines.findIndex((line, index) => index > 0 && line.trim().length > 0);
  if (skillHeadingIndex < 0 || !/^###\s+(.+?)\s*$/.test(lines[skillHeadingIndex]!)) {
    throw new Error('Skill Signal content must include a ### <skill name> heading');
  }
  const skillName = lines[skillHeadingIndex]!.replace(/^###\s+/, '').trim();
  if (!isValidSkillName(skillName)) {
    throw new Error(`invalid skill signal name: ${skillName}`);
  }
  const body = lines.slice(1).join('\n').trim();
  return {
    kind: 'skill',
    content: ['## Skill Signal', body].join('\n'),
    skillName,
  };
}

export function validateProjectDreamContent(content: string, labels?: ProjectDreamLabelSet): void {
  parseProjectDreamOutput(content, labels);
}

export function normalizeProjectDreamContent(content: string, labels?: ProjectDreamLabelSet): string {
  const text = stripFence(content).trim();
  parseProjectDreamOutput(text, labels);
  return text;
}

export type ProjectDreamLabelSet = {
  signalLabels?: Iterable<string>;
  turnLabels?: Iterable<string>;
};

export function parseProjectDreamOutput(
  content: string,
  labels: ProjectDreamLabelSet = {},
): ProjectSignalBlock[] {
  const text = stripFence(content).trim();
  const lines = text.split(/\r?\n/);
  const title = lines[0]?.trim();
  if (title !== '# Project Signals') {
    if (title?.startsWith('# Project Dream:')) {
      throw new Error('project dreamer output must start with # Project Signals, not # Project Dream');
    }
    throw new Error('project dreamer output must start with # Project Signals');
  }
  if (/^## Open Questions\b/m.test(text)) {
    throw new Error('project dreamer output must not include ## Open Questions');
  }
  if (/^- \[\d+\]\s+/m.test(text)) {
    throw new Error('project dreamer output must not use old [N] weight markers');
  }
  if (hasUnsupportedMetadataOutsideLabelLines(text)) {
    throw new Error('project dreamer output must not include provenance refs, session ids, or metadata comments');
  }

  const allowedSignalLabels = new Set(labels.signalLabels ?? []);
  const allowedTurnLabels = new Set(labels.turnLabels ?? []);
  const enforceLabels = labels.signalLabels !== undefined || labels.turnLabels !== undefined;
  const blocks: ProjectSignalBlock[] = [];
  let index = 1;
  while (index < lines.length) {
    while (index < lines.length && !lines[index]!.trim()) {
      index += 1;
    }
    if (index >= lines.length) {
      break;
    }
    const labelLine = lines[index]!.trim();
    if (!/^\[.+\]$/.test(labelLine)) {
      throw new Error('every project signal block must start with one label list');
    }
    const rawLabels = parseLabelList(labelLine);
    if (!enforceLabels && rawLabels.some(isUnknownSignalLabel)) {
      throw new Error('invalid project signal label');
    }
    const blockLines: string[] = [];
    index += 1;
    while (index < lines.length && !/^\[.+\]$/.test(lines[index]!.trim())) {
      blockLines.push(lines[index]!);
      index += 1;
    }
    const filteredLabels = rawLabels.filter((label) => {
      if (label.type === 'signal') {
        return !enforceLabels || allowedSignalLabels.has(label.signalId);
      }
      return !enforceLabels || allowedTurnLabels.has(turnLabelKey(label));
    });
    if (filteredLabels.length === 0) {
      throw new Error('project signal block must contain at least one valid label');
    }
    validateUniqueTurnLabels(filteredLabels);
    const parsed = parseProjectSignalContent(blockLines.join('\n'));
    blocks.push({
      labels: filteredLabels,
      ...parsed,
    });
  }

  validateUniqueSurvivors(blocks);
  validateUniqueSignalContent(blocks);
  validateUniqueSkillNames(blocks);
  return blocks;
}

export function parseProjectDreamSignals(
  rows: DreamingRow[],
  limit = 5,
  now: Date = new Date(),
): ProjectDreamSignals {
  const ranked = rankProjectSignalRows(rows, now);
  const memorySignals = ranked
    .filter((row) => row.kind === 'memory')
    .slice(0, Math.max(0, limit))
    .map((row) => ({
      score: row.score,
      text: row.text ?? '',
      updatedAt: row.lastSupportedAt,
      supportTurns: supportTurnViews(row.row, now),
    }));
  const skillSignals = ranked
    .filter((row) => row.kind === 'skill')
    .slice(0, Math.max(0, limit))
    .map((row) => ({
      score: row.score,
      name: row.name ?? '',
      summary: row.summary ?? '',
      detail: row.detail ?? '',
    }));
  return {
    project: rows[0]?.project ?? '',
    memorySignals,
    skillSignals,
  };
}

export function rankProjectSignalRows(
  rows: DreamingRow[],
  now: Date = new Date(),
): ProjectSignalView[] {
  return rows
    .map((row) => parseDreamingRow(row, now))
    .sort(compareProjectSignalViews);
}

export function parseDreamingRow(row: DreamingRow, now: Date = new Date()): ProjectSignalView {
  const parsed = parseProjectSignalContent(row.content);
  const score = calculateProjectSignalScore(row, now);
  const lastSupportedAt = latestSupportAt(row);
  if (parsed.kind === 'memory') {
    return {
      row,
      kind: 'memory',
      score,
      lastSupportedAt,
      text: parsed.content.replace(/^## Instruction Signal\s*/, '').trim(),
    };
  }
  const detail = parsed.content
    .replace(/^## Skill Signal\s*/, '')
    .replace(new RegExp(`^###\\s+${escapeRegExp(parsed.skillName ?? '')}\\s*`), '')
    .trim();
  const summary = detail.split(/\n\s*\n/)[0]?.trim() ?? '';
  return {
    row,
    kind: 'skill',
    score,
    lastSupportedAt,
    name: parsed.skillName ?? '',
    summary,
    detail,
  };
}

export function calculateProjectSignalScore(row: DreamingRow, now: Date = new Date()): number {
  let score = 0;
  for (const support of row.supportTurns ?? []) {
    score += calculateSupportTurnScore(support, now);
  }
  return score;
}

export function calculateSupportTurnScore(
  support: DreamingSupportTurn,
  now: Date = new Date(),
): number {
  const contribution = Number(support.contribution);
  if (!Number.isFinite(contribution) || contribution <= 0) {
    return 0;
  }
  if (contribution >= 10) {
    return contribution;
  }
  const createdMs = Date.parse(support.createdAt);
  if (!Number.isFinite(createdMs)) {
    return contribution;
  }
  const ageDays = Math.max(0, (now.getTime() - createdMs) / 86_400_000);
  return contribution * (0.5 ** (ageDays / HALF_LIFE_DAYS));
}

function supportTurnViews(row: DreamingRow, now: Date) {
  return [...(row.supportTurns ?? [])]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.turnId.localeCompare(right.turnId))
    .map((support) => ({
      turnId: support.turnId,
      createdAt: support.createdAt,
      contribution: support.contribution,
      score: calculateSupportTurnScore(support, now),
    }));
}

export function latestSupportAt(row: DreamingRow): string | null {
  let latest: string | null = null;
  for (const support of row.supportTurns ?? []) {
    if (!latest || support.createdAt > latest) {
      latest = support.createdAt;
    }
  }
  return latest;
}

export function turnLabelKey(label: Extract<ProjectSignalLabel, { type: 'turn' }>): string {
  return `${label.turnId} +${label.contribution}`;
}

export function signalIdFromDreamingId(dreamingId: string): string {
  const match = /^dreaming:(0|[1-9]\d*)$/.exec(dreamingId);
  if (!match) {
    throw new Error(`invalid dreaming id: ${dreamingId}`);
  }
  return `signal:${match[1]}`;
}

export function dreamingIdFromSignalId(signalId: string): string {
  const match = /^signal:(0|[1-9]\d*)$/.exec(signalId);
  if (!match) {
    throw new Error(`invalid project signal id: ${signalId}`);
  }
  return `dreaming:${match[1]}`;
}

function parseLabelList(labelLine: string): ProjectSignalLabel[] {
  const inner = labelLine.slice(1, -1).trim();
  if (!inner) {
    throw new Error('project signal label list must not be empty');
  }
  return inner.split(',').map((part) => parseLabel(part.trim()));
}

function parseLabel(value: string): ProjectSignalLabel {
  if (SIGNAL_LABEL_PATTERN.test(value)) {
    return { type: 'signal', signalId: value };
  }
  const turn = TURN_LABEL_PATTERN.exec(value);
  if (turn) {
    return { type: 'turn', turnId: turn[1]!, contribution: Number(turn[2]) };
  }
  if (/^\d+$/.test(value)) {
    throw new Error('project signal labels must not use old [N] weight markers');
  }
  return { type: 'signal', signalId: `unknown:${value}` };
}

function validateUniqueTurnLabels(labels: ProjectSignalLabel[]): void {
  const seen = new Set<string>();
  for (const label of labels) {
    if (label.type !== 'turn') {
      continue;
    }
    if (seen.has(label.turnId)) {
      throw new Error(`duplicate turn evidence label in one signal: ${label.turnId}`);
    }
    seen.add(label.turnId);
  }
}

function isUnknownSignalLabel(label: ProjectSignalLabel): boolean {
  return label.type === 'signal' && label.signalId.startsWith('unknown:');
}

function validateUniqueSurvivors(blocks: ProjectSignalBlock[]): void {
  const seen = new Set<string>();
  for (const block of blocks) {
    const survivor = block.labels.find((label) => label.type === 'signal') as
      | Extract<ProjectSignalLabel, { type: 'signal' }>
      | undefined;
    if (!survivor) {
      continue;
    }
    if (seen.has(survivor.signalId)) {
      throw new Error(`duplicate survivor project signal label: ${survivor.signalId}`);
    }
    seen.add(survivor.signalId);
  }
}

function validateUniqueSignalContent(blocks: ProjectSignalBlock[]): void {
  const seen = new Set<string>();
  for (const block of blocks) {
    const key = `${block.kind}\u0000${block.content.trim()}`;
    if (seen.has(key)) {
      throw new Error('duplicate project signal content');
    }
    seen.add(key);
  }
}

function validateUniqueSkillNames(blocks: ProjectSignalBlock[]): void {
  const seen = new Set<string>();
  for (const block of blocks) {
    if (block.kind !== 'skill' || !block.skillName) {
      continue;
    }
    if (seen.has(block.skillName)) {
      throw new Error(`duplicate Skill Signal name: ${block.skillName}`);
    }
    seen.add(block.skillName);
  }
}

function compareProjectSignalViews(left: ProjectSignalView, right: ProjectSignalView): number {
  return right.score - left.score
    || compareNullableIsoDesc(left.lastSupportedAt, right.lastSupportedAt)
    || compareRowIdAsc(left.row.dreamingId, right.row.dreamingId);
}

function compareNullableIsoDesc(left: string | null, right: string | null): number {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  return right.localeCompare(left);
}

function compareRowIdAsc(left: string, right: string): number {
  try {
    return Number(BigInt(rowPoint(left)) - BigInt(rowPoint(right)));
  } catch {
    return left.localeCompare(right);
  }
}

function rowPoint(id: string): string {
  return id.split(':').at(-1) ?? '0';
}

function stripFence(content: string): string {
  const trimmed = content.trim();
  const match = /^```(?:markdown|md)?\n([\s\S]*?)\n```$/i.exec(trimmed);
  return match ? match[1] : trimmed;
}

function hasUnsupportedMetadata(text: string): boolean {
  return /<!--[\s\S]*?-->/.test(text)
    || /\brefs?\s*:/.test(text)
    || /\bsession:(?:0|[1-9]\d*)\b/.test(text)
    || /\bturn:(?:0|[1-9]\d*)\b/.test(text);
}

function hasUnsupportedMetadataOutsideLabelLines(text: string): boolean {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\[.+\]$/.test(line.trim()))
    .some((line) => hasUnsupportedMetadata(line));
}

function isValidSkillName(value: string): boolean {
  return value.trim() === value && value.length > 0 && !/[`:\r\n]/.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
