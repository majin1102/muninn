import type { NativeTables, SessionSearchRow } from '../native.js';
import { embedText } from '../llm/embedding-provider.js';
import type { SessionThread, SnapshotContent } from './session.js';
import { extractionSummary, extractionTitle } from './extraction.js';

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
