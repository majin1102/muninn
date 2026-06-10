import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { addMessage, turns } from '@muninn/core';
import {
  CODEX_IMPORT_AGENT,
  IMPORT_ARTIFACT_KEY,
  defaultArtifactStore,
  importMarker,
  markerFromTurn,
  readCodexSession,
  toTurnContent,
  type ArtifactMode,
  type CodexSession,
} from '@muninn/codex';
import type {
  CodexImportPreviewResponse,
  CodexImportProjectPreview,
  CodexImportRunResponse,
  CodexImportSessionPreview,
  ImportAgentProject,
  ImportSelectedResponse,
  ImportSessionsListResponse,
} from '@muninn/types';

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

export type CodexImportOptions = {
  sourceRoot?: string;
  projectLimit?: number;
  projectKeys?: string[];
  artifactStore?: string;
};

const DEFAULT_PROJECT_LIMIT = 5;
const DEFAULT_PROJECT_KEYS = ['muninn', 'lance'];
const MUNINN_E2E_SESSION_TURN_LIMIT = 1_000;
const DELETE_BATCH_SIZE = 100;

export async function previewCodexImport(options: CodexImportOptions, requestId: string): Promise<CodexImportPreviewResponse> {
  const selection = await selectCodexImportSessions(options, 'preview');
  return toPreviewResponse(selection, requestId);
}

export async function runCodexImport(options: CodexImportOptions, requestId: string): Promise<CodexImportRunResponse> {
  const selection = await selectCodexImportSessions(options, 'preview');
  const selectedRawSessionIds = new Set(selection.sessions.map((session) => session.sessionId));
  const existingImports = await collectExistingCodexImports({
    rawSessionIds: selectedRawSessionIds,
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
    .filter((session) => projectKeys.has(session.projectKey))
    .filter((session) => !isExcludedImportSession(session))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  const grouped = new Map<string, CodexSession[]>();
  for (const session of sessions) {
    const existing = grouped.get(session.projectKey) ?? [];
    if (existing.length < projectLimit) {
      existing.push(session);
      grouped.set(session.projectKey, existing);
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
  for (const [index, turn] of session.turns.entries()) {
    const marker = importMarker(session, index);
    if (importedMarkers.has(marker)) {
      skippedTurns += 1;
      continue;
    }

    await addMessage(toTurnContent(session, turn, index));
    importedMarkers.add(marker);
    importedTurns += 1;
  }
  return { importedTurns, skippedTurns };
}

async function collectExistingCodexImports(selected: {
  rawSessionIds: Set<string>;
}): Promise<Map<string, ExistingImportTurn[]>> {
  const existing = await turns.list({
    mode: { type: 'page', offset: 0, limit: 100_000 },
    agent: CODEX_IMPORT_AGENT,
  });
  const grouped = new Map<string, ExistingImportTurn[]>();
  for (const turn of existing) {
    let marker = markerFromTurn(turn);
    let sessionId = marker?.split('#', 1)[0] ?? '';
    if (!marker) {
      continue;
    }
    if (!selected.rawSessionIds.has(sessionId)) {
      continue;
    }
    if (!sessionId) {
      continue;
    }
    const turnsForSession = grouped.get(sessionId) ?? [];
    turnsForSession.push({ turnId: turn.turnId, marker });
    grouped.set(sessionId, turnsForSession);
  }
  return grouped;
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
  const keys = value && value.length > 0 ? value : DEFAULT_PROJECT_KEYS;
  return new Set(keys.map((key) => key.trim()).filter((key) => key.length > 0));
}

function isExcludedImportSession(session: CodexSession): boolean {
  if (session.projectKey !== 'muninn') {
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

// ---- Per-session import (Import & Capture settings) ----

export async function listCodexImportSessions(options: CodexImportOptions, requestId: string): Promise<ImportSessionsListResponse> {
  const sourceRoot = options.sourceRoot ?? path.join(os.homedir(), '.codex');
  const artifactStore = options.artifactStore ?? defaultArtifactStore();
  const sessionFiles = await listCodexSessionFiles(sourceRoot);
  // Skip any session file that fails to parse (e.g. a transcript too large to
  // read into a string) so one bad file never fails the whole listing.
  const sessions = (await Promise.all(sessionFiles.map((file) => readCodexSession(file, { artifactStore, artifactMode: 'preview' }).catch(() => null))))
    .filter((session): session is CodexSession => session !== null)
    .filter((session) => !isExcludedImportSession(session))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  const existing = await collectExistingCodexImports({ rawSessionIds: new Set(sessions.map((session) => session.sessionId)) });

  const grouped = new Map<string, ImportAgentProject>();
  for (const session of sessions) {
    const imported = existing.has(session.sessionId);
    const project = grouped.get(session.projectKey) ?? {
      projectKey: session.projectKey,
      cwd: session.cwd,
      sessionCount: 0,
      importedCount: 0,
      sessions: [],
    };
    project.sessions.push({
      sessionId: session.sessionId,
      title: session.title,
      sourcePath: session.sourcePath,
      updatedAt: session.updatedAt,
      turnCount: session.turns.length,
      artifactCount: session.turns.reduce((total, turn) => total + turn.artifacts.length, 0),
      imported,
    });
    project.sessionCount += 1;
    project.importedCount += imported ? 1 : 0;
    grouped.set(session.projectKey, project);
  }

  const projects = [...grouped.values()].sort((left, right) => (
    (right.sessions[0]?.updatedAt ?? '').localeCompare(left.sessions[0]?.updatedAt ?? '')
  ));

  return {
    sourceRoot,
    projectCount: projects.length,
    sessionCount: sessions.length,
    importedCount: projects.reduce((total, project) => total + project.importedCount, 0),
    projects,
    requestId,
  };
}

/** DB-only fast path: list sessions already captured into Muninn, without scanning local disk. */
export async function listImportedCodexSessions(requestId: string): Promise<ImportSessionsListResponse> {
  const existing = await turns.list({
    mode: { type: 'page', offset: 0, limit: 100_000 },
    agent: CODEX_IMPORT_AGENT,
  });

  type SessionAggregate = {
    sessionId: string;
    project: string;
    cwd: string;
    title: string;
    firstCreatedAt: string;
    sourcePath: string;
    updatedAt: string;
    turnCount: number;
    artifactCount: number;
  };
  const bySession = new Map<string, SessionAggregate>();
  for (const turn of existing) {
    const sessionId = turn.sessionId?.trim();
    if (!sessionId) {
      continue;
    }
    let aggregate = bySession.get(sessionId);
    if (!aggregate) {
      aggregate = {
        sessionId,
        project: turn.project,
        cwd: turn.cwd,
        title: turn.title ?? '',
        firstCreatedAt: turn.createdAt,
        sourcePath: sourcePathFromTurn(turn) ?? '',
        updatedAt: turn.updatedAt,
        turnCount: 0,
        artifactCount: 0,
      };
      bySession.set(sessionId, aggregate);
    }
    aggregate.turnCount += 1;
    aggregate.artifactCount += (turn.artifacts ?? []).filter((artifact) => artifact.key !== IMPORT_ARTIFACT_KEY).length;
    if (turn.title && turn.createdAt <= aggregate.firstCreatedAt) {
      aggregate.title = turn.title;
      aggregate.firstCreatedAt = turn.createdAt;
    }
    if (turn.updatedAt > aggregate.updatedAt) {
      aggregate.updatedAt = turn.updatedAt;
    }
    if (!aggregate.sourcePath) {
      aggregate.sourcePath = sourcePathFromTurn(turn) ?? '';
    }
  }

  const grouped = new Map<string, ImportAgentProject>();
  const aggregates = [...bySession.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  for (const aggregate of aggregates) {
    const project = grouped.get(aggregate.project) ?? {
      projectKey: aggregate.project,
      cwd: aggregate.cwd,
      sessionCount: 0,
      importedCount: 0,
      sessions: [],
    };
    project.sessions.push({
      sessionId: aggregate.sessionId,
      title: aggregate.title || aggregate.sessionId.slice(0, 12),
      sourcePath: aggregate.sourcePath,
      updatedAt: aggregate.updatedAt,
      turnCount: aggregate.turnCount,
      artifactCount: aggregate.artifactCount,
      imported: true,
    });
    project.sessionCount += 1;
    project.importedCount += 1;
    grouped.set(aggregate.project, project);
  }

  const projects = [...grouped.values()].sort((left, right) => (
    (right.sessions[0]?.updatedAt ?? '').localeCompare(left.sessions[0]?.updatedAt ?? '')
  ));

  return {
    sourceRoot: path.join(os.homedir(), '.codex'),
    projectCount: projects.length,
    sessionCount: bySession.size,
    importedCount: bySession.size,
    projects,
    requestId,
  };
}

function sourcePathFromTurn(turn: { artifacts?: Array<{ key: string; content?: string }> | null }): string | null {
  const artifact = turn.artifacts?.find((item) => item.key === IMPORT_ARTIFACT_KEY);
  if (!artifact?.content) {
    return null;
  }
  try {
    const parsed = JSON.parse(artifact.content) as { sourcePath?: unknown };
    return typeof parsed.sourcePath === 'string' && parsed.sourcePath.length > 0 ? parsed.sourcePath : null;
  } catch {
    return null;
  }
}

export async function importSelectedCodexSessions(sourcePaths: string[], requestId: string): Promise<ImportSelectedResponse> {
  const artifactStore = defaultArtifactStore();
  const failedSessions: ImportSelectedResponse['failedSessions'] = [];
  const loaded: CodexSession[] = [];
  for (const sourcePath of sourcePaths) {
    try {
      const session = await readCodexSession(sourcePath, { artifactStore, artifactMode: 'copy' });
      if (session) {
        loaded.push(session);
      }
    } catch (error) {
      failedSessions.push({ sourcePath, errorMessage: error instanceof Error ? error.message : String(error) });
    }
  }

  // Replace any prior import of the selected sessions so re-import stays idempotent.
  const existing = await collectExistingCodexImports({ rawSessionIds: new Set(loaded.map((session) => session.sessionId)) });
  await deleteExistingImport([...existing.values()].flat());

  let importedSessions = 0;
  let importedTurns = 0;
  for (const session of loaded) {
    try {
      const result = await importCodexSession(session);
      if (result.importedTurns > 0) {
        importedSessions += 1;
        importedTurns += result.importedTurns;
      }
    } catch (error) {
      failedSessions.push({ sourcePath: session.sourcePath, errorMessage: error instanceof Error ? error.message : String(error) });
    }
  }

  return { importedSessions, importedTurns, failedSessions, requestId };
}

export const __testing = {
  readCodexSession,
  defaultArtifactStore,
};
