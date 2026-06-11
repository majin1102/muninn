import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  validateSettings,
  memories,
  sessions,
  turns,
} from '@muninn/core';
import { Hono } from 'hono';
import type {
  AgentNode,
  CodexImportPreviewResponse,
  CodexImportRunResponse,
  ImportSelectedResponse,
  ImportSessionsListResponse,
  ErrorResponse,
  MemoryDocumentResponse,
  MemoryReference,
  PipelineTasksResponse,
  RecallProvidersResponse,
  SearchResponse,
  SearchSessionResult,
  SessionAgentsResponse,
  SessionGroupsResponse,
  SessionNode,
  ExtractionPreview,
  SessionSegmentPreview,
  SessionSnapshotListResponse,
  SessionTurnsResponse,
  SettingsConfigResponse,
  TurnPreview,
} from '@muninn/types';
import { agentRecallEvents, ndjsonStream, recallProviderOptions } from './agent_recall.js';
import { codexAdapter, previewCodexImport, runCodexImport } from './codex_import.js';
import { claudeAdapter } from './claude_import.js';
import { importSelectedSessions, listImportedSessions, listLocalSessions, type ImportAdapter } from './import_core.js';
import { setCaptureEnabled } from './capture_policy.js';

// Re-exported so the sidecar capture endpoint can gate live hook captures.
export { isCaptureEnabled } from './capture_policy.js';

const importAdapters: Record<string, ImportAdapter> = {
  codex: codexAdapter,
  'claude-code': claudeAdapter,
};
import { renderRenderedMemoryDocument } from './render.js';
import { searchBoardMemory } from './search.js';
import { sessionDisplayTitle } from './session_labels.js';

const AGENT_DEFAULT_SESSION_PREFIX = '__agent_default__:';
const OBSERVER_DEFAULT_SESSION_PREFIX = '__observer_default__:';
const SESSION_TREE_PAGE_LIMIT = 1_000_000;
const packageDir = path.resolve(__dirname, '..');

export const boardApp = new Hono();
export const SESSION_SNAPSHOTS_ROUTE = '/api/v1/ui/session-snapshots';

let sessionTreeCache: Awaited<ReturnType<typeof turns.list>> | null = null;
let sessionTreeLoading: Promise<Awaited<ReturnType<typeof turns.list>>> | null = null;
let sessionTreeLoadCount = 0;
let sessionTreeCacheGeneration = 0;

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

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

function resolveConfigPath(): string {
  if (process.env.MUNINN_HOME) {
    return path.join(process.env.MUNINN_HOME, 'muninn.json');
  }

  return path.join(os.homedir(), '.muninn', 'muninn.json');
}

function resolveArtifactStorePath(): string {
  const home = process.env.MUNINN_HOME ?? path.join(os.homedir(), '.muninn');
  return path.join(home, 'default', 'artifacts');
}

function resolveBoardDistPath(): string {
  const candidates = [
    path.join(packageDir, 'dist'),
    path.resolve(process.cwd(), '..', 'board', 'dist'),
    path.resolve(process.cwd(), 'packages', 'board', 'dist'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

function defaultConfigContent(): string {
  return [
    '{',
    '  "extractor": {',
    '    "name": "default-extractor",',
    '    "llmProvider": "default",',
    '    "embeddingProvider": "default",',
    '    "recallMode": "hybrid",',
    '    "maxAttempts": 3,',
    '    "activeWindowDays": 7',
    '  },',
    '  "observer": {',
    '    "name": "default-observer",',
    '    "llmProvider": "default",',
    '    "maxAttempts": 3,',
    '    "cwdThreshold": 8',
    '  },',
    '  "providers": {',
    '    "llm": {',
    '      "default": {',
    '        "type": "mock"',
    '      }',
    '    },',
    '    "embedding": {',
    '      "default": {',
    '        "type": "mock",',
    '        "dimensions": 8',
    '      }',
    '    }',
    '  },',
    '  "watchdog": {',
    '    "enabled": true,',
    '    "intervalMs": 60000,',
    '    "compactMinFragments": 8,',
    '    "extraction": {',
    '      "targetPartitionSize": 1024,',
    '      "optimizeMergeCount": 4',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
}

type BoardSessionTurn = Awaited<ReturnType<typeof turns.list>>[number];
type BoardSessionIndexEntry = Awaited<ReturnType<typeof sessions.index>>[number];

function normalizeText(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveSessionNode(turn: Pick<BoardSessionTurn, 'sessionId' | 'agent' | 'observer' | 'project' | 'cwd'>): {
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

  const observer = normalizeText(turn.observer) ?? 'observer';
  return {
    sessionKey: `${OBSERVER_DEFAULT_SESSION_PREFIX}${observer}`,
    displaySessionId: `Observer Default (${observer})`,
    projectKey: normalizeText(turn.project) ?? 'default',
    cwd: normalizeText(turn.cwd),
  };
}

function resolveSessionNodeFromIndex(entry: BoardSessionIndexEntry): SessionNode {
  return {
    sessionKey: entry.sessionId,
    displaySessionId: resolveIndexedSessionTitle(entry),
    projectKey: entry.project,
    cwd: entry.cwd,
    latestUpdatedAt: entry.latestUpdatedAt,
  };
}

function resolveIndexedSessionTitle(entry: Pick<BoardSessionIndexEntry, 'sessionId' | 'title'>): string {
  const title = normalizeText(entry.title);
  if (title && !isGeneratedSessionTitle(entry.sessionId, title)) {
    return title;
  }
  return sessionDisplayTitle(entry.sessionId);
}

function isGeneratedSessionTitle(sessionId: string, title: string): boolean {
  return title === `Session ${sessionId}` || title === 'Session observing thread';
}

export function resolveSessionNodeFromIndexForTests(entry: BoardSessionIndexEntry): SessionNode {
  return resolveSessionNodeFromIndex(entry);
}

function matchesSessionNode(turn: BoardSessionTurn, sessionKey: string): boolean {
  return resolveSessionNode(turn).sessionKey === sessionKey;
}

function isDefaultSessionKey(sessionKey: string): boolean {
  return sessionKey.startsWith(AGENT_DEFAULT_SESSION_PREFIX)
    || sessionKey.startsWith(OBSERVER_DEFAULT_SESSION_PREFIX);
}

function hasSummary(turn: { summary?: string | null }): boolean {
  return typeof turn.summary === 'string' && turn.summary.trim().length > 0;
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

function toTurnPreview(turn: BoardSessionTurn): TurnPreview {
  const events = turnEvents(turn);
  return {
    memoryId: turn.turnId,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
    title: turn.title ?? undefined,
    summary: turn.summary!,
    prompt: turn.prompt ?? undefined,
    response: turn.response ?? undefined,
    events: events.length > 0 ? events : undefined,
    artifacts: turn.artifacts ?? undefined,
    toolCalls: toolCallsFromEvents(events),
  };
}

function turnEvents(turn: BoardSessionTurn): NonNullable<BoardSessionTurn['events']> {
  return Array.isArray((turn as { events?: BoardSessionTurn['events'] }).events)
    ? (turn as { events: NonNullable<BoardSessionTurn['events']> }).events
    : [];
}

function toolCallsFromEvents(events: NonNullable<BoardSessionTurn['events']>): TurnPreview['toolCalls'] {
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
    observer: turn.observer,
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
  cwd?: string;
  sessionKey: string;
  offset: number;
  limit: number;
}): Promise<{
  turns: TurnPreview[];
  segments: SessionSegmentPreview[];
  observations: ExtractionPreview[];
  sessionSummary?: string;
  nextOffset: number | null;
}> {
  const allTurns = (await turns.list({
    mode: { type: 'page', offset: 0, limit: SESSION_TREE_PAGE_LIMIT },
    agent: params.agent,
    ...(isDefaultSessionKey(params.sessionKey) ? {} : { sessionId: params.sessionKey }),
  }))
    .filter((turn) => matchesSessionNode(turn, params.sessionKey))
    .filter((turn) => !params.cwd || turn.cwd === params.cwd)
    .filter(hasSummary)
    .sort((left, right) => (
      left.createdAt.localeCompare(right.createdAt)
      || left.updatedAt.localeCompare(right.updatedAt)
      || left.turnId.localeCompare(right.turnId)
    ));
  const previews = allTurns.map(toTurnPreview);
  const snapshotContent = await loadSessionSnapshotContent(params.agent, params.sessionKey, params.cwd);
  return buildSessionTurnPage({
    turns: previews,
    snapshotContent,
    offset: params.offset,
    limit: params.limit,
  });
}

async function loadSessionSnapshotContent(agent: string, sessionKey: string, cwd?: string): Promise<string | null> {
  const sessionIndex = await sessions.index();
  const session = sessionIndex.find((entry) => (
    entry.agent === agent
    && entry.sessionId === sessionKey
    && (!cwd || entry.cwd === cwd)
  ));

  if (!session?.snapshotId) {
    return null;
  }

  const snapshot = await memories.get(session.snapshotId);
  if (!snapshot) {
    return null;
  }

  return renderRenderedMemoryDocument(snapshot).markdown;
}

function buildSessionTurnPage(params: {
  turns: TurnPreview[];
  snapshotContent?: string | null;
  offset: number;
  limit: number;
}): {
  turns: TurnPreview[];
  segments: SessionSegmentPreview[];
  observations: ExtractionPreview[];
  sessionSummary?: string;
  nextOffset: number | null;
} {
  const pageTurns = params.turns.slice(params.offset, params.offset + params.limit);
  const observations = buildExtractions(params.snapshotContent, params.turns);
  const segments = buildSessionSegments(params.snapshotContent, params.turns);
  return {
    turns: pageTurns,
    segments,
    observations,
    sessionSummary: parseSnapshotSummary(params.snapshotContent),
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

function buildSessionSegments(
  snapshotContent: string | null | undefined,
  turnPreviews: TurnPreview[],
): SessionSegmentPreview[] {
  const fromSnapshot = buildExtractions(snapshotContent, turnPreviews).map((observation) => ({
    memoryId: observation.memoryId,
    title: observation.title,
    createdAt: observation.createdAt,
    updatedAt: observation.updatedAt,
  }));
  return fromSnapshot.length > 0 ? fromSnapshot : fallbackTurnSegments(turnPreviews);
}

function buildExtractions(
  snapshotContent: string | null | undefined,
  turnPreviews: TurnPreview[],
): ExtractionPreview[] {
  if (!snapshotContent) {
    return [];
  }
  const extractionStart = snapshotContent.search(/^##\s+Extractions\s*$/im);
  if (extractionStart < 0) {
    return [];
  }
  const sectionStart = snapshotContent.indexOf('\n', extractionStart);
  if (sectionStart < 0) {
    return [];
  }
  const rest = snapshotContent.slice(sectionStart + 1);
  const nextSection = rest.search(/^##\s+/m);
  const section = nextSection >= 0 ? rest.slice(0, nextSection) : rest;
  const turnById = new Map(turnPreviews.map((turn, index) => [turn.memoryId, { turn, index }]));
  const refsPattern = /<!--\s*(?:sequence:\s*\d+\s*;\s*)?refs:\s*\[([^\]]*)\]\s*-->/g;
  const matches = [...section.matchAll(refsPattern)];
  const observations: Array<ExtractionPreview & { index: number }> = [];

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
    if (!firstTurn) {
      continue;
    }
    observations.push({
      memoryId: `${firstTurn.turn.memoryId}~observation:${i}`,
      title,
      createdAt: firstTurn.turn.createdAt,
      updatedAt: firstTurn.turn.updatedAt,
      markdown: normalizeObservationMarkdown(block),
      refs,
      index: firstTurn.index,
    });
  }

  return observations
    .sort((left, right) => (
      left.createdAt.localeCompare(right.createdAt)
      || left.index - right.index
    ))
    .map(({ index: _index, ...observation }) => observation);
}

function parseSnapshotSummary(snapshotContent: string | null | undefined): string | undefined {
  if (!snapshotContent) {
    return undefined;
  }
  const match = snapshotContent.match(/^##\s+Summary\s*\n([\s\S]*?)(?=\n##\s+|$)/im);
  const summary = match?.[1]?.trim();
  return summary ? summary : undefined;
}

function normalizeObservationMarkdown(raw: string): string {
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

function fallbackTurnSegments(turnPreviews: TurnPreview[]): SessionSegmentPreview[] {
  return turnPreviews.map((turn) => ({
    memoryId: turn.memoryId,
    title: turn.prompt ?? turn.title ?? turn.summary,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
  }));
}

export function buildSessionSegmentsForTests(
  snapshotContent: string | null | undefined,
  turnPreviews: TurnPreview[],
): SessionSegmentPreview[] {
  return buildSessionSegments(snapshotContent, turnPreviews);
}

export function buildExtractionsForTests(
  snapshotContent: string | null | undefined,
  turnPreviews: TurnPreview[],
): ExtractionPreview[] {
  return buildExtractions(snapshotContent, turnPreviews);
}

export function buildSessionTurnPageForTests(params: {
  turns: TurnPreview[];
  snapshotContent?: string | null;
  offset: number;
  limit: number;
}): {
  turns: TurnPreview[];
  segments: SessionSegmentPreview[];
  observations: ExtractionPreview[];
  sessionSummary?: string;
  nextOffset: number | null;
} {
  return buildSessionTurnPage(params);
}

async function loadSnapshotReferences(references: string[]): Promise<MemoryReference[]> {
  const resolved = await Promise.all(
    references.map(async (memoryId) => {
      if (memoryId.startsWith('turn:')) {
        const turn = await turns.get(memoryId);
        if (!turn || !hasSummary(turn)) {
          return null;
        }
        return {
          memoryId,
          timestamp: turn.updatedAt,
          summary: turn.summary!,
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

function getBoardAssetPath(relativePath: string): string {
  const normalized = path.posix.normalize(`/${relativePath}`).replace(/^\/+/, '');
  return path.join(resolveBoardDistPath(), normalized);
}

function contentTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath)] ?? 'application/octet-stream';
}

async function serveBoardFile(filePath: string): Promise<Response> {
  try {
    const content = await readFile(filePath);
    return new Response(content, {
      headers: {
        'content-type': contentTypeFor(filePath),
        'cache-control': 'no-store',
      },
    });
  } catch {
    return new Response('Not Found', { status: 404 });
  }
}

boardApp.get('/board', (c) => c.redirect('/board/'));

boardApp.get('/board/', async () => {
  return serveBoardFile(getBoardAssetPath('index.html'));
});

boardApp.get('/board/:asset{.+}', async (c) => {
  const asset = c.req.param('asset');
  if (asset.includes('..')) {
    return c.text('Not Found', 404);
  }
  return serveBoardFile(getBoardAssetPath(asset));
});

boardApp.get('/api/v1/ui/session/agents', async (c) => {
  console.log('[BOARD_UI_SESSION_AGENTS]');

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

boardApp.get('/api/v1/ui/session/agents/:agent/sessions', async (c) => {
  const agent = c.req.param('agent');
  console.log('[BOARD_UI_SESSION_GROUPS] agent:', agent);

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

boardApp.get('/api/v1/ui/session/agents/:agent/sessions/:sessionKey/turns', async (c) => {
  const agent = c.req.param('agent');
  const sessionKey = c.req.param('sessionKey');
  const cwd = normalizeText(c.req.query('cwd'));
  const offsetRaw = c.req.query('offset');
  const limitRaw = c.req.query('limit');

  const offset = offsetRaw ? Number(offsetRaw) : 0;
  const limit = limitRaw ? Number(limitRaw) : 10;

  console.log('[BOARD_UI_SESSION_TURNS] agent:', agent, 'cwd:', cwd, 'sessionKey:', sessionKey, 'offset:', offset, 'limit:', limit);

  if (!cwd) {
    return c.json(errorResponse('invalidRequest', 'cwd is required'), 400);
  }

  if (Number.isNaN(offset) || offset < 0) {
    return c.json(errorResponse('invalidRequest', 'offset must be a non-negative number'), 400);
  }

  if (Number.isNaN(limit) || limit <= 0) {
    return c.json(errorResponse('invalidRequest', 'limit must be a positive number'), 400);
  }

  const page = await loadSessionTurnPreviewsPage({
    agent,
    cwd,
    sessionKey,
    offset,
    limit,
  });

  const response: SessionTurnsResponse = {
    turns: page.turns,
    segments: page.segments,
    observations: page.observations,
    sessionSummary: page.sessionSummary,
    nextOffset: page.nextOffset,
    requestId: generateRequestId(),
  };

  return c.json(response);
});

boardApp.get('/api/v1/ui/memories/:memoryId/document', async (c) => {
  const memoryId = c.req.param('memoryId');
  console.log('[BOARD_UI_MEMORY_DOCUMENT] memoryId:', memoryId);

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

boardApp.get('/api/v1/ui/recall/providers', (c) => {
  const response: RecallProvidersResponse = {
    providers: recallProviderOptions(),
    requestId: generateRequestId(),
  };
  return c.json(response);
});

boardApp.get('/api/v1/ui/recall/search', async (c) => {
  const query = normalizeText(c.req.query('query'));
  if (!query) {
    return c.json(errorResponse('invalidRequest', 'query is required'), 400);
  }

  const projectKeys = normalizeTextList(c.req.queries('projectKey'));
  const sessionKeys = normalizeTextList(c.req.queries('sessionKey'));

  const sessionTopN = parsePositiveInteger(c.req.query('sessionTopN'), 3);
  if (typeof sessionTopN === 'string') {
    return c.json(errorResponse('invalidRequest', `sessionTopN ${sessionTopN}`), 400);
  }
  const topN = parsePositiveInteger(c.req.query('topN'), 20);
  if (typeof topN === 'string') {
    return c.json(errorResponse('invalidRequest', `topN ${topN}`), 400);
  }

  const search = await searchBoardMemory({
    query,
    projectKeys,
    sessionKeys,
    sessionTopN,
    topN,
  }, {
    recall: memories.recall,
  });

  const response: SearchResponse = {
    results: search.results,
    requestId: generateRequestId(),
  };
  return c.json(response);
});

boardApp.post('/api/v1/ui/recall/agent', async (c) => {
  const body = await c.req.json().catch(() => null) as {
    query?: unknown;
    provider?: unknown;
    results?: unknown;
  } | null;
  const query = normalizeText(typeof body?.query === 'string' ? body.query : undefined);
  if (!query) {
    return c.json(errorResponse('invalidRequest', 'query is required'), 400);
  }
  const provider = normalizeText(typeof body?.provider === 'string' ? body.provider : undefined) ?? 'default';
  if (provider === 'none') {
    return c.json(errorResponse('invalidRequest', 'provider none does not run agent recall'), 400);
  }
  const results = Array.isArray(body?.results) ? body.results as SearchSessionResult[] : null;
  if (!results) {
    return c.json(errorResponse('invalidRequest', 'results is required'), 400);
  }
  return ndjsonStream(agentRecallEvents({
    query,
    provider,
    results,
    signal: c.req.raw.signal,
  }));
});

function normalizeTextList(values: string[] | undefined): string[] {
  return [...new Set((values ?? [])
    .map((value) => normalizeText(value))
    .filter((value): value is string => Boolean(value) && value !== 'all'))];
}

boardApp.get(SESSION_SNAPSHOTS_ROUTE, async (c) => {
  console.log('[BOARD_UI_SESSION_SNAPSHOTS]');

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

boardApp.get('/api/v1/ui/pipelines', async (c) => {
  console.log('[BOARD_UI_PIPELINES]');

  const response: PipelineTasksResponse = {
    summary: {
      running: 0,
      queued: 0,
      failed: 0,
      updatedAt: null,
    },
    tasks: [],
    requestId: generateRequestId(),
  };

  return c.json(response);
});

boardApp.get('/api/v1/ui/settings/config', async (c) => {
  const configPath = resolveConfigPath();
  let content = defaultConfigContent();

  try {
    content = await readFile(configPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      return c.json(errorResponse('internalError', 'failed to read muninn.json'), 500);
    }
  }

  let validationError: string | undefined;
  try {
    await validateSettings(content);
  } catch (error) {
    validationError = error instanceof Error ? error.message : String(error);
  }

  const response: SettingsConfigResponse = {
    pathLabel: configPath,
    content,
    validationError,
    requestId: generateRequestId(),
  };

  return c.json(response);
});

boardApp.put('/api/v1/ui/settings/config', async (c) => {
  const configPath = resolveConfigPath();
  let body: { content?: string };

  try {
    body = await c.req.json<{ content?: string }>();
  } catch {
    return c.json(errorResponse('invalidRequest', 'invalid JSON body'), 400);
  }

  if (typeof body.content !== 'string') {
    return c.json(errorResponse('invalidRequest', 'content must be a string'), 400);
  }

  try {
    await validateSettings(body.content);
  } catch (error) {
    return c.json(
      errorResponse('invalidRequest', error instanceof Error ? error.message : String(error)),
      400,
    );
  }

  try {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, body.content, 'utf8');
  } catch {
    return c.json(errorResponse('internalError', 'failed to write muninn.json'), 500);
  }

  // Saving muninn.json updates the persisted config only. The current format/native
  // runtime stays alive until the process restarts, so changes do not hot-apply.

  const response: SettingsConfigResponse = {
    pathLabel: configPath,
    content: body.content,
    requestId: generateRequestId(),
  };

  return c.json(response);
});

boardApp.get('/api/v1/ui/import/codex/preview', async (c) => {
  const projectLimit = parseOptionalInteger(c.req.query('projectLimit'));
  const sourceRoot = c.req.query('sourceRoot');
  const projectKeys = c.req.queries('projectKey');
  const response: CodexImportPreviewResponse = await previewCodexImport({
    sourceRoot,
    projectLimit,
    projectKeys,
  }, generateRequestId());
  return c.json(response);
});

boardApp.post('/api/v1/ui/import/codex', async (c) => {
  let body: { sourceRoot?: string; projectLimit?: number; projectKeys?: string[] } = {};
  try {
    body = await c.req.json<{ sourceRoot?: string; projectLimit?: number; projectKeys?: string[] }>();
  } catch {
    body = {};
  }

  invalidateSessionTreeCache();
  const response: CodexImportRunResponse = await runCodexImport({
    sourceRoot: body.sourceRoot,
    projectLimit: body.projectLimit,
    projectKeys: body.projectKeys,
  }, generateRequestId());
  invalidateSessionTreeCache();
  return c.json(response);
});

boardApp.get('/api/v1/ui/import/:agent/sessions', async (c) => {
  const adapter = importAdapters[c.req.param('agent')];
  if (!adapter) {
    return c.json(errorResponse('invalidRequest', 'unknown import agent'), 404);
  }
  const response: ImportSessionsListResponse = c.req.query('scope') === 'imported'
    ? await listImportedSessions(adapter, generateRequestId())
    : await listLocalSessions(adapter, generateRequestId());
  return c.json(response);
});

boardApp.put('/api/v1/ui/import/:agent/capture-policy', async (c) => {
  const agent = c.req.param('agent');
  if (!importAdapters[agent]) {
    return c.json(errorResponse('invalidRequest', 'unknown import agent'), 404);
  }
  let body: { projectKey?: string; enabled?: boolean } = {};
  try {
    body = await c.req.json<{ projectKey?: string; enabled?: boolean }>();
  } catch {
    body = {};
  }
  if (typeof body.projectKey !== 'string' || !body.projectKey || typeof body.enabled !== 'boolean') {
    return c.json(errorResponse('invalidRequest', 'projectKey and enabled are required'), 400);
  }
  await setCaptureEnabled(agent, body.projectKey, body.enabled);
  return c.body(null, 204);
});

boardApp.post('/api/v1/ui/import/:agent/sessions', async (c) => {
  const adapter = importAdapters[c.req.param('agent')];
  if (!adapter) {
    return c.json(errorResponse('invalidRequest', 'unknown import agent'), 404);
  }
  let body: { sourcePaths?: string[] } = {};
  try {
    body = await c.req.json<{ sourcePaths?: string[] }>();
  } catch {
    body = {};
  }
  const sourcePaths = Array.isArray(body.sourcePaths) ? body.sourcePaths.filter((path): path is string => typeof path === 'string' && path.length > 0) : [];
  if (sourcePaths.length === 0) {
    return c.json(errorResponse('invalidRequest', 'sourcePaths is required'), 400);
  }
  invalidateSessionTreeCache();
  const response: ImportSelectedResponse = await importSelectedSessions(adapter, sourcePaths, generateRequestId());
  invalidateSessionTreeCache();
  return c.json(response);
});

boardApp.get('/api/v1/artifacts/*', async (c) => {
  const name = safeDecodeURIComponent(c.req.path.slice('/api/v1/artifacts/'.length));
  if (!isSafeArtifactPath(name)) {
    return c.json(errorResponse('invalidRequest', 'invalid artifact path'), 400);
  }

  const store = resolveArtifactStorePath();
  const filePath = path.join(store, name);
  const resolvedStore = path.resolve(store);
  const resolvedFile = path.resolve(filePath);
  if (!resolvedFile.startsWith(`${resolvedStore}${path.sep}`)) {
    return c.json(errorResponse('invalidRequest', 'invalid artifact path'), 400);
  }

  try {
    await stat(resolvedFile);
    return serveBoardFile(resolvedFile);
  } catch {
    return c.json(errorResponse('notFound', 'artifact not found'), 404);
  }
});

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isSafeArtifactPath(value: string | null): value is string {
  if (!value || path.isAbsolute(value) || value.includes('\0')) {
    return false;
  }
  const parts = value.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    return false;
  }
  return parts.every((part) => /^[a-z0-9._-]+$/i.test(part));
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number | string {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 'must be a positive integer';
}
