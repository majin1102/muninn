import type {
  StartupRecentResponse,
  StartupRecentSession,
  StartupRecentSkill,
} from '@muninn/common';
import { dreaming, sessions, turns } from './backend.js';
import type { ProjectDreamSignals } from './dreaming/content.js';
import type { SessionSnapshotRow, TurnRow } from './native.js';

const SESSION_LIMIT = 5;
const INSTRUCTION_LIMIT = 20;
const RECENT_INSTRUCTION_LIMIT = 7;
const SKILL_LIMIT = 10;
const RECENT_SKILL_LIMIT = 3;
const PROJECT_CANDIDATE_LIMIT = INSTRUCTION_LIMIT + RECENT_INSTRUCTION_LIMIT;

type SessionIndexItem = {
  project: string;
  latestUpdatedAt: string;
  snapshotId?: string;
};

export type StartupContextDeps = {
  listSessionIndex(): Promise<SessionIndexItem[]>;
  getSession(snapshotId: string): Promise<SessionSnapshotRow | null>;
  getTurn(turnId: string): Promise<TurnRow | null>;
  getProjectSignals(project: string, limit: number): Promise<ProjectDreamSignals | null>;
};

type RecentInstruction = {
  text: string;
  supportedAt: string;
  key: string;
};

type RecentSkill = StartupRecentSkill & {
  supportedAt: string;
  key: string;
};

const defaultDeps: StartupContextDeps = {
  listSessionIndex: () => sessions.index(),
  getSession: (snapshotId) => sessions.getSnapshot(snapshotId),
  getTurn: (turnId) => turns.get(turnId),
  getProjectSignals: (project, limit) => dreaming.getProjectSignals(project, undefined, limit),
};

export async function buildStartupRecent(
  project: string,
  deps: StartupContextDeps = defaultDeps,
): Promise<StartupRecentResponse> {
  const snapshots = await recentSnapshots(project, deps);
  const recentSessions = snapshots.map(toRecentSession);
  const turnTimes = await supportTurnTimes(snapshots, deps);
  const recent = recentSignals(snapshots, turnTimes);
  const projectSignals = await deps.getProjectSignals(project, PROJECT_CANDIDATE_LIMIT);

  return {
    project,
    recentSessions,
    instructionSignals: selectInstructions(recent.instructions, projectSignals),
    skills: selectSkills(recent.skills, projectSignals),
  };
}

async function recentSnapshots(project: string, deps: StartupContextDeps): Promise<SessionSnapshotRow[]> {
  const entries = (await deps.listSessionIndex())
    .filter((entry) => entry.project === project && Boolean(entry.snapshotId));
  const loaded = await Promise.all(entries.map((entry) => deps.getSession(entry.snapshotId!)));
  return loaded
    .filter((snapshot): snapshot is SessionSnapshotRow => Boolean(
      snapshot
      && snapshot.project === project
      && snapshot.snapshotId.startsWith('session:')
      && normalizeText(snapshot.title)
      && normalizeText(snapshot.summary),
    ))
    .sort((left, right) => (
      right.updatedAt.localeCompare(left.updatedAt)
      || left.snapshotId.localeCompare(right.snapshotId)
    ))
    .slice(0, SESSION_LIMIT);
}

function toRecentSession(snapshot: SessionSnapshotRow): StartupRecentSession {
  return {
    contextId: `session_${snapshot.snapshotId.slice('session:'.length)}`,
    title: snapshot.title.trim(),
    summary: snapshot.summary.trim(),
  };
}

async function supportTurnTimes(
  snapshots: SessionSnapshotRow[],
  deps: StartupContextDeps,
): Promise<Map<string, string>> {
  const turnIds = new Set<string>();
  for (const snapshot of snapshots) {
    for (const signal of [...snapshot.memorySignals, ...snapshot.skillSignals]) {
      for (const turnId of parseSignal(signal)?.turnIds ?? []) {
        turnIds.add(turnId);
      }
    }
  }
  const rows = await Promise.all([...turnIds].map(async (turnId) => [turnId, await deps.getTurn(turnId)] as const));
  return new Map(rows.flatMap(([turnId, turn]) => turn ? [[turnId, turn.createdAt]] : []));
}

function recentSignals(
  snapshots: SessionSnapshotRow[],
  turnTimes: Map<string, string>,
): { instructions: RecentInstruction[]; skills: RecentSkill[] } {
  const instructions: RecentInstruction[] = [];
  const skills: RecentSkill[] = [];
  for (const snapshot of snapshots) {
    snapshot.memorySignals.forEach((line, index) => {
      const parsed = parseSignal(line);
      const supportedAt = parsed && latestSupportTime(parsed.turnIds, turnTimes);
      const text = parsed && normalizeText(parsed.body);
      if (parsed && supportedAt && text) {
        instructions.push({ text, supportedAt, key: `${snapshot.snapshotId}:instruction:${index}` });
      }
    });
    snapshot.skillSignals.forEach((line, index) => {
      const parsed = parseSignal(line);
      const supportedAt = parsed && latestSupportTime(parsed.turnIds, turnTimes);
      const skill = parsed && parseSkill(parsed.body);
      if (parsed && supportedAt && skill) {
        skills.push({ ...skill, supportedAt, key: `${snapshot.snapshotId}:skill:${index}` });
      }
    });
  }
  instructions.sort(compareRecent);
  skills.sort(compareRecent);
  return { instructions, skills };
}

function selectInstructions(
  recent: RecentInstruction[],
  projectSignals: ProjectDreamSignals | null,
): string[] {
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const signal of recent) {
    const normalized = normalizeText(signal.text);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    selected.push(signal.text);
    seen.add(normalized);
    if (selected.length === RECENT_INSTRUCTION_LIMIT) {
      break;
    }
  }
  for (const signal of projectSignals?.memorySignals ?? []) {
    const text = normalizeText(signal.text);
    if (!text || seen.has(text)) {
      continue;
    }
    selected.push(text);
    seen.add(text);
    if (selected.length === INSTRUCTION_LIMIT) {
      break;
    }
  }
  return selected;
}

function selectSkills(
  recent: RecentSkill[],
  projectSignals: ProjectDreamSignals | null,
): StartupRecentSkill[] {
  const selected: StartupRecentSkill[] = [];
  const seen = new Set<string>();
  for (const skill of recent) {
    const name = normalizeText(skill.name);
    if (!name || seen.has(skillKey(name))) {
      continue;
    }
    selected.push({ name, summary: normalizeText(skill.summary) });
    seen.add(skillKey(name));
    if (selected.length === RECENT_SKILL_LIMIT) {
      break;
    }
  }
  for (const skill of projectSignals?.skillSignals ?? []) {
    const name = normalizeText(skill.name);
    const summary = normalizeText(skill.summary);
    if (!name || !summary || seen.has(skillKey(name))) {
      continue;
    }
    selected.push({ name, summary });
    seen.add(skillKey(name));
    if (selected.length === SKILL_LIMIT) {
      break;
    }
  }
  return selected;
}

function parseSignal(line: string): { turnIds: string[]; body: string } | null {
  const match = /^- \[([^\]]+)\]\s+([\s\S]+)$/.exec(line.trim());
  if (!match) {
    return null;
  }
  const turnIds = match[1]!
    .split(',')
    .map((label) => /^(turn:[^\s,\]]+)\s+\+(?:1|10)$/.exec(label.trim())?.[1])
    .filter((turnId): turnId is string => Boolean(turnId));
  return turnIds.length > 0 ? { turnIds, body: match[2]!.trim() } : null;
}

function parseSkill(body: string): StartupRecentSkill | null {
  const match = /^([^:\n]+):\s+([\s\S]+)$/.exec(body.trim());
  if (!match) {
    return null;
  }
  const name = normalizeText(match[1]!);
  const summary = normalizeText(match[2]!);
  return name && summary ? { name, summary } : null;
}

function latestSupportTime(turnIds: string[], turnTimes: Map<string, string>): string | null {
  const times = turnIds.map((turnId) => turnTimes.get(turnId)).filter((value): value is string => Boolean(value));
  return times.length > 0 ? times.sort().at(-1)! : null;
}

function compareRecent(left: { supportedAt: string; key: string }, right: { supportedAt: string; key: string }): number {
  return right.supportedAt.localeCompare(left.supportedAt) || left.key.localeCompare(right.key);
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function skillKey(name: string): string {
  return name.toLocaleLowerCase('en-US');
}
