import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureTurns } from '../api/capture.js';
import { isCanonicalProjectIdentity } from '../config.js';
import { sessions, turns } from '../backend.js';
import { loadMuninnConfig, resolveStorageTarget } from '../config.js';
import { getNativeTables } from '../native.js';
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
  TurnContent,
} from '@muninn/common';
import * as SessionIdentityKey from '@muninn/common/session-identity';
import { getCapturePolicy, removeCapturePolicy, setCaptureEnabled } from '../api/capture.js';

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

const IMPORT_DELETE_BATCH_SIZE = 100;
const IMPORT_TURN_PAGE_SIZE = 10_000;
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
  const importablePaths: Array<{ sourcePath: string; firstTurnSequence?: number }> = [];
  for (const summary of selectedSummaries) {
    const entry = indexByIdentity.get(identityKey(adapter, summary));
    if (entry?.firstTurnSequence === 0) {
      failedSessions.push({ sourcePath: summary.sourcePath, errorMessage: 'session already imported' });
      continue;
    }
    importablePaths.push({
      sourcePath: summary.sourcePath,
      firstTurnSequence: entry?.firstTurnSequence,
    });
  }

  let importedSessions = 0;
  let importedTurns = 0;
  const enabledProjects = new Set<string>();
  for (const { sourcePath, firstTurnSequence } of importablePaths) {
    try {
      const session = await adapter.readSession(sourcePath, { artifactStore, artifactMode: 'copy' });
      if (!session || adapter.isExcluded?.(session)) {
        continue;
      }
      const seen = new Set<string>();
      const turnContents: TurnContent[] = [];
      for (const [index, turn] of session.turns.entries()) {
        if (firstTurnSequence !== undefined && index >= firstTurnSequence) {
          continue;
        }
        const marker = importMarker(session, index);
        if (seen.has(marker)) {
          continue;
        }
        turnContents.push(toTurnContent(session, turn, index, { agent: adapter.agent, ingest: adapter.ingest, markerKey: adapter.markerKey }));
        seen.add(marker);
      }
      let capturedTurns = 0;
      if (turnContents.length > 0) {
        capturedTurns = await captureTurns(turnContents);
      }
      if (capturedTurns > 0) {
        importedSessions += 1;
        importedTurns += capturedTurns;
        enabledProjects.add(session.project);
      }
    } catch (error) {
      failedSessions.push({ sourcePath, errorMessage: error instanceof Error ? error.message : String(error) });
    }
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
  const { deleted: deletedTurns, turnIds } = await deleteProjectTurns(adapter, sessionKeys);
  await deleteRelatedMemories(turnIds);
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
  const { deleted: deletedTurns, turnIds } = await deleteProjectTurns(adapter, exists ? new Set([key]) : new Set());
  await deleteRelatedMemories(turnIds);
  await sessions.refreshIndex();
  return {
    deletedSessions: exists ? 1 : 0,
    deletedTurns,
    requestId,
  };
}

async function deleteProjectTurns(adapter: ImportAdapter, sessionKeys: Set<string>): Promise<{ deleted: number; turnIds: string[] }> {
  if (sessionKeys.size === 0) {
    return { deleted: 0, turnIds: [] };
  }
  const turnIds: string[] = [];
  for (const turn of await listAgentTurns(adapter.agent)) {
    const key = turn.sessionId ? identityKey(adapter, { project: turn.project, sessionId: turn.sessionId }) : null;
    if (key && sessionKeys.has(key)) {
      turnIds.push(turn.turnId);
    }
  }
  let deleted = 0;
  for (let index = 0; index < turnIds.length; index += IMPORT_DELETE_BATCH_SIZE) {
    deleted += (await turns.delete({ turnIds: turnIds.slice(index, index + IMPORT_DELETE_BATCH_SIZE) })).deleted;
  }
  return { deleted, turnIds };
}

async function deleteRelatedMemories(turnIds: string[]): Promise<void> {
  if (turnIds.length === 0) {
    return;
  }
  const turnIdSet = new Set(turnIds);
  const tables = await getNativeTables(resolveStorageTarget(loadMuninnConfig() ?? {}, 'main'));
  const extractions = (await tables.extractionTable.list({}))
    .filter((row) => row.turnRefs.some((ref) => turnIdSet.has(ref)));
  const extractionIds = [...new Set(extractions.map((row) => row.id))];
  const observationPaths = [...new Set(extractions.flatMap((row) => row.observationPaths))];
  if (extractionIds.length > 0) {
    await tables.extractionTable.delete({ ids: extractionIds });
  }
  if (observationPaths.length > 0) {
    await tables.observationContextTable.delete({ ids: observationPaths });
    await tables.observationTable.delete({ ids: observationPaths });
  }
}

async function listAgentTurns(agent: string): Promise<ImportTurn[]> {
  const allTurns: ImportTurn[] = [];
  for (let offset = 0; ; offset += IMPORT_TURN_PAGE_SIZE) {
    const page = await turns.list({
      mode: { type: 'page', offset, limit: IMPORT_TURN_PAGE_SIZE },
      agent,
    });
    allTurns.push(...page);
    if (page.length < IMPORT_TURN_PAGE_SIZE) {
      return allTurns;
    }
  }
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


import {
  CODEX_IMPORT_AGENT,
  IMPORT_ARTIFACT_KEY,
  markerFromTurn,
  readCodexSession,
  readCodexSessionSummary,
} from '@muninn/codex';
import type {
  CodexImportPreviewResponse,
  CodexImportProjectPreview,
  CodexImportRunResponse,
  CodexImportSessionPreview,
} from '@muninn/common';

type ImportSelection = {
  sourceRoot: string;
  artifactStore: string;
  projectLimit: number;
  projects: CodexImportProjectPreview[];
  sessions: CodexSession[];
};

type ExistingImportTurn = {
  turnId: string;
  marker: string;
};
type CodexImportTurn = Awaited<ReturnType<typeof turns.list>>[number];

export type CodexImportOptions = {
  sourceRoot?: string;
  projectLimit?: number;
  projectKeys?: string[];
  artifactStore?: string;
};

const DEFAULT_PROJECT_LIMIT = 5;
const MUNINN_E2E_SESSION_TURN_LIMIT = 1_000;
const DELETE_BATCH_SIZE = 100;
const TURN_PAGE_SIZE = 10_000;

export async function previewCodexImport(options: CodexImportOptions, requestId: string): Promise<CodexImportPreviewResponse> {
  const selection = await selectCodexImportSessions(options, 'preview');
  return toPreviewResponse(selection, requestId);
}

export async function runCodexImport(options: CodexImportOptions, requestId: string): Promise<CodexImportRunResponse> {
  const selection = await selectCodexImportSessions(options, 'preview');
  const selectedSessionKeys = new Set(selection.sessions.map((session) => SessionIdentityKey.sessionIdentityKey({
    project: session.project,
    agent: CODEX_IMPORT_AGENT,
    sessionId: session.sessionId,
  })));
  const existingImports = await collectExistingCodexImports({
    sessionKeys: selectedSessionKeys,
  });
  const existingImportTurns = [...existingImports.values()].flat();
  let importedSessions = 0;
  let importedTurns = 0;
  let skippedTurns = 0;
  let deletedTurns = await deleteExistingImport(existingImportTurns);
  const failedSessions: CodexImportRunResponse['failedSessions'] = [];

  for (const previewSession of selection.sessions) {
    try {
      const session = await readCodexSession(previewSession.sourcePath, {
        artifactStore: selection.artifactStore,
        artifactMode: 'copy',
      });
      if (!session) {
        continue;
      }
      const result = await importCodexSession(session);
      if (result.importedTurns > 0 || result.skippedTurns > 0) {
        importedSessions += 1;
      }
      importedTurns += result.importedTurns;
      skippedTurns += result.skippedTurns;
    } catch (error) {
      failedSessions.push({
        sessionId: previewSession.sessionId,
        sourcePath: previewSession.sourcePath,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    ...toPreviewResponse(selection, requestId),
    deletedTurns,
    importedSessions,
    importedTurns,
    skippedTurns,
    failedSessions,
  };
}

async function selectCodexImportSessions(options: CodexImportOptions, artifactMode: ArtifactMode): Promise<ImportSelection> {
  const sourceRoot = options.sourceRoot ?? path.join(os.homedir(), '.codex');
  const artifactStore = options.artifactStore ?? defaultArtifactStore();
  const projectLimit = normalizeProjectLimit(options.projectLimit);
  const projectKeys = normalizeProjectKeys(options.projectKeys);
  const sessionFiles = await listCodexSessionFiles(sourceRoot);
  const sessions = (await Promise.all(sessionFiles.map((file) => readCodexSession(file, { artifactStore, artifactMode }))))
    .filter((session): session is CodexSession => session !== null)
    .filter((session) => projectKeys.size === 0 || projectKeys.has(session.project))
    .filter((session) => !isExcludedImportSession(session))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  const grouped = new Map<string, CodexSession[]>();
  for (const session of sessions) {
    const existing = grouped.get(session.project) ?? [];
    if (existing.length < projectLimit) {
      existing.push(session);
      grouped.set(session.project, existing);
    }
  }

  const selected = [...grouped.values()].flat();
  const projects = [...grouped.entries()]
    .map(([projectKey, projectSessions]) => ({
      projectKey,
      cwd: projectSessions[0]?.cwd ?? '',
      sessions: projectSessions.map(toSessionPreview),
    }))
    .sort((left, right) => latestProjectTime(right).localeCompare(latestProjectTime(left)));

  return {
    sourceRoot,
    artifactStore,
    projectLimit,
    projects,
    sessions: selected,
  };
}

async function listCodexSessionFiles(sourceRoot: string): Promise<string[]> {
  const roots = [
    path.join(sourceRoot, 'sessions'),
    path.join(sourceRoot, 'archived_sessions'),
  ];
  const files: string[] = [];
  for (const root of roots) {
    files.push(...await listJsonlFiles(root));
  }
  return files;
}

async function listJsonlFiles(root: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listJsonlFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(entryPath);
    }
  }
  return files;
}

async function importCodexSession(session: CodexSession): Promise<{ importedTurns: number; skippedTurns: number }> {
  let importedTurns = 0;
  let skippedTurns = 0;
  const importedMarkers = new Set<string>();
  const turnContents: TurnContent[] = [];
  for (const [index, turn] of session.turns.entries()) {
    const marker = importMarker(session, index);
    if (importedMarkers.has(marker)) {
      skippedTurns += 1;
      continue;
    }

    turnContents.push(toTurnContent(session, turn, index));
    importedMarkers.add(marker);
    importedTurns += 1;
  }
  if (turnContents.length > 0) {
    await captureTurns(turnContents);
  }
  return { importedTurns, skippedTurns };
}

async function collectExistingCodexImports(selected: {
  sessionKeys: Set<string>;
}): Promise<Map<string, ExistingImportTurn[]>> {
  const grouped = new Map<string, ExistingImportTurn[]>();
  for (const turn of await listCodexImportTurns()) {
    let marker = markerFromTurn(turn);
    let sessionId = marker?.split('#', 1)[0] ?? '';
    if (!marker) {
      continue;
    }
    if (!sessionId) {
      continue;
    }
    const key = SessionIdentityKey.sessionIdentityKey({ project: turn.project, agent: CODEX_IMPORT_AGENT, sessionId });
    if (!selected.sessionKeys.has(key)) {
      continue;
    }
    const turnsForSession = grouped.get(key) ?? [];
    turnsForSession.push({ turnId: turn.turnId, marker });
    grouped.set(key, turnsForSession);
  }
  return grouped;
}

async function listCodexImportTurns(): Promise<CodexImportTurn[]> {
  const allTurns: CodexImportTurn[] = [];
  for (let offset = 0; ; offset += TURN_PAGE_SIZE) {
    const page = await turns.list({
      mode: { type: 'page', offset, limit: TURN_PAGE_SIZE },
      agent: CODEX_IMPORT_AGENT,
    });
    allTurns.push(...page);
    if (page.length < TURN_PAGE_SIZE) {
      return allTurns;
    }
  }
}

async function deleteExistingImport(existing: ExistingImportTurn[]): Promise<number> {
  const turnIds = existing.map((turn) => turn.turnId);
  if (turnIds.length === 0) {
    return 0;
  }
  let deleted = 0;
  for (let index = 0; index < turnIds.length; index += DELETE_BATCH_SIZE) {
    deleted += (await turns.delete({ turnIds: turnIds.slice(index, index + DELETE_BATCH_SIZE) })).deleted;
  }
  return deleted;
}

function normalizeProjectLimit(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined) {
    return DEFAULT_PROJECT_LIMIT;
  }
  return Math.min(Math.max(Math.floor(value), 1), 50);
}

function normalizeProjectKeys(value: string[] | undefined): Set<string> {
  return new Set((value ?? []).map((key) => key.trim()).filter((key) => key.length > 0));
}

function isExcludedImportSession(session: CodexSession): boolean {
  if (path.basename(session.project) !== 'muninn') {
    return false;
  }
  return session.title.trim().toLowerCase() === 'e2e'
    || session.turns.length > MUNINN_E2E_SESSION_TURN_LIMIT;
}

function toPreviewResponse(selection: ImportSelection, requestId: string): CodexImportPreviewResponse {
  return {
    sourceRoot: selection.sourceRoot,
    projectLimit: selection.projectLimit,
    projectCount: selection.projects.length,
    sessionCount: selection.sessions.length,
    turnCount: selection.sessions.reduce((total, session) => total + session.turns.length, 0),
    artifactCount: selection.sessions.reduce((total, session) => (
      total + session.turns.reduce((sessionTotal, turn) => sessionTotal + turn.artifacts.length, 0)
    ), 0),
    projects: selection.projects,
    requestId,
  };
}

function toSessionPreview(session: CodexSession): CodexImportSessionPreview {
  return {
    sessionId: session.sessionId,
    title: session.title,
    cwd: session.cwd,
    sourcePath: session.sourcePath,
    updatedAt: session.updatedAt,
    turnCount: session.turns.length,
    artifactCount: session.turns.reduce((total, turn) => total + turn.artifacts.length, 0),
  };
}

function latestProjectTime(project: CodexImportProjectPreview): string {
  return project.sessions[0]?.updatedAt ?? '';
}

// Adapter consumed by import_core for the generic per-session list/import flow.
export const codexAdapter: ImportAdapter = {
  agent: CODEX_IMPORT_AGENT,
  markerKey: IMPORT_ARTIFACT_KEY,
  ingest: 'codex-import',
  sourceRoot: path.join(os.homedir(), '.codex'),
  listSessionFiles: () => listCodexSessionFiles(path.join(os.homedir(), '.codex')),
  readSessionSummary: (sourcePath) => readCodexSessionSummary(sourcePath),
  readSession: (sourcePath, options) => readCodexSession(sourcePath, options),
  isExcluded: (session) => isExcludedImportSession(session),
};

export const __testing = {
  readCodexSession,
  defaultArtifactStore,
};


import { CLAUDE_AGENT, CLAUDE_MARKER_KEY, readClaudeSession, readClaudeSessionSummary } from '@muninn/claude';

export const CLAUDE_IMPORT_AGENT = CLAUDE_AGENT;
export const CLAUDE_INGEST = 'claude-code-import';

function claudeProjectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/** Adapter consumed by import_core for the generic list/import flow. */
export const claudeAdapter: ImportAdapter = {
  agent: CLAUDE_AGENT,
  markerKey: CLAUDE_MARKER_KEY,
  ingest: CLAUDE_INGEST,
  sourceRoot: claudeProjectsRoot(),
  listSessionFiles: () => listClaudeSessionFiles(claudeProjectsRoot()),
  readSessionSummary: (sourcePath) => readClaudeSessionSummary(sourcePath),
  readSession: (sourcePath, options) => readClaudeSession(sourcePath, options),
};

async function listClaudeSessionFiles(root: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listClaudeSessionFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(entryPath);
    }
  }
  return files;
}
