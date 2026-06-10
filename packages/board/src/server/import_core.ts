import { addMessage, turns } from '@muninn/core';
import {
  defaultArtifactStore,
  importMarker,
  markerFromTurn,
  toTurnContent,
  type ArtifactMode,
  type CodexSession,
} from '@muninn/codex';
import type {
  ImportAgentProject,
  ImportSelectedResponse,
  ImportSessionsListResponse,
} from '@muninn/types';

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
  readSession(sourcePath: string, options: { artifactStore: string; artifactMode: ArtifactMode }): Promise<CodexSession | null>;
  isExcluded?(session: CodexSession): boolean;
};

const DELETE_BATCH_SIZE = 100;

/** DB-only fast path: sessions already captured into Muninn for this agent. */
export async function listImportedSessions(adapter: ImportAdapter, requestId: string): Promise<ImportSessionsListResponse> {
  const existing = await turns.list({ mode: { type: 'page', offset: 0, limit: 100_000 }, agent: adapter.agent });

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
        sourcePath: sourcePathFromTurn(turn, adapter.markerKey) ?? '',
        updatedAt: turn.updatedAt,
        turnCount: 0,
        artifactCount: 0,
      };
      bySession.set(sessionId, aggregate);
    }
    aggregate.turnCount += 1;
    aggregate.artifactCount += (turn.artifacts ?? []).filter((artifact) => artifact.key !== adapter.markerKey).length;
    if (turn.title && turn.createdAt <= aggregate.firstCreatedAt) {
      aggregate.title = turn.title;
      aggregate.firstCreatedAt = turn.createdAt;
    }
    if (turn.updatedAt > aggregate.updatedAt) {
      aggregate.updatedAt = turn.updatedAt;
    }
    if (!aggregate.sourcePath) {
      aggregate.sourcePath = sourcePathFromTurn(turn, adapter.markerKey) ?? '';
    }
  }

  const projects = groupProjects([...bySession.values()].map((aggregate) => ({
    projectKey: aggregate.project,
    cwd: aggregate.cwd,
    session: {
      sessionId: aggregate.sessionId,
      title: aggregate.title || aggregate.sessionId.slice(0, 12),
      sourcePath: aggregate.sourcePath,
      updatedAt: aggregate.updatedAt,
      turnCount: aggregate.turnCount,
      artifactCount: aggregate.artifactCount,
      imported: true,
    },
  })));

  return {
    sourceRoot: adapter.sourceRoot,
    projectCount: projects.length,
    sessionCount: bySession.size,
    importedCount: bySession.size,
    projects,
    requestId,
  };
}

/** Disk scan: every local session for this agent, flagged imported/not. */
export async function listLocalSessions(adapter: ImportAdapter, requestId: string): Promise<ImportSessionsListResponse> {
  const artifactStore = defaultArtifactStore();
  const files = await adapter.listSessionFiles();
  // Skip any file that fails to parse (e.g. a transcript too large to read into
  // a string) so one bad file never fails the whole listing.
  const sessions = (await Promise.all(files.map((file) => adapter.readSession(file, { artifactStore, artifactMode: 'preview' }).catch(() => null))))
    .filter((session): session is CodexSession => session !== null)
    .filter((session) => !adapter.isExcluded?.(session))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  const importedIds = await importedSessionIds(adapter);
  const projects = groupProjects(sessions.map((session) => ({
    projectKey: session.projectKey,
    cwd: session.cwd,
    session: {
      sessionId: session.sessionId,
      title: session.title,
      sourcePath: session.sourcePath,
      updatedAt: session.updatedAt,
      turnCount: session.turns.length,
      artifactCount: session.turns.reduce((total, turn) => total + turn.artifacts.length, 0),
      imported: importedIds.has(session.sessionId),
    },
  })));

  return {
    sourceRoot: adapter.sourceRoot,
    projectCount: projects.length,
    sessionCount: sessions.length,
    importedCount: projects.reduce((total, project) => total + project.importedCount, 0),
    projects,
    requestId,
  };
}

/** Import the selected source files; re-import replaces prior turns idempotently. */
export async function importSelectedSessions(adapter: ImportAdapter, sourcePaths: string[], requestId: string): Promise<ImportSelectedResponse> {
  const artifactStore = defaultArtifactStore();
  const failedSessions: ImportSelectedResponse['failedSessions'] = [];
  const loaded: CodexSession[] = [];
  for (const sourcePath of sourcePaths) {
    try {
      const session = await adapter.readSession(sourcePath, { artifactStore, artifactMode: 'copy' });
      if (session) {
        loaded.push(session);
      }
    } catch (error) {
      failedSessions.push({ sourcePath, errorMessage: error instanceof Error ? error.message : String(error) });
    }
  }

  const selectedIds = new Set(loaded.map((session) => session.sessionId));
  await deleteExistingTurns(adapter, selectedIds);

  let importedSessions = 0;
  let importedTurns = 0;
  for (const session of loaded) {
    try {
      let turnsForSession = 0;
      const seen = new Set<string>();
      for (const [index, turn] of session.turns.entries()) {
        const marker = importMarker(session, index);
        if (seen.has(marker)) {
          continue;
        }
        await addMessage(toTurnContent(session, turn, index, { agent: adapter.agent, ingest: adapter.ingest, markerKey: adapter.markerKey }));
        seen.add(marker);
        turnsForSession += 1;
      }
      if (turnsForSession > 0) {
        importedSessions += 1;
        importedTurns += turnsForSession;
      }
    } catch (error) {
      failedSessions.push({ sourcePath: session.sourcePath, errorMessage: error instanceof Error ? error.message : String(error) });
    }
  }

  return { importedSessions, importedTurns, failedSessions, requestId };
}

async function importedSessionIds(adapter: ImportAdapter): Promise<Set<string>> {
  const existing = await turns.list({ mode: { type: 'page', offset: 0, limit: 100_000 }, agent: adapter.agent });
  const ids = new Set<string>();
  for (const turn of existing) {
    const marker = markerFromTurn(turn, adapter.markerKey);
    const sessionId = marker?.split('#', 1)[0] ?? turn.sessionId ?? '';
    if (sessionId) {
      ids.add(sessionId);
    }
  }
  return ids;
}

async function deleteExistingTurns(adapter: ImportAdapter, sessionIds: Set<string>): Promise<number> {
  if (sessionIds.size === 0) {
    return 0;
  }
  const existing = await turns.list({ mode: { type: 'page', offset: 0, limit: 100_000 }, agent: adapter.agent });
  const turnIds: string[] = [];
  for (const turn of existing) {
    const marker = markerFromTurn(turn, adapter.markerKey);
    const sessionId = marker?.split('#', 1)[0] ?? turn.sessionId ?? '';
    if (sessionId && sessionIds.has(sessionId)) {
      turnIds.push(turn.turnId);
    }
  }
  let deleted = 0;
  for (let index = 0; index < turnIds.length; index += DELETE_BATCH_SIZE) {
    deleted += (await turns.delete({ turnIds: turnIds.slice(index, index + DELETE_BATCH_SIZE) })).deleted;
  }
  return deleted;
}

function groupProjects(rows: Array<{ projectKey: string; cwd: string; session: ImportAgentProject['sessions'][number] }>): ImportAgentProject[] {
  const grouped = new Map<string, ImportAgentProject>();
  for (const row of rows) {
    const project = grouped.get(row.projectKey) ?? {
      projectKey: row.projectKey,
      cwd: row.cwd,
      sessionCount: 0,
      importedCount: 0,
      sessions: [],
    };
    project.sessions.push(row.session);
    project.sessionCount += 1;
    project.importedCount += row.session.imported ? 1 : 0;
    grouped.set(row.projectKey, project);
  }
  for (const project of grouped.values()) {
    project.sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
  return [...grouped.values()].sort((left, right) => (
    (right.sessions[0]?.updatedAt ?? '').localeCompare(left.sessions[0]?.updatedAt ?? '')
  ));
}

function sourcePathFromTurn(turn: { artifacts?: Array<{ key: string; content?: string }> | null }, markerKey: string): string | null {
  const artifact = turn.artifacts?.find((item) => item.key === markerKey);
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
