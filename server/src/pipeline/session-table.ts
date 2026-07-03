import type { NativeTables, SessionRow, SessionSnapshotRow } from '../native.js';
import { embedText } from '../llm/embedding-provider.js';
import type { SessionThread, SnapshotContent } from './session.js';
import { extractionSummary, extractionTitle } from './extraction.js';
import { parseSnapshotContent } from './snapshot.js';
import type { SessionIndex } from '../session-index.js';

export const SESSION_TEXT_LIMIT = 16_000;

export async function upsertSessionRow(
  client: NativeTables,
  thread: SessionThread,
  snapshot: SnapshotContent,
  latestSnapshotId: string,
  signal?: AbortSignal,
): Promise<void> {
  await client.sessionTable.upsert({
    rows: [await buildSessionRow(thread, snapshot, latestSnapshotId, signal)],
  });
}

export async function buildSessionRow(
  thread: SessionThread,
  snapshot: SnapshotContent,
  latestSnapshotId: string,
  signal?: AbortSignal,
): Promise<SessionRow> {
  const title = thread.title;
  const summary = thread.summary;
  return {
    latestSnapshotId,
    project: thread.project,
    cwd: thread.cwd,
    agent: thread.agent,
    sessionId: thread.sessionId ?? thread.threadId,
    title,
    summary,
    searchText: sessionText(snapshot, title, summary),
    vector: await embedText(sessionVectorText(title, summary), signal),
    updatedAt: thread.updatedAt,
  };
}

export async function rebuildSessionTable(
  client: NativeTables,
  sessionIndex: Pick<SessionIndex, 'list'>,
  signal?: AbortSignal,
): Promise<void> {
  const [entries, snapshots] = await Promise.all([
    sessionIndex.list(client),
    client.sessionSnapshotTable.listSnapshots({}),
  ]);
  const snapshotsById = snapshotsByIdMap(snapshots);
  const rows: SessionRow[] = [];
  for (const entry of entries) {
    if (entry.snapshotId) {
      const snapshot = snapshotsById.get(entry.snapshotId);
      if (snapshot) {
        rows.push(await rowFromSnapshot(snapshot, signal));
      }
    }
  }
  await client.sessionTable.replaceAll({ rows });
}

export function sessionVectorText(title: string, summary: string): string {
  return `${title}\n\n${summary}`;
}

export function sessionText(snapshot: SnapshotContent, title: string, summary: string): string {
  const sections = [title, summary];
  for (const extraction of snapshot.extractions) {
    const titleText = extractionTitle(extraction);
    sections.push(titleText, extractionSummary(titleText, extraction));
  }
  return sections
    .map((section) => section.trim())
    .filter(Boolean)
    .join('\n\n')
    .slice(0, SESSION_TEXT_LIMIT);
}

function snapshotsByIdMap(snapshots: SessionSnapshotRow[]): Map<string, SessionSnapshotRow> {
  const byId = new Map<string, SessionSnapshotRow>();
  for (const snapshot of snapshots) {
    byId.set(snapshot.snapshotId, snapshot);
  }
  return byId;
}

async function rowFromSnapshot(snapshot: SessionSnapshotRow, signal?: AbortSignal): Promise<SessionRow> {
  let parsed: ReturnType<typeof parseSnapshotContent> | null = null;
  try {
    parsed = parseSnapshotContent(snapshot.content, new Set(snapshot.references));
  } catch {
    parsed = null;
  }
  const title = parsed?.title ?? snapshot.title;
  const summary = parsed?.summary ?? snapshot.summary;
  const content: SnapshotContent = {
    threadKind: 'session',
    sessionId: snapshot.sessionId,
    project: snapshot.project,
    cwd: snapshot.cwd,
    agent: snapshot.agent,
    snapshotContent: parsed?.snapshotContent ?? '',
    memorySignals: parsed?.memorySignals ?? [],
    skillSignals: parsed?.skillSignals ?? [],
    skillDetails: parsed?.skillDetails ?? {},
    extractions: parsed?.extractions ?? [],
    contextRefs: snapshot.references.map((turnId) => ({ turnId, summary: turnId })),
    nextSteps: [],
    extractionChanges: [],
  };
  return {
    latestSnapshotId: snapshot.snapshotId,
    project: snapshot.project,
    cwd: snapshot.cwd,
    agent: snapshot.agent,
    sessionId: snapshot.sessionId,
    title,
    summary,
    searchText: sessionText(content, title, summary),
    vector: await embedText(sessionVectorText(title, summary), signal),
    updatedAt: snapshot.updatedAt,
  };
}
