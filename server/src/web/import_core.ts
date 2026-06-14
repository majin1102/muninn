import path from 'node:path';
import { captureTurn, isCanonicalProjectIdentity, observer, sessions, turns } from '../memory/index.js';
import {
  defaultArtifactStore,
  importMarker,
  toTurnContent,
  type ArtifactMode,
  type CodexSession,
  type CodexSessionSummary,
} from '@muninn/codex';
import type {
  DeleteImportedProjectResponse,
  DeleteImportedSessionResponse,
  ImportAgentProject,
  ImportLocalProjectsResponse,
  ImportProjectsResponse,
  ImportSelectedResponse,
  ImportSessionsListResponse,
  SessionIdentity,
} from '@muninn/common';
import * as SessionIdentityKey from '@muninn/common/session-identity';
import { getCapturePolicy, removeCapturePolicy, setCaptureEnabled } from './capture_policy.js';

/**
 * Per-agent descriptor that drives the generic import flow. Each agent supplies
 * its source location, transcript parser, and dedup identity; everything else
 * (DB listing, disk scan, selective import) is shared here.
 */
export type ImportAdapter = {
  agent: string;
  markerKey: string;
  ingest: string;
  sourceRoot: string;
  listSessionFiles(): Promise<string[]>;
  readSessionSummary(sourcePath: string): Promise<CodexSessionSummary | null>;
  readSession(sourcePath: string, options: { artifactStore: string; artifactMode: ArtifactMode }): Promise<CodexSession | null>;
  isExcluded?(session: CodexSession): boolean;
};

const DELETE_BATCH_SIZE = 100;
const TURN_PAGE_SIZE = 10_000;
const LOCAL_SESSION_SCAN_CONCURRENCY = 8;
type ImportTurn = Awaited<ReturnType<typeof turns.list>>[number];

/** DB-only fast path: sessions already captured into Muninn for this agent. */
export async function listImportedSessions(adapter: ImportAdapter, requestId: string): Promise<ImportSessionsListResponse> {
  const indexEntries = (await sessions.index()).filter((entry) => entry.agent === adapter.agent);
  const projects = groupProjects(indexEntries.map((entry) => ({
    project: entry.project,
    session: {
      sessionId: entry.sessionId,
      project: entry.project,
      cwd: entry.cwd,
      title: entry.title || entry.sessionId.slice(0, 12),
      updatedAt: entry.latestUpdatedAt,
      imported: true,
    },
  })));

  await applyCapturePolicy(adapter, projects);
  return {
    sourceRoot: adapter.sourceRoot,
    projectCount: projects.length,
    sessionCount: indexEntries.length,
    importedCount: indexEntries.length,
    projects,
    requestId,
  };
}

async function applyCapturePolicy(adapter: ImportAdapter, projects: ImportAgentProject[]): Promise<void> {
  const policy = await getCapturePolicy(adapter.agent);
  for (const project of projects) {
    project.captureEnabled = policy[project.project] === true;
  }
}

/** Disk scan: every local session for this agent, flagged imported/not. */
export async function listLocalProjects(adapter: ImportAdapter, requestId: string): Promise<ImportLocalProjectsResponse> {
  const files = await adapter.listSessionFiles();
  const summaries = (await mapConcurrent(files, LOCAL_SESSION_SCAN_CONCURRENCY, (file) => (
    adapter.readSessionSummary(file).catch(() => null)
  )))
    .filter((session): session is CodexSessionSummary => session !== null);
  const byProject = new Map<string, { project: string; latestUpdatedAt: string }>();
  for (const session of summaries) {
    const current = byProject.get(session.project);
    if (!current || session.updatedAt > current.latestUpdatedAt) {
      byProject.set(session.project, { project: session.project, latestUpdatedAt: session.updatedAt });
    }
  }
  const projects = [...byProject.values()].sort((left, right) => (
    right.latestUpdatedAt.localeCompare(left.latestUpdatedAt)
  ));
  return {
    sourceRoot: adapter.sourceRoot,
    projectCount: projects.length,
    projects,
    requestId,
  };
}

/** Disk scan: local sessions for this agent, optionally scoped to one project. */
export async function listLocalSessions(adapter: ImportAdapter, requestId: string, project?: string): Promise<ImportSessionsListResponse> {
  const files = await adapter.listSessionFiles();
  // Skip any file that fails to parse (e.g. a transcript too large to read into
  // a string) so one bad file never fails the whole listing.
  const sessions = (await mapConcurrent(files, LOCAL_SESSION_SCAN_CONCURRENCY, (file) => (
    adapter.readSessionSummary(file).catch(() => null)
  )))
    .filter((session): session is CodexSessionSummary => session !== null)
    .filter((session) => !project || session.project === project)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  const indexedSessions = await sessionsIndexForAgent(adapter.agent);
  const importedSessionKeys = new Set(indexedSessions.map(SessionIdentityKey.sessionIdentityKey));
  const indexByIdentity = new Map(indexedSessions.map((entry) => [SessionIdentityKey.sessionIdentityKey(entry), entry]));
  const projects = groupProjects(sessions.map((session) => ({
    project: session.project,
    session: localSessionNode(adapter, session, indexByIdentity, importedSessionKeys),
  })));

  await applyCapturePolicy(adapter, projects);
  return {
    sourceRoot: adapter.sourceRoot,
    projectCount: projects.length,
    sessionCount: sessions.length,
    importedCount: projects.reduce((total, project) => total + project.importedCount, 0),
    projects,
    requestId,
  };
}

/** Import the selected source files without replacing existing imported turns. */
export async function importSelectedSessions(adapter: ImportAdapter, sourcePaths: string[], requestId: string): Promise<ImportSelectedResponse> {
  const artifactStore = defaultArtifactStore();
  const failedSessions: ImportSelectedResponse['failedSessions'] = [];
  const root = path.resolve(adapter.sourceRoot) + path.sep;
  const selectedSummaries: CodexSessionSummary[] = [];
  for (const sourcePath of sourcePaths) {
    // Only allow files under the agent's source root (no arbitrary file reads).
    if (!path.resolve(sourcePath).startsWith(root)) {
      failedSessions.push({ sourcePath, errorMessage: 'path is outside the agent source root' });
      continue;
    }
    try {
      const summary = await adapter.readSessionSummary(sourcePath);
      if (summary) {
        selectedSummaries.push(summary);
      }
    } catch (error) {
      failedSessions.push({ sourcePath, errorMessage: error instanceof Error ? error.message : String(error) });
    }
  }

  const indexByIdentity = new Map((await sessions.index()).map((entry) => [SessionIdentityKey.sessionIdentityKey(entry), entry]));
  const importablePaths: string[] = [];
  for (const summary of selectedSummaries) {
    const entry = indexByIdentity.get(identityKey(adapter, summary));
    if (entry?.firstTurnSequence === 0) {
      failedSessions.push({ sourcePath: summary.sourcePath, errorMessage: 'session already imported' });
      continue;
    }
    importablePaths.push(summary.sourcePath);
  }

  let importedSessions = 0;
  let importedTurns = 0;
  const enabledProjects = new Set<string>();
  for (const sourcePath of importablePaths) {
    try {
      const session = await adapter.readSession(sourcePath, { artifactStore, artifactMode: 'copy' });
      if (!session || adapter.isExcluded?.(session)) {
        continue;
      }
      let turnsForSession = 0;
      const seen = new Set<string>();
      const existingSequences = await existingSourceSequences(adapter, session);
      for (const [index, turn] of session.turns.entries()) {
        if (existingSequences.has(index)) {
          continue;
        }
        const marker = importMarker(session, index);
        if (seen.has(marker)) {
          continue;
        }
        await captureTurn(toTurnContent(session, turn, index, { agent: adapter.agent, ingest: adapter.ingest, markerKey: adapter.markerKey }));
        seen.add(marker);
        existingSequences.add(index);
        turnsForSession += 1;
      }
      if (turnsForSession > 0) {
        importedSessions += 1;
        importedTurns += turnsForSession;
        enabledProjects.add(session.project);
      }
    } catch (error) {
      failedSessions.push({ sourcePath, errorMessage: error instanceof Error ? error.message : String(error) });
    }
  }

  if (importedTurns > 0) {
    await observer.flushPending();
  }

  // Importing a project opts it into live auto-capture going forward.
  for (const project of enabledProjects) {
    if (isCanonicalProjectIdentity(project)) {
      await setCaptureEnabled(adapter.agent, project, true);
    }
  }

  return { importedSessions, importedTurns, failedSessions, requestId };
}

export async function importProjects(adapter: ImportAdapter, projects: string[], requestId: string): Promise<ImportProjectsResponse> {
  const uniqueProjects = [...new Set(projects.map((project) => project.trim()).filter((project) => project.length > 0))];
  for (const project of uniqueProjects) {
    await setCaptureEnabled(adapter.agent, project, true);
  }
  return {
    importedProjects: uniqueProjects.length,
    requestId,
  };
}

export async function deleteImportedProject(adapter: ImportAdapter, project: string, requestId: string): Promise<DeleteImportedProjectResponse> {
  const sessionKeys = new Set(
    (await sessions.index())
      .filter((entry) => entry.agent === adapter.agent && entry.project === project)
      .map(SessionIdentityKey.sessionIdentityKey),
  );
  const deletedTurns = await deleteProjectTurns(adapter, sessionKeys);
  await sessions.refreshIndex();
  await removeCapturePolicy(adapter.agent, project);
  return {
    deletedSessions: sessionKeys.size,
    deletedTurns,
    requestId,
  };
}

export async function deleteImportedSession(
  adapter: ImportAdapter,
  project: string,
  sessionId: string,
  requestId: string,
): Promise<DeleteImportedSessionResponse> {
  const key = identityKey(adapter, { project, sessionId });
  const exists = (await sessions.index()).some((entry) => (
    entry.agent === adapter.agent
    && SessionIdentityKey.sessionIdentityKey(entry) === key
  ));
  const deletedTurns = await deleteProjectTurns(adapter, exists ? new Set([key]) : new Set());
  await sessions.refreshIndex();
  return {
    deletedSessions: exists ? 1 : 0,
    deletedTurns,
    requestId,
  };
}

async function deleteProjectTurns(adapter: ImportAdapter, sessionKeys: Set<string>): Promise<number> {
  if (sessionKeys.size === 0) {
    return 0;
  }
  const turnIds: string[] = [];
  for (const turn of await listAgentTurns(adapter.agent)) {
    const key = turn.sessionId ? identityKey(adapter, { project: turn.project, sessionId: turn.sessionId }) : null;
    if (key && sessionKeys.has(key)) {
      turnIds.push(turn.turnId);
    }
  }
  let deleted = 0;
  for (let index = 0; index < turnIds.length; index += DELETE_BATCH_SIZE) {
    deleted += (await turns.delete({ turnIds: turnIds.slice(index, index + DELETE_BATCH_SIZE) })).deleted;
  }
  return deleted;
}

async function listAgentTurns(agent: string): Promise<ImportTurn[]> {
  const allTurns: ImportTurn[] = [];
  for (let offset = 0; ; offset += TURN_PAGE_SIZE) {
    const page = await turns.list({
      mode: { type: 'page', offset, limit: TURN_PAGE_SIZE },
      agent,
    });
    allTurns.push(...page);
    if (page.length < TURN_PAGE_SIZE) {
      return allTurns;
    }
  }
}

async function existingSourceSequences(adapter: ImportAdapter, session: Pick<SessionIdentity, 'project' | 'sessionId'>): Promise<Set<number>> {
  const sequences = new Set<number>();
  for (let offset = 0; ; offset += TURN_PAGE_SIZE) {
    const page = await turns.list({
      mode: { type: 'page', offset, limit: TURN_PAGE_SIZE },
      agent: adapter.agent,
      sessionId: session.sessionId,
    });
    for (const turn of page) {
      if (turn.project !== session.project) {
        continue;
      }
      const value = turn.metadata?.sourceTurnSequence;
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
        sequences.add(value);
      }
    }
    if (page.length < TURN_PAGE_SIZE) {
      break;
    }
  }
  return sequences;
}

async function sessionsIndexForAgent(agent: string): Promise<Array<Awaited<ReturnType<typeof sessions.index>>[number]>> {
  return (await sessions.index()).filter((entry) => entry.agent === agent);
}

function localSessionNode(
  adapter: ImportAdapter,
  session: CodexSessionSummary,
  indexByIdentity: Map<string, Awaited<ReturnType<typeof sessions.index>>[number]>,
  importedSessionKeys: Set<string>,
): ImportAgentProject['sessions'][number] {
  const key = identityKey(adapter, session);
  const entry = importedSessionKeys.has(key) ? indexByIdentity.get(key) : undefined;
  return {
    sessionId: session.sessionId,
    project: session.project,
    cwd: session.cwd,
    title: session.title,
    promptPreview: session.promptPreview,
    sourcePath: session.sourcePath,
    updatedAt: session.updatedAt,
    imported: entry?.firstTurnSequence === 0,
  };
}

function identityKey(adapter: Pick<ImportAdapter, 'agent'>, session: Pick<SessionIdentity, 'project' | 'sessionId'>): string {
  return SessionIdentityKey.sessionIdentityKey({
    project: session.project,
    agent: adapter.agent,
    sessionId: session.sessionId,
  });
}

function groupProjects(rows: Array<{ project: string; session: ImportAgentProject['sessions'][number] }>): ImportAgentProject[] {
  const grouped = new Map<string, ImportAgentProject>();
  for (const row of rows) {
    const project = grouped.get(row.project) ?? {
      project: row.project,
      sessionCount: 0,
      importedCount: 0,
      sessions: [],
    };
    project.sessions.push(row.session);
    project.sessionCount += 1;
    project.importedCount += row.session.imported ? 1 : 0;
    grouped.set(row.project, project);
  }
  for (const project of grouped.values()) {
    project.sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
  return [...grouped.values()].sort((left, right) => (
    (right.sessions[0]?.updatedAt ?? '').localeCompare(left.sessions[0]?.updatedAt ?? '')
  ));
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
