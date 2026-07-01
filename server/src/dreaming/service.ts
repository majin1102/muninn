import type { ProjectDreamProjectView } from '@muninn/common';
import type {
  DreamingRow,
  DreamingSupportTurn,
  NativeTables,
  SessionSnapshotRow,
  SourceRows,
} from '../native.js';
import {
  dreamingIdFromSignalId,
  parseProjectDreamOutput,
  parseProjectDreamSignals,
  parseDreamingRow,
  rankProjectSignalRows,
  signalIdFromDreamingId,
  turnLabelKey,
  validateProjectSignalContent,
  type ProjectDreamSignals,
  type ProjectSignalBlock,
  type ProjectSignalLabel,
  type ProjectSignalKind,
} from './content.js';
import { mergeProjectDream } from './project-dreamer.js';

export type ProjectDreamCreateResult = {
  created: boolean;
  rows: DreamingRow[];
};

type Evidence = DreamingSupportTurn;

export type DreamingWatermark = {
  project: string;
  sessionSnapshotVersion: number;
};

export type DreamingWatermarkStore = {
  list(): DreamingWatermark[];
  get(project: string): Omit<DreamingWatermark, 'project'> | null;
  set(project: string, sessionSnapshotVersion: number): void;
};

const MEMORY_BUDGET = 100;
const MEMORY_RECENT = 20;
const SKILL_BUDGET = 50;
const SKILL_RECENT = 10;

export class ProjectDreamingService {
  private readonly creates = new Map<string, Promise<ProjectDreamCreateResult>>();
  private readonly fallbackWatermarks = createInMemoryWatermarks();

  constructor(
    private readonly client: NativeTables,
    private readonly extractorName: string | null,
    private readonly deps: {
      merge?: typeof mergeProjectDream;
      now?: () => Date;
      watermarks?: DreamingWatermarkStore;
    } = {},
  ) {}

  async latest(project: string): Promise<DreamingRow | null> {
    const rows = await this.projectRows(project);
    return rows.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  }

  async projects(): Promise<ProjectDreamProjectView[]> {
    const rows = await this.client.dreamingTable.list();
    const rowProjects = new Set(rows.map((row) => row.project));
    const latestRowUpdate = new Map<string, string>();
    for (const row of rows) {
      const current = latestRowUpdate.get(row.project);
      if (!current || row.updatedAt > current) {
        latestRowUpdate.set(row.project, row.updatedAt);
      }
    }
    return [...rowProjects]
      .sort((left, right) => left.localeCompare(right))
      .map((project) => ({
        project,
        latestUpdatedAt: latestRowUpdate.get(project)
          ?? new Date(0).toISOString(),
      }));
  }

  async signals(project: string, limit = 5): Promise<ProjectDreamSignals | null> {
    const rows = await this.projectRows(project);
    return rows.length > 0 ? parseProjectDreamSignals(rows, limit, this.now()) : null;
  }

  async projectsWithSignals(): Promise<string[]> {
    if (!this.extractorName) {
      return [];
    }
    const source = await this.client.sessionTable.listSnapshotsWithVersion({ extractor: this.extractorName });
    const projects = new Set<string>();
    for (const row of source.rows) {
      if (hasSignalState(row)) {
        projects.add(row.project);
      }
    }
    return [...projects].sort((left, right) => left.localeCompare(right));
  }

  async create(project: string): Promise<ProjectDreamCreateResult> {
    const previous = this.creates.get(project) ?? Promise.resolve(null);
    const next = previous
      .catch(() => null)
      .then(() => this.createNow(project));
    this.creates.set(project, next);
    try {
      return await next;
    } finally {
      if (this.creates.get(project) === next) {
        this.creates.delete(project);
      }
    }
  }

  private async createNow(project: string): Promise<ProjectDreamCreateResult> {
    if (!this.extractorName) {
      throw new Error('extractor is not configured');
    }

    const watermark = this.watermarks().get(project);
    const existingRows = await this.projectRows(project);
    const source = watermark
      ? await this.client.sessionTable.delta({
        extractor: this.extractorName,
        baselineVersion: watermark.sessionSnapshotVersion,
      })
      : await this.client.sessionTable.listSnapshotsWithVersion({ extractor: this.extractorName });
    const baseline = watermark
      ? await this.client.sessionTable.listSnapshotsWithVersion({
        extractor: this.extractorName,
        version: watermark.sessionSnapshotVersion,
      })
      : { sourceVersion: 0, rows: [] };
    const selected = selectedSignals(source, project);
    const baselineBySession = latestSignalsBySession(baseline, project);
    const evidence = new Map<string, Evidence>();
    const incrementalSignals = await renderIncrementalSignals({
      client: this.client,
      rows: selected,
      baselineBySession,
      evidence,
    });
    const now = this.now().toISOString();

    if (!incrementalSignals.trim()) {
      if (watermark && source.sourceVersion > watermark.sessionSnapshotVersion) {
        this.watermarks().set(project, source.sourceVersion);
      }
      return { created: false, rows: existingRows };
    }

    const existingProjectSignals = renderExistingProjectSignals(existingRows);
    const labels = {
      signalLabels: existingRows.map((row) => signalIdFromDreamingId(row.dreamingId)),
      turnLabels: [...evidence.keys()],
    };
    const merge = this.deps.merge ?? mergeProjectDream;
    const content = await merge({
      project,
      existingProjectSignals,
      incrementalSessionSignals: incrementalSignals,
      labels,
    });
    const blocks = parseProjectDreamOutput(content, labels);
    const nextRows = await this.replaceProjectRows({
      project,
      existingRows,
      blocks,
      evidence,
      now,
    });
    const trimmedRows = await this.enforceBudgets(project, nextRows);
    this.watermarks().set(project, source.sourceVersion);
    return { created: true, rows: trimmedRows };
  }

  private async replaceProjectRows(params: {
    project: string;
    existingRows: DreamingRow[];
    blocks: ProjectSignalBlock[];
    evidence: Map<string, Evidence>;
    now: string;
  }): Promise<DreamingRow[]> {
    const existingBySignal = new Map(
      params.existingRows.map((row) => [signalIdFromDreamingId(row.dreamingId), row]),
    );
    const rows: DreamingRow[] = [];
    const kept = new Set<string>();
    for (const block of params.blocks) {
      const existingLabels = block.labels.filter((label) => label.type === 'signal') as Array<
        Extract<ProjectSignalLabel, { type: 'signal' }>
      >;
      const survivor = existingLabels[0]?.signalId;
      const survivorRow = survivor ? existingBySignal.get(survivor) : undefined;
      const supportTurns = mergeSupportTurns([
        ...existingLabels.flatMap((label) => existingBySignal.get(label.signalId)?.supportTurns ?? []),
        ...block.labels
          .filter((label) => label.type === 'turn')
          .map((label) => params.evidence.get(turnLabelKey(label as Extract<ProjectSignalLabel, { type: 'turn' }>)))
          .filter((value): value is Evidence => Boolean(value)),
      ]);
      const row: DreamingRow = {
        dreamingId: survivorRow?.dreamingId ?? 'dreaming:18446744073709551615',
        project: params.project,
        createdAt: survivorRow?.createdAt ?? params.now,
        updatedAt: params.now,
        content: block.content,
        supportTurns,
      };
      validateProjectSignalContent(row.content);
      const stored = survivorRow
        ? await this.client.dreamingTable.update({ row })
        : await this.client.dreamingTable.append({ row });
      kept.add(stored.dreamingId);
      rows.push(stored);
    }
    const deleteIds = params.existingRows
      .filter((row) => !kept.has(row.dreamingId))
      .map((row) => row.dreamingId);
    if (deleteIds.length > 0) {
      await this.client.dreamingTable.delete({ dreamingIds: deleteIds });
    }
    return rows;
  }

  private async enforceBudgets(project: string, rows: DreamingRow[]): Promise<DreamingRow[]> {
    const keep = new Set<string>();
    keepBudget(rows, 'memory', MEMORY_RECENT, MEMORY_BUDGET, keep, this.now());
    keepBudget(rows, 'skill', SKILL_RECENT, SKILL_BUDGET, keep, this.now());
    const deleteIds = rows
      .filter((row) => !keep.has(row.dreamingId))
      .map((row) => row.dreamingId);
    if (deleteIds.length > 0) {
      await this.client.dreamingTable.delete({ dreamingIds: deleteIds });
    }
    return rows.filter((row) => row.project === project && keep.has(row.dreamingId));
  }

  private async projectRows(project: string): Promise<DreamingRow[]> {
    return (await this.client.dreamingTable.list())
      .filter((row) => row.project === project);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private watermarks(): DreamingWatermarkStore {
    return this.deps.watermarks ?? this.fallbackWatermarks;
  }
}

function createInMemoryWatermarks(): DreamingWatermarkStore {
  const projects = new Map<string, { sessionSnapshotVersion: number }>();
  return {
    list: () => [...projects.entries()].map(([project, value]) => ({ project, ...value })),
    get: (project) => projects.get(project) ?? null,
    set: (project, sessionSnapshotVersion) => {
      projects.set(project, { sessionSnapshotVersion });
    },
  };
}

function selectedSignals(source: SourceRows<SessionSnapshotRow>, project: string): SessionSnapshotRow[] {
  const latest = new Map<string, SessionSnapshotRow>();
  for (const row of source.rows) {
    if (row.project !== project || !hasSignalState(row)) {
      continue;
    }
    const key = dreamSessionKey(row);
    const current = latest.get(key);
    if (!current || compareSnapshots(row, current) > 0) {
      latest.set(key, row);
    }
  }
  return [...latest.values()].sort((left, right) => compareSourceOrder(left, right));
}

function hasSignalState(row: SessionSnapshotRow): boolean {
  return row.memorySignals.length > 0 || row.skillSignals.length > 0;
}

async function renderIncrementalSignals(params: {
  client: NativeTables;
  rows: SessionSnapshotRow[];
  baselineBySession: Map<string, SessionSnapshotRow>;
  evidence: Map<string, Evidence>;
}): Promise<string> {
  const blocks: string[] = [];
  for (const row of params.rows) {
    const skillDetails = parseSkillDetailsJson(row.skillDetails);
    const baselineEvidence = snapshotEvidenceContributionsBySignal(params.baselineBySession.get(dreamSessionKey(row)));
    for (const signal of row.memorySignals) {
      const block = await renderMemorySignalBlock(signal, row, baselineEvidence, params);
      if (block) {
        blocks.push(block);
      }
    }
    for (const signal of row.skillSignals) {
      const block = await renderSkillSignalBlock(signal, row, skillDetails, baselineEvidence, params);
      if (block) {
        blocks.push(block);
      }
    }
  }
  return blocks.join('\n\n');
}

async function renderMemorySignalBlock(
  signal: string,
  row: SessionSnapshotRow,
  baselineEvidence: Map<string, Map<string, number>>,
  params: {
    client: NativeTables;
    evidence: Map<string, Evidence>;
  },
): Promise<string | null> {
  const parsed = parseSnapshotSignalLine(signal);
  if (!parsed) {
    return null;
  }
  const labels = await collectNewEvidenceLabels(parsed.labels, row, baselineEvidence.get(memorySignalKey(parsed.body)) ?? new Map(), params);
  if (labels.length === 0) {
    return null;
  }
  return [
    `[${labels.join(', ')}]`,
    '## Instruction Signal',
    parsed.body,
  ].join('\n');
}

async function renderSkillSignalBlock(
  signal: string,
  row: SessionSnapshotRow,
  skillDetails: Record<string, string>,
  baselineEvidence: Map<string, Map<string, number>>,
  params: {
    client: NativeTables;
    evidence: Map<string, Evidence>;
  },
): Promise<string | null> {
  const parsed = parseSnapshotSkillSignalLine(signal);
  if (!parsed) {
    return null;
  }
  const labels = await collectNewEvidenceLabels(
    parsed.labels,
    row,
    baselineEvidence.get(skillSignalKey(parsed.skillName, parsed.summary)) ?? new Map(),
    params,
  );
  if (labels.length === 0) {
    return null;
  }
  const detail = skillDetails[parsed.skillName]?.trim();
  return [
    `[${labels.join(', ')}]`,
    '## Skill Signal',
    `### ${parsed.skillName}`,
    '',
    parsed.summary,
    ...(detail ? ['', detail] : []),
  ].join('\n');
}

async function collectNewEvidenceLabels(
  labels: Array<{ turnId: string; contribution: number }>,
  row: SessionSnapshotRow,
  baselineEvidence: Map<string, number>,
  params: {
    client: NativeTables;
    evidence: Map<string, Evidence>;
  },
): Promise<string[]> {
  const kept: string[] = [];
  for (const label of labels) {
    if ((baselineEvidence.get(label.turnId) ?? 0) >= label.contribution) {
      continue;
    }
    const key = `${label.turnId} +${label.contribution}`;
    if (!params.evidence.has(key)) {
      const turn = await params.client.turnTable.getTurn(label.turnId);
      params.evidence.set(key, {
        turnId: label.turnId,
        createdAt: turn?.createdAt ?? row.updatedAt,
        contribution: label.contribution,
      });
    }
    kept.push(key);
  }
  return kept;
}

function renderExistingProjectSignals(rows: DreamingRow[]): string {
  return rows
    .map((row) => [
      `[${signalIdFromDreamingId(row.dreamingId)}]`,
      row.content.trim(),
    ].join('\n'))
    .join('\n\n');
}

function parseSnapshotSignalLine(line: string): {
  labels: Array<{ turnId: string; contribution: number }>;
  body: string;
} | null {
  const match = /^- \[([^\]]+)\]\s+(.+)$/.exec(line.trim());
  if (!match) {
    return null;
  }
  return {
    labels: parseEvidenceLabels(match[1]!),
    body: match[2]!.trim(),
  };
}

function parseSnapshotSkillSignalLine(line: string): {
  labels: Array<{ turnId: string; contribution: number }>;
  skillName: string;
  summary: string;
} | null {
  const parsed = parseSnapshotSignalLine(line);
  if (!parsed) {
    return null;
  }
  const match = /^([^:\n]+):\s+(.+)$/.exec(parsed.body);
  if (!match) {
    return null;
  }
  return {
    labels: parsed.labels,
    skillName: match[1]!.trim(),
    summary: match[2]!.trim(),
  };
}

function parseEvidenceLabels(value: string): Array<{ turnId: string; contribution: number }> {
  return value
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean)
    .map((label) => {
      const match = /^(turn:[^\s,\]]+)\s+\+(1|10)$/.exec(label);
      if (!match) {
        throw new Error(`invalid signal evidence label: ${label}`);
      }
      return {
        turnId: match[1]!,
        contribution: Number(match[2]),
      };
    });
}

function parseSkillDetailsJson(value: unknown): Record<string, string> {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== 'string') {
    throw new Error('session snapshot skillDetails must be a string');
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`invalid session snapshot skillDetails JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('session snapshot skillDetails JSON must be an object');
  }
  const details: Record<string, string> = {};
  for (const [key, detail] of Object.entries(parsed)) {
    if (typeof detail !== 'string') {
      throw new Error(`session snapshot skillDetails value must be a string: ${key}`);
    }
    details[key] = detail;
  }
  return details;
}

function mergeSupportTurns(values: DreamingSupportTurn[]): DreamingSupportTurn[] {
  const byTurn = new Map<string, DreamingSupportTurn>();
  for (const value of values) {
    const current = byTurn.get(value.turnId);
    if (!current || value.contribution > current.contribution) {
      byTurn.set(value.turnId, value);
    }
  }
  return [...byTurn.values()].sort((left, right) => (
    left.createdAt.localeCompare(right.createdAt)
    || left.turnId.localeCompare(right.turnId)
  ));
}

function latestSignalsBySession(source: SourceRows<SessionSnapshotRow>, project: string): Map<string, SessionSnapshotRow> {
  return new Map(selectedSignals(source, project).map((row) => [dreamSessionKey(row), row]));
}

function snapshotEvidenceContributionsBySignal(row: SessionSnapshotRow | undefined): Map<string, Map<string, number>> {
  if (!row) {
    return new Map();
  }
  const contributions = new Map<string, Map<string, number>>();
  for (const signal of row.memorySignals) {
    const parsed = parseSnapshotSignalLine(signal);
    if (!parsed) {
      continue;
    }
    addEvidenceContributions(contributions, memorySignalKey(parsed.body), parsed.labels);
  }
  for (const signal of row.skillSignals) {
    const parsed = parseSnapshotSkillSignalLine(signal);
    if (!parsed) {
      continue;
    }
    addEvidenceContributions(contributions, skillSignalKey(parsed.skillName, parsed.summary), parsed.labels);
  }
  return contributions;
}

function addEvidenceContributions(
  contributions: Map<string, Map<string, number>>,
  signalKey: string,
  labels: Array<{ turnId: string; contribution: number }>,
): void {
  const signalContributions = contributions.get(signalKey) ?? new Map<string, number>();
  for (const label of labels) {
    signalContributions.set(
      label.turnId,
      Math.max(signalContributions.get(label.turnId) ?? 0, label.contribution),
    );
  }
  contributions.set(signalKey, signalContributions);
}

function memorySignalKey(body: string): string {
  return `memory:${body}`;
}

function skillSignalKey(skillName: string, summary: string): string {
  return `skill:${skillName}:${summary}`;
}

function keepBudget(
  rows: DreamingRow[],
  kind: ProjectSignalKind,
  recentQuota: number,
  budget: number,
  keep: Set<string>,
  now: Date,
): void {
  const parsed = rows
    .map((row) => parseDreamingRow(row, now))
    .filter((row) => row.kind === kind);
  const recent = [...parsed]
    .sort((left, right) => (
      compareNullableIsoDesc(left.lastSupportedAt, right.lastSupportedAt)
      || right.score - left.score
      || compareSignalRowId(left.row.dreamingId, right.row.dreamingId)
    ))
    .slice(0, recentQuota);
  for (const row of recent) {
    keep.add(row.row.dreamingId);
  }
  const remainingBudget = Math.max(0, budget - recent.length);
  for (const row of rankProjectSignalRows(
    parsed
      .filter((row) => !keep.has(row.row.dreamingId))
      .map((row) => row.row),
    now,
  ).slice(0, remainingBudget)) {
    keep.add(row.row.dreamingId);
  }
}

function compareSnapshots(left: SessionSnapshotRow, right: SessionSnapshotRow): number {
  return left.snapshotSequence - right.snapshotSequence
    || left.updatedAt.localeCompare(right.updatedAt)
    || Number(rowId(left.snapshotId) - rowId(right.snapshotId));
}

function compareSourceOrder(left: SessionSnapshotRow, right: SessionSnapshotRow): number {
  return left.updatedAt.localeCompare(right.updatedAt)
    || Number(rowId(left.snapshotId) - rowId(right.snapshotId));
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

function compareSignalRowId(left: string, right: string): number {
  return Number(rowId(left) - rowId(right));
}

function rowId(id: string): bigint {
  const match = /:(\d+)$/.exec(id);
  return BigInt(match?.[1] ?? '0');
}

function dreamSessionKey(value: {
  sessionId: string;
  agent: string;
  project: string;
  cwd: string;
}): string {
  return [value.project, value.agent, value.sessionId, value.cwd].join('\u001f');
}

export const __testing = {
  dreamingIdFromSignalId,
  renderExistingProjectSignals,
  selectedSignals,
};
