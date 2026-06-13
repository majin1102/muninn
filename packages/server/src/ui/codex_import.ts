import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureTurn, turns } from '@muninn/core';
import {
  CODEX_IMPORT_AGENT,
  IMPORT_ARTIFACT_KEY,
  defaultArtifactStore,
  importMarker,
  markerFromTurn,
  readCodexSession,
  readCodexSessionSummary,
  toTurnContent,
  type ArtifactMode,
  type CodexSession,
} from '@muninn/codex';
import type {
  CodexImportPreviewResponse,
  CodexImportProjectPreview,
  CodexImportRunResponse,
  CodexImportSessionPreview,
} from '@muninn/types';
import * as SessionIdentity from '@muninn/types/session-identity';
import type { ImportAdapter } from './import_core.js';

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
  const selectedSessionKeys = new Set(selection.sessions.map((session) => SessionIdentity.sessionIdentityKey({
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
  for (const [index, turn] of session.turns.entries()) {
    const marker = importMarker(session, index);
    if (importedMarkers.has(marker)) {
      skippedTurns += 1;
      continue;
    }

    await captureTurn(toTurnContent(session, turn, index));
    importedMarkers.add(marker);
    importedTurns += 1;
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
    const key = SessionIdentity.sessionIdentityKey({ project: turn.project, agent: CODEX_IMPORT_AGENT, sessionId });
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
