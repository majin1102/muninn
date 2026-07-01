import { Hono } from 'hono';
import type {
  AgentNode,
  ErrorResponse,
  MemoryDocumentResponse,
  MemoryReference,
  SessionAgentsResponse,
  SessionGroupsResponse,
  SessionNode,
  SessionSegmentPreview,
  SessionSnapshotListResponse,
  SessionTimelineItem,
  SessionTurnDetailResponse,
  SessionTimelineResponse,
  SessionTurnPositionResponse,
  SessionTurnsResponse,
  TurnPreview,
} from '@muninn/common';
import { memories, sessions, turns } from '../backend.js';
import { renderRenderedMemoryDocument } from './render.js';

export const sessionRoutes = new Hono();

const AGENT_DEFAULT_SESSION_PREFIX = '__agent_default__:';
const EXTRACTOR_DEFAULT_SESSION_PREFIX = '__extractor_default__:';
const INTERNAL_SESSION_SUFFIX = /-?[0-9a-f]{8}$/i;
const DEFAULT_AUTO_EXPAND_TURN_LIMIT = 20;
const SESSION_TREE_PAGE_LIMIT = 1_000_000;
const TOOL_IO_PREVIEW_CHARS = 600;

export const SESSION_SNAPSHOTS_ROUTE = '/app/api/session/snapshots';

export function sessionDisplayTitle(sessionKey: string): string {
  const raw = sessionKey.trim();
  const withoutSuffix = raw.replace(INTERNAL_SESSION_SUFFIX, '').replace(/-+$/g, '').trim();
  const slashIndex = withoutSuffix.lastIndexOf('/');
  const title = slashIndex >= 0 ? withoutSuffix.slice(slashIndex + 1).trim() : withoutSuffix;
  return title || raw || sessionKey;
}

export function shouldAutoExpandSession(turnCount: number): boolean {
  return turnCount <= DEFAULT_AUTO_EXPAND_TURN_LIMIT;
}

export const __testing = {
  sessionDisplayTitle,
  shouldAutoExpandSession,
};

let sessionTreeCache: Awaited<ReturnType<typeof turns.list>> | null = null;
let sessionTreeLoading: Promise<Awaited<ReturnType<typeof turns.list>>> | null = null;
let sessionTreeLoadCount = 0;
let sessionTreeCacheGeneration = 0;

function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

function errorResponse(errorCode: string, errorMessage: string): ErrorResponse {
  return {
    errorCode,
    errorMessage,
    requestId: generateRequestId(),
  };
}

function mapCoreLookupError(error: unknown): { status: number; body: ErrorResponse } {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();

  if (
    lowered.includes('invalid')
    || lowered.includes('memory layer')
  ) {
    return {
      status: 400,
      body: errorResponse('invalidRequest', message),
    };
  }

  return {
    status: 500,
    body: errorResponse('internalError', 'internal server error'),
  };
}

type AppSessionTurn = Awaited<ReturnType<typeof turns.list>>[number];
type AppSessionIndexEntry = Awaited<ReturnType<typeof sessions.index>>[number];

function normalizeText(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveSessionNode(turn: Pick<AppSessionTurn, 'sessionId' | 'agent' | 'extractor' | 'project' | 'cwd'>): {
  sessionKey: string;
  displaySessionId: string;
  projectKey: string;
  cwd?: string;
} {
  const sessionId = normalizeText(turn.sessionId);
  if (sessionId) {
    const projectKey = normalizeText(turn.project) ?? 'default';
    return {
      sessionKey: sessionId,
      displaySessionId: sessionDisplayTitle(sessionId),
      projectKey,
      cwd: normalizeText(turn.cwd),
    };
  }

  const agent = normalizeText(turn.agent);
  if (agent) {
    return {
      sessionKey: `${AGENT_DEFAULT_SESSION_PREFIX}${agent}`,
      displaySessionId: 'Default Session',
      projectKey: normalizeText(turn.project) ?? 'default',
      cwd: normalizeText(turn.cwd),
    };
  }

  const extractor = normalizeText(turn.extractor) ?? 'extractor';
  return {
    sessionKey: `${EXTRACTOR_DEFAULT_SESSION_PREFIX}${extractor}`,
    displaySessionId: `Default Session (${extractor})`,
    projectKey: normalizeText(turn.project) ?? 'default',
    cwd: normalizeText(turn.cwd),
  };
}

function resolveSessionNodeFromIndex(entry: AppSessionIndexEntry): SessionNode {
  return {
    sessionKey: entry.sessionId,
    displaySessionId: resolveIndexedSessionTitle(entry),
    projectKey: entry.project,
    cwd: entry.cwd,
    latestUpdatedAt: entry.latestUpdatedAt,
  };
}

function resolveIndexedSessionTitle(entry: Pick<AppSessionIndexEntry, 'sessionId' | 'title'>): string {
  const title = normalizeText(entry.title);
  if (title && !isGeneratedSessionTitle(entry.sessionId, title)) {
    return title;
  }
  return sessionDisplayTitle(entry.sessionId);
}

function isGeneratedSessionTitle(sessionId: string, title: string): boolean {
  return title === `Session ${sessionId}`;
}

export function resolveSessionNodeFromIndexForTests(entry: AppSessionIndexEntry): SessionNode {
  return resolveSessionNodeFromIndex(entry);
}

function matchesSessionNode(turn: AppSessionTurn, sessionKey: string): boolean {
  return resolveSessionNode(turn).sessionKey === sessionKey;
}

function isDefaultSessionKey(sessionKey: string): boolean {
  return sessionKey.startsWith(AGENT_DEFAULT_SESSION_PREFIX)
    || sessionKey.startsWith(EXTRACTOR_DEFAULT_SESSION_PREFIX);
}

function hasTurnPreviewContent(turn: Pick<AppSessionTurn, 'prompt' | 'response' | 'events' | 'artifacts'>): boolean {
  return Boolean(
    normalizeText(turn.prompt)
      || normalizeText(turn.response)
      || turnEvents(turn).length > 0
      || (Array.isArray(turn.artifacts) && turn.artifacts.length > 0),
  );
}

function turnPreviewText(turn: Pick<AppSessionTurn, 'prompt' | 'response'>): string {
  const parts = [
    normalizeText(turn.prompt) ? `Prompt: ${turn.prompt!.trim()}` : null,
    normalizeText(turn.response) ? `Response: ${turn.response!.trim()}` : null,
  ].filter(Boolean);
  return parts.join('\n\n');
}

export function invalidateSessionTreeCache() {
  sessionTreeCacheGeneration += 1;
  sessionTreeCache = null;
  sessionTreeLoading = null;
}

export function resetSessionTreeCacheForTests() {
  sessionTreeCache = null;
  sessionTreeLoading = null;
  sessionTreeLoadCount = 0;
  sessionTreeCacheGeneration = 0;
}

export function getSessionTreeLoadCountForTests() {
  return sessionTreeLoadCount;
}

async function loadAllSessionTurns(): Promise<Awaited<ReturnType<typeof turns.list>>> {
  if (sessionTreeCache) {
    return sessionTreeCache;
  }

  if (!sessionTreeLoading) {
    const loadGeneration = sessionTreeCacheGeneration;
    const loadingPromise = turns
      .list({
        mode: { type: 'page', offset: 0, limit: SESSION_TREE_PAGE_LIMIT },
      })
      .then((turns) => {
        if (sessionTreeCacheGeneration === loadGeneration) {
          sessionTreeCache = turns;
          sessionTreeLoadCount += 1;
        }
        return turns;
      })
      .finally(() => {
        if (sessionTreeLoading === loadingPromise) {
          sessionTreeLoading = null;
        }
      });
    sessionTreeLoading = loadingPromise;
  }
  return sessionTreeLoading!;
}

function toTurnPreview(turn: AppSessionTurn): TurnPreview {
  const events = turnEvents(turn);
  return {
    memoryId: turn.turnId,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
    turnSequence: turn.turnSequence ?? undefined,
    preview: turnPreviewText(turn),
    prompt: turn.prompt ?? undefined,
    response: turn.response ?? undefined,
    events: events.length > 0 ? previewTurnEvents(events) : undefined,
    artifacts: turn.artifacts ?? undefined,
  };
}

function toTurnDetail(turn: AppSessionTurn): TurnPreview {
  const events = turnEvents(turn);
  return {
    memoryId: turn.turnId,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
    turnSequence: turn.turnSequence ?? undefined,
    preview: turnPreviewText(turn),
    prompt: turn.prompt ?? undefined,
    response: turn.response ?? undefined,
    events: events.length > 0 ? events : undefined,
    artifacts: turn.artifacts ?? undefined,
    toolCalls: toolCallsFromEvents(events),
  };
}

function turnEvents(turn: Pick<AppSessionTurn, 'events'>): NonNullable<AppSessionTurn['events']> {
  return Array.isArray((turn as { events?: AppSessionTurn['events'] }).events)
    ? (turn as { events: NonNullable<AppSessionTurn['events']> }).events
    : [];
}

function toolCallsFromEvents(events: NonNullable<AppSessionTurn['events']>): TurnPreview['toolCalls'] {
  const toolCalls: NonNullable<TurnPreview['toolCalls']> = [];
  const toolCallIndexById = new Map<string, number>();
  for (const event of events) {
    if (event.type === 'toolCall') {
      const index = toolCalls.length;
      toolCalls.push({
        id: event.id,
        name: event.name,
        input: event.input,
      });
      if (event.id) {
        toolCallIndexById.set(event.id, index);
      }
      continue;
    }
    if (event.type !== 'toolOutput') {
      continue;
    }
    const index = event.id ? toolCallIndexById.get(event.id) : undefined;
    if (index !== undefined) {
      toolCalls[index] = {
        ...toolCalls[index],
        output: event.output,
      };
    } else if (event.output) {
      toolCalls.push({
        id: event.id,
        name: 'tool_output',
        output: event.output,
      });
    }
  }
  return toolCalls.length > 0 ? toolCalls : undefined;
}

function previewTurnEvents(events: NonNullable<AppSessionTurn['events']>): NonNullable<TurnPreview['events']> {
  return events.map((event) => {
    if (event.type === 'toolCall') {
      const input = previewPayload(event.input);
      return {
        type: 'toolCall',
        id: event.id,
        name: event.name,
        timestamp: event.timestamp,
        ...(input ? {
          inputPreview: input.preview,
          inputBytes: input.bytes,
          inputTruncated: input.truncated,
        } : {}),
      };
    }

    if (event.type === 'toolOutput') {
      const output = previewPayload(event.output);
      const artifactCount = event.artifacts?.length ?? 0;
      return {
        type: 'toolOutput',
        id: event.id,
        timestamp: event.timestamp,
        ...(output ? {
          outputPreview: output.preview,
          outputBytes: output.bytes,
          outputTruncated: output.truncated,
        } : {}),
        ...(artifactCount > 0 ? { artifactCount } : {}),
        artifacts: event.artifacts,
      };
    }

    return event;
  });
}

function previewPayload(value: string | undefined): { preview: string; bytes: number; truncated: boolean } | null {
  if (value === undefined) {
    return null;
  }
  const truncated = value.length > TOOL_IO_PREVIEW_CHARS;
  return {
    preview: truncated ? `${value.slice(0, TOOL_IO_PREVIEW_CHARS).trimEnd()}...` : value,
    bytes: Buffer.byteLength(value),
    truncated,
  };
}

async function enrichMemoryDocument(
  document: MemoryDocumentResponse['document'],
  memoryId: string,
): Promise<MemoryDocumentResponse['document']> {
  if (!memoryId.startsWith('turn:')) {
    return document;
  }
  const turn = await turns.get(memoryId);
  if (!turn) {
    return document;
  }
  const events = turnEvents(turn);
  return {
    ...document,
    agent: turn.agent,
    extractor: turn.extractor,
    sessionId: turn.sessionId ?? undefined,
    project: turn.project,
    cwd: turn.cwd,
    metadata: turn.metadata ?? undefined,
    prompt: turn.prompt ?? undefined,
    response: turn.response ?? undefined,
    events: events.length > 0 ? events : undefined,
    toolCalls: toolCallsFromEvents(events),
    artifacts: turn.artifacts ?? undefined,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
  };
}

async function loadSessionTurnPreviewsPage(params: {
  agent: string;
  project: string;
  sessionKey: string;
  offset: number;
  limit: number;
}): Promise<{
  turns: TurnPreview[];
  nextOffset: number | null;
}> {
  const pageRows: AppSessionTurn[] = [];
  const queryLimit = params.limit + 1;
  let rawOffset = params.offset;
  let nextOffset: number | null = null;

  while (nextOffset === null) {
    const rows = await turns.list({
      mode: { type: 'page', offset: rawOffset, limit: queryLimit },
      project: params.project,
      agent: params.agent,
      ...(isDefaultSessionKey(params.sessionKey) ? {} : { sessionId: params.sessionKey }),
    });
    if (rows.length === 0) {
      break;
    }

    for (let index = 0; index < rows.length; index += 1) {
      const turn = rows[index]!;
      if (
        !matchesSessionNode(turn, params.sessionKey)
        || turn.project !== params.project
        || !hasTurnPreviewContent(turn)
      ) {
        continue;
      }
      if (pageRows.length >= params.limit) {
        nextOffset = rawOffset + index;
        break;
      }
      pageRows.push(turn);
    }

    if (nextOffset !== null || rows.length < queryLimit) {
      break;
    }
    rawOffset += rows.length;
  }

  return {
    turns: pageRows.map(toTurnPreview),
    nextOffset,
  };
}

type SessionSnapshotContent = {
  snapshotId: string;
  content: string;
  createdAt: string;
  updatedAt: string;
};

async function loadSessionSnapshotContent(project: string, agent: string, sessionKey: string): Promise<SessionSnapshotContent | null> {
  const sessionIndex = await sessions.index();
  const session = sessionIndex.find((entry) => (
    entry.project === project
    && entry.agent === agent
    && entry.sessionId === sessionKey
  ));

  if (!session?.snapshotId) {
    return null;
  }

  const snapshot = await sessions.get(session.snapshotId);
  if (!snapshot) {
    return null;
  }

  return {
    snapshotId: snapshot.snapshotId,
    content: snapshot.content,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
  };
}

function buildSessionTurnPage(params: {
  turns: TurnPreview[];
  offset: number;
  limit: number;
}): {
  turns: TurnPreview[];
  nextOffset: number | null;
} {
  const pageTurns = params.turns.slice(params.offset, params.offset + params.limit);
  return {
    turns: pageTurns,
    nextOffset: resolveSessionTreeNextOffset({
      offset: params.offset,
      limit: params.limit,
      turnCount: params.turns.length,
    }),
  };
}

function resolveSessionTreeNextOffset(params: {
  offset: number;
  limit: number;
  turnCount: number;
}): number | null {
  return params.offset + params.limit < params.turnCount ? params.offset + params.limit : null;
}

export function resolveSessionTreeNextOffsetForTests(params: {
  offset: number;
  limit: number;
  turnCount: number;
}): number | null {
  return resolveSessionTreeNextOffset(params);
}

function buildSessionTimelinePage(params: {
  snapshot?: SessionSnapshotContent | null;
  turnPreviews: TurnPreview[];
}): {
  segments: SessionSegmentPreview[];
  timeline: SessionTimelineItem[];
} {
  const timeline = buildSessionTimeline(params.snapshot, params.turnPreviews);
  return {
    segments: buildSessionSegments(timeline),
    timeline,
  };
}

function buildSessionSegments(
  timeline: SessionTimelineItem[],
): SessionSegmentPreview[] {
  return timeline.filter((item) => item.kind === 'extraction').map((item) => ({
    memoryId: item.memoryId,
    title: item.title,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }));
}

function buildSessionTimeline(
  snapshot: SessionSnapshotContent | null | undefined,
  turnPreviews: TurnPreview[],
): SessionTimelineItem[] {
  if (!snapshot?.content) {
    return [];
  }
  const sections = snapshotSections(snapshot.content);
  const items: SessionTimelineItem[] = [];
  const summary = sections.get('summary')?.trim();
  if (summary) {
    items.push({
      memoryId: `${snapshot.snapshotId}~timeline:summary`,
      kind: 'summary',
      title: 'Summary',
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      markdown: summary,
      refs: [],
    });
  }
  items.push(...buildTimelineSignalItems(sections, snapshot));
  const extractions = buildTimelineExtractions(sections.get('extractions'), snapshot, turnPreviews);
  return [...items, ...extractions];
}

function buildTimelineSignalItems(
  sections: Map<string, string>,
  snapshot: SessionSnapshotContent,
): SessionTimelineItem[] {
  const definitions = [
    { heading: 'Instruction Signals', title: 'Instruction Signals', suffix: 'instructions' },
    { heading: 'Skill Signals', title: 'Skill Signals', suffix: 'skills' },
  ];
  const items: SessionTimelineItem[] = [];
  for (const { heading, title, suffix } of definitions) {
    const body = sections.get(heading.toLowerCase())?.trim();
    if (!body) {
      continue;
    }
    items.push({
      memoryId: `${snapshot.snapshotId}~timeline:${suffix}`,
      kind: 'signals',
      title,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      markdown: normalizeTimelineSignalsMarkdown(body),
      refs: [],
    });
  }
  return items;
}

function normalizeTimelineSignalsMarkdown(raw: string): string {
  return raw.replace(
    /^(\s*[-*]\s*)\[((?:turn:[^\]\n]+?\+\d+\s*,?\s*)+)\]\s+/gm,
    (match, bulletPrefix: string, evidence: string) => {
      const contribution = [...evidence.matchAll(/\+(\d+)/g)]
        .reduce((total, item) => total + Number(item[1] ?? 0), 0);
      if (contribution <= 0) {
        return match;
      }
      return `${bulletPrefix}&lt;${contribution}&gt; `;
    },
  );
}

function snapshotSections(snapshotContent: string): Map<string, string> {
  const sections = new Map<string, string>();
  const headingPattern = /^##\s+(.+?)\s*$/gim;
  const matches = [...snapshotContent.matchAll(headingPattern)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const next = matches[index + 1];
    const lineEnd = snapshotContent.indexOf('\n', match.index!);
    const bodyStart = lineEnd >= 0 ? lineEnd + 1 : snapshotContent.length;
    const bodyEnd = next?.index ?? snapshotContent.length;
    sections.set(match[1]!.trim().toLowerCase(), snapshotContent.slice(bodyStart, bodyEnd));
  }
  return sections;
}

function buildTimelineExtractions(
  section: string | undefined,
  snapshot: SessionSnapshotContent,
  turnPreviews: TurnPreview[],
): SessionTimelineItem[] {
  if (!section?.trim()) {
    return [];
  }
  const turnById = new Map(turnPreviews.map((turn, index) => [turn.memoryId, { turn, index }]));
  const refsPattern = /<!--\s*(?:sequence:\s*\d+\s*;\s*)?refs:\s*\[([^\]]*)\]\s*-->/g;
  const matches = [...section.matchAll(refsPattern)];
  const timeline: SessionTimelineItem[] = [];

  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i]!;
    const next = matches[i + 1];
    const block = section.slice(match.index! + match[0].length, next?.index ?? section.length);
    const title = normalizeSegmentTitle(block);
    if (!title) {
      continue;
    }
    const refs = parseExtractionRefs(match[1]);
    const firstTurn = refs
      .map((ref) => turnById.get(ref))
      .find((entry) => entry !== undefined);
    timeline.push({
      memoryId: firstTurn ? `${firstTurn.turn.memoryId}~timeline:${i}` : `${snapshot.snapshotId}~timeline:ext:${i}`,
      kind: 'extraction',
      title,
      createdAt: firstTurn?.turn.createdAt ?? snapshot.createdAt,
      updatedAt: firstTurn?.turn.updatedAt ?? snapshot.updatedAt,
      markdown: normalizeTimelineExtractionMarkdown(block),
      refs,
    });
  }

  return timeline;
}

function normalizeTimelineExtractionMarkdown(raw: string): string {
  const withoutTitle = stripMarkdownHeadingSection(raw, 'Title')
    .replace(/^\s*----\s*$/gm, '')
    .trim();
  if (withoutTitle) {
    return withoutTitle;
  }
  return raw.trim();
}

function normalizeSegmentTitle(raw: string): string {
  let title = raw.trim();
  const explicitTitle = extractMarkdownHeadingSection(title, 'Title');
  const summary = extractMarkdownHeadingSection(title, 'Summary');
  if (explicitTitle) {
    title = explicitTitle;
  } else if (summary) {
    title = summary;
  }
  title = title
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^Prompt:\s*/i, '');
  const responseStart = title.search(/\bResponse:\s*/i);
  if (responseStart > 0) {
    title = title.slice(0, responseStart).trim();
  }
  return title;
}

function extractMarkdownHeadingSection(raw: string, heading: string): string | undefined {
  const escapedHeading = escapeRegex(heading);
  const match = raw.match(new RegExp(
    `(?:^|\\n)###\\s+${escapedHeading}\\s*\\n([\\s\\S]*?)(?=\\n###\\s+|\\n\\s*----\\s*(?:\\n|$)|$)`,
    'i',
  ));
  const value = match?.[1]?.trim();
  return value ? value : undefined;
}

function stripMarkdownHeadingSection(raw: string, heading: string): string {
  const escapedHeading = escapeRegex(heading);
  return raw.replace(new RegExp(
    `(?:^|\\n)###\\s+${escapedHeading}\\s*\\n[\\s\\S]*?(?=\\n###\\s+|\\n\\s*----\\s*(?:\\n|$)|$)`,
    'i',
  ), '\n');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseExtractionRefs(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((ref) => ref.trim().replace(/^['"]|['"]$/g, ''))
    .filter((ref) => ref.startsWith('turn:'));
}

function extractionRefsFromSnapshot(snapshot: SessionSnapshotContent | null | undefined): string[] {
  const section = snapshot?.content ? snapshotSections(snapshot.content).get('extractions') : undefined;
  if (!section) {
    return [];
  }
  const refsPattern = /<!--\s*(?:sequence:\s*\d+\s*;\s*)?refs:\s*\[([^\]]*)\]\s*-->/g;
  const refs = new Set<string>();
  for (const match of section.matchAll(refsPattern)) {
    for (const ref of parseExtractionRefs(match[1])) {
      refs.add(ref);
    }
  }
  return [...refs];
}

async function loadTimelineReferenceTurnPreviews(
  snapshot: SessionSnapshotContent | null | undefined,
): Promise<TurnPreview[]> {
  const refs = extractionRefsFromSnapshot(snapshot);
  const rows = await Promise.all(
    refs.map(async (ref) => {
      try {
        const turn = await turns.get(ref);
        return turn && hasTurnPreviewContent(turn) ? toTurnPreview(turn) : null;
      } catch {
        return null;
      }
    }),
  );
  return rows.filter((turn): turn is TurnPreview => turn !== null);
}

async function locateSessionTurnOffset(params: {
  agent: string;
  project: string;
  sessionKey: string;
  turnId: string;
  limit: number;
}): Promise<number | null> {
  const target = await turns.get(params.turnId);
  if (
    !target
    || target.project !== params.project
    || target.agent !== params.agent
    || !matchesSessionNode(target, params.sessionKey)
    || !hasTurnPreviewContent(target)
  ) {
    return null;
  }

  const rows = (await turns.list({
    mode: { type: 'page', offset: 0, limit: SESSION_TREE_PAGE_LIMIT },
    project: params.project,
    agent: params.agent,
    ...(isDefaultSessionKey(params.sessionKey) ? {} : { sessionId: params.sessionKey }),
  }))
    .filter((turn) => matchesSessionNode(turn, params.sessionKey))
    .filter((turn) => turn.project === params.project)
    .filter(hasTurnPreviewContent)
    .sort(compareTurnsForConversation);

  const index = rows.findIndex((turn) => turn.turnId === params.turnId);
  return index >= 0 ? Math.floor(index / params.limit) * params.limit : null;
}

function compareTurnsForConversation(left: AppSessionTurn, right: AppSessionTurn): number {
  const created = left.createdAt.localeCompare(right.createdAt);
  if (created !== 0) {
    return created;
  }
  const updated = left.updatedAt.localeCompare(right.updatedAt);
  if (updated !== 0) {
    return updated;
  }
  return left.turnId.localeCompare(right.turnId);
}

export function buildSessionSegmentsForTests(
  snapshot: SessionSnapshotContent | null | undefined,
  turnPreviews: TurnPreview[],
): SessionSegmentPreview[] {
  return buildSessionSegments(buildSessionTimeline(snapshot, turnPreviews));
}

export function buildSessionTimelineForTests(
  snapshot: SessionSnapshotContent | null | undefined,
  turnPreviews: TurnPreview[],
): SessionTimelineItem[] {
  return buildSessionTimeline(snapshot, turnPreviews);
}

export function extractionRefsFromSnapshotForTests(
  snapshot: SessionSnapshotContent | null | undefined,
): string[] {
  return extractionRefsFromSnapshot(snapshot);
}

export function buildSessionTurnPageForTests(params: {
  turns: TurnPreview[];
  offset: number;
  limit: number;
}): {
  turns: TurnPreview[];
  nextOffset: number | null;
} {
  return buildSessionTurnPage(params);
}

export function buildSessionTimelinePageForTests(params: {
  snapshot?: SessionSnapshotContent | null;
  turnPreviews: TurnPreview[];
}): {
  segments: SessionSegmentPreview[];
  timeline: SessionTimelineItem[];
} {
  return buildSessionTimelinePage(params);
}

export function buildTurnPreviewForTests(turn: AppSessionTurn): TurnPreview {
  return toTurnPreview(turn);
}

export function buildTurnDetailForTests(turn: AppSessionTurn): TurnPreview {
  return toTurnDetail(turn);
}

async function loadSnapshotReferences(references: string[]): Promise<MemoryReference[]> {
  const resolved = await Promise.all(
    references.map(async (memoryId) => {
      if (memoryId.startsWith('turn:')) {
        const turn = await turns.get(memoryId);
        if (!turn || !hasTurnPreviewContent(turn)) {
          return null;
        }
        return {
          memoryId,
          timestamp: turn.updatedAt,
          summary: turnPreviewText(turn),
        };
      }

      if (memoryId.startsWith('session:')) {
        const session = await sessions.get(memoryId);
        if (!session) {
          return null;
        }
        return {
          memoryId,
          timestamp: session.updatedAt,
          summary: session.summary,
        };
      }

      return null;
    }),
  );

  return resolved.filter((item): item is MemoryReference => item !== null);
}

sessionRoutes.get('/app/api/session/agents', async (c) => {
  console.log('[APP_UI_SESSION_AGENTS]');

  const entries = await sessions.index();
  const grouped = new Map<string, string>();

  for (const entry of entries) {
    const agent = normalizeText(entry.agent);
    if (!agent) {
      continue;
    }
    const latest = grouped.get(agent);
    if (!latest || entry.latestUpdatedAt > latest) {
      grouped.set(agent, entry.latestUpdatedAt);
    }
  }

  const agents: AgentNode[] = [...grouped.entries()]
    .map(([agent, latestUpdatedAt]) => ({
      agent,
      latestUpdatedAt,
    }))
    .sort((left, right) => right.latestUpdatedAt.localeCompare(left.latestUpdatedAt));

  const response: SessionAgentsResponse = {
    agents,
    requestId: generateRequestId(),
  };

  return c.json(response);
});

sessionRoutes.get('/app/api/session/agents/:agent/sessions', async (c) => {
  const agent = c.req.param('agent');
  console.log('[APP_UI_SESSION_GROUPS] agent:', agent);

  const sessionNodes = (await sessions.index())
    .filter((entry) => entry.agent === agent)
    .map(resolveSessionNodeFromIndex)
    .sort((left, right) => left.latestUpdatedAt.localeCompare(right.latestUpdatedAt));

  const response: SessionGroupsResponse = {
    sessions: sessionNodes,
    requestId: generateRequestId(),
  };

  return c.json(response);
});

sessionRoutes.get('/app/api/session/agents/:agent/sessions/:sessionKey/turns', async (c) => {
  const agent = c.req.param('agent');
  const sessionKey = c.req.param('sessionKey');
  const project = normalizeText(c.req.query('project'));
  const offsetRaw = c.req.query('offset');
  const limitRaw = c.req.query('limit');

  const offset = offsetRaw ? Number(offsetRaw) : 0;
  const limit = limitRaw ? Number(limitRaw) : 10;

  console.log('[APP_UI_SESSION_TURNS] agent:', agent, 'project:', project, 'sessionKey:', sessionKey, 'offset:', offset, 'limit:', limit);

  if (!project) {
    return c.json(errorResponse('invalidRequest', 'project is required'), 400);
  }

  if (Number.isNaN(offset) || offset < 0) {
    return c.json(errorResponse('invalidRequest', 'offset must be a non-negative number'), 400);
  }

  if (Number.isNaN(limit) || limit <= 0) {
    return c.json(errorResponse('invalidRequest', 'limit must be a positive number'), 400);
  }

  const page = await loadSessionTurnPreviewsPage({
    agent,
    project,
    sessionKey,
    offset,
    limit,
  });

  const response: SessionTurnsResponse = {
    turns: page.turns,
    nextOffset: page.nextOffset,
    requestId: generateRequestId(),
  };

  return c.json(response);
});

sessionRoutes.get('/app/api/session/agents/:agent/sessions/:sessionKey/timeline', async (c) => {
  const agent = c.req.param('agent');
  const sessionKey = c.req.param('sessionKey');
  const project = normalizeText(c.req.query('project'));

  console.log('[APP_UI_SESSION_TIMELINE] agent:', agent, 'project:', project, 'sessionKey:', sessionKey);

  if (!project) {
    return c.json(errorResponse('invalidRequest', 'project is required'), 400);
  }

  const snapshot = await loadSessionSnapshotContent(project, agent, sessionKey);
  const turnPreviews = await loadTimelineReferenceTurnPreviews(snapshot);
  const page = buildSessionTimelinePage({ snapshot, turnPreviews });
  const response: SessionTimelineResponse = {
    segments: page.segments,
    timeline: page.timeline,
    requestId: generateRequestId(),
  };

  return c.json(response);
});

sessionRoutes.get('/app/api/session/agents/:agent/sessions/:sessionKey/turn-position', async (c) => {
  const agent = c.req.param('agent');
  const sessionKey = c.req.param('sessionKey');
  const project = normalizeText(c.req.query('project'));
  const turnId = normalizeText(c.req.query('turnId'));
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Number(limitRaw) : 10;

  console.log('[APP_UI_SESSION_TURN_POSITION] agent:', agent, 'project:', project, 'sessionKey:', sessionKey, 'turnId:', turnId, 'limit:', limit);

  if (!project) {
    return c.json(errorResponse('invalidRequest', 'project is required'), 400);
  }
  if (!turnId) {
    return c.json(errorResponse('invalidRequest', 'turnId is required'), 400);
  }
  if (Number.isNaN(limit) || limit <= 0) {
    return c.json(errorResponse('invalidRequest', 'limit must be a positive number'), 400);
  }

  let offset: number | null;
  try {
    offset = await locateSessionTurnOffset({
      agent,
      project,
      sessionKey,
      turnId,
      limit,
    });
  } catch (error) {
    const mapped = mapCoreLookupError(error);
    return c.json(mapped.body, mapped.status as 400 | 500);
  }
  if (offset === null) {
    return c.json(errorResponse('notFound', 'turnId not found'), 404);
  }

  const response: SessionTurnPositionResponse = {
    turnId,
    offset,
    requestId: generateRequestId(),
  };

  return c.json(response);
});

sessionRoutes.get('/app/api/session/turns/:turnId/detail', async (c) => {
  const turnId = decodeURIComponent(c.req.param('turnId'));
  console.log('[APP_UI_SESSION_TURN_DETAIL] turnId:', turnId);

  let turn: Awaited<ReturnType<typeof turns.get>>;
  try {
    turn = await turns.get(turnId);
  } catch (error) {
    const mapped = mapCoreLookupError(error);
    return c.json(mapped.body, mapped.status as 400 | 500);
  }

  if (!turn) {
    return c.json(errorResponse('notFound', 'turnId not found'), 404);
  }

  const response: SessionTurnDetailResponse = {
    turn: toTurnDetail(turn),
    requestId: generateRequestId(),
  };

  return c.json(response);
});

sessionRoutes.get('/app/api/memories/:memoryId/document', async (c) => {
  const memoryId = c.req.param('memoryId');
  console.log('[APP_UI_MEMORY_DOCUMENT] memoryId:', memoryId);

  let memory: Awaited<ReturnType<typeof memories.get>>;
  try {
    memory = await memories.get(memoryId);
  } catch (error) {
    const mapped = mapCoreLookupError(error);
    return c.json(mapped.body, mapped.status as 400 | 500);
  }

  if (!memory) {
    return c.json(errorResponse('notFound', 'memoryId not found'), 404);
  }

  const response: MemoryDocumentResponse = {
    document: await enrichMemoryDocument(renderRenderedMemoryDocument(memory), memoryId),
    requestId: generateRequestId(),
  };

  return c.json(response);
});

sessionRoutes.get(SESSION_SNAPSHOTS_ROUTE, async (c) => {
  console.log('[APP_UI_SESSION_SNAPSHOTS]');

  const rows = await sessions.list({
    mode: { type: 'recency', limit: 50 },
  });
  const sessionSnapshotCards = await Promise.all(
    rows
      .slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(async (snapshot) => ({
        memoryId: snapshot.snapshotId,
        title: snapshot.title,
        summary: snapshot.summary,
        updatedAt: snapshot.updatedAt,
        references: await loadSnapshotReferences(snapshot.references),
      })),
  );

  const response: SessionSnapshotListResponse = {
    sessionSnapshots: sessionSnapshotCards,
    requestId: generateRequestId(),
  };

  return c.json(response);
});
