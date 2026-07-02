import type { NativeTables, SessionSearchIdentity, SessionSearchRow, SessionSnapshotRow } from '../native.js';
import { embedText } from '../llm/embedding-provider.js';
import type { SessionThread, SnapshotContent } from './session.js';
import { extractionSummary, extractionTitle } from './extraction.js';
import { parseSnapshotContent } from './snapshot.js';
import type { SessionIndex } from '../session-index.js';
import { sessionIdentityKey } from '@muninn/common/session-identity';

export const SESSION_SEARCH_TEXT_LIMIT = 16_000;

export async function upsertSessionSearchRow(
  client: NativeTables,
  thread: SessionThread,
  snapshot: SnapshotContent,
  latestSnapshotId: string,
  signal?: AbortSignal,
): Promise<void> {
  await client.sessionSearchTable.upsert({
    rows: [await buildSessionSearchRow(thread, snapshot, latestSnapshotId, signal)],
  });
}

export async function buildSessionSearchRow(
  thread: SessionThread,
  snapshot: SnapshotContent,
  latestSnapshotId: string,
  signal?: AbortSignal,
): Promise<SessionSearchRow> {
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
    searchText: sessionSearchText(snapshot, title, summary),
    vector: await embedText(sessionVectorText(title, summary), signal),
    updatedAt: thread.updatedAt,
  };
}

export async function rebuildSessionSearch(
  client: NativeTables,
  sessionIndex: Pick<SessionIndex, 'list'>,
  signal?: AbortSignal,
): Promise<void> {
  const [entries, snapshots] = await Promise.all([
    sessionIndex.list(client),
    client.sessionTable.listSnapshots({}),
  ]);
  const liveKeys = new Set(entries.map(identityKey));
  const rows: SessionSearchRow[] = [];
  for (const snapshot of latestSnapshotsByIdentity(snapshots).values()) {
    if (liveKeys.has(identityKey(snapshot))) {
      rows.push(await rowFromSnapshot(snapshot, signal));
    }
  }
  await client.sessionSearchTable.replaceAll({ rows });
}

export function sessionVectorText(title: string, summary: string): string {
  return `${title}\n\n${summary}`;
}

export function sessionSearchText(snapshot: SnapshotContent, title: string, summary: string): string {
  const sections = [title, summary];
  for (const extraction of snapshot.extractions) {
    const titleText = extractionTitle(extraction);
    sections.push(titleText, extractionSummary(titleText, extraction));
  }
  return sections
    .map((section) => section.trim())
    .filter(Boolean)
    .join('\n\n')
    .slice(0, SESSION_SEARCH_TEXT_LIMIT);
}

function identityKey(identity: SessionSearchIdentity): string {
  return sessionIdentityKey(identity);
}

function latestSnapshotsByIdentity(snapshots: SessionSnapshotRow[]): Map<string, SessionSnapshotRow> {
  const latest = new Map<string, SessionSnapshotRow>();
  for (const snapshot of snapshots) {
    const key = identityKey(snapshot);
    const current = latest.get(key);
    if (
      !current
      || snapshot.snapshotSequence > current.snapshotSequence
      || (
        snapshot.snapshotSequence === current.snapshotSequence
        && snapshot.updatedAt > current.updatedAt
      )
    ) {
      latest.set(key, snapshot);
    }
  }
  return latest;
}

async function rowFromSnapshot(snapshot: SessionSnapshotRow, signal?: AbortSignal): Promise<SessionSearchRow> {
  const parsed = parseSnapshotContent(snapshot.content, new Set(snapshot.references));
  const content: SnapshotContent = {
    threadKind: 'session',
    sessionId: snapshot.sessionId,
    project: snapshot.project,
    cwd: snapshot.cwd,
    agent: snapshot.agent,
    snapshotContent: parsed.snapshotContent,
    memorySignals: parsed.memorySignals,
    skillSignals: parsed.skillSignals,
    skillDetails: parsed.skillDetails,
    extractions: parsed.extractions,
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
    title: parsed.title,
    summary: parsed.summary,
    searchText: sessionSearchText(content, parsed.title, parsed.summary),
    vector: await embedText(sessionVectorText(parsed.title, parsed.summary), signal),
    updatedAt: snapshot.updatedAt,
  };
}
