import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  validateSettings,
  memories,
  observings,
  sessions,
} from '@muninn/core';
import { Hono } from 'hono';
import type {
  AgentNode,
  ErrorResponse,
  MemoryDocumentResponse,
  MemoryReference,
  ObservingListResponse,
  SessionAgentsResponse,
  SessionGroupsResponse,
  SessionTurnsResponse,
  SettingsConfigResponse,
  TurnPreview,
} from '@muninn/types';
import { renderRenderedMemoryDocument } from './render.js';
import { validateSettingsJson } from './settings.js';

const AGENT_DEFAULT_SESSION_PREFIX = '__agent_default__:';
const OBSERVER_DEFAULT_SESSION_PREFIX = '__observer_default__:';
const SESSION_TREE_PAGE_LIMIT = Number.MAX_SAFE_INTEGER;
const packageDir = path.resolve(__dirname, '..');

export const boardApp = new Hono();

let sessionTreeCache: Awaited<ReturnType<typeof sessions.list>> | null = null;
let sessionTreeLoading: Promise<Awaited<ReturnType<typeof sessions.list>>> | null = null;
let sessionTreeLoadCount = 0;
let sessionTreeCacheGeneration = 0;

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
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
    || lowered.includes('ulid')
    || lowered.includes("missing ':' separator")
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
    return path.join(process.env.MUNINN_HOME, 'settings.json');
  }

  return path.join(os.homedir(), '.muninn', 'settings.json');
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
    '  "watchdog": {',
    '    "enabled": true,',
    '    "intervalMs": 60000,',
    '    "compactMinFragments": 8,',
    '    "semanticIndex": {',
    '      "targetPartitionSize": 1024,',
    '      "optimizeMergeCount": 4',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
}

type BoardSessionTurn = Awaited<ReturnType<typeof sessions.list>>[number];

function normalizeText(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveSessionNode(turn: Pick<BoardSessionTurn, 'session_id' | 'agent' | 'observer'>): {
  sessionKey: string;
  displaySessionId: string;
} {
  const sessionId = normalizeText(turn.session_id);
  if (sessionId) {
    return {
      sessionKey: sessionId,
      displaySessionId: sessionId,
    };
  }

  const agent = normalizeText(turn.agent);
  if (agent) {
    return {
      sessionKey: `${AGENT_DEFAULT_SESSION_PREFIX}${agent}`,
      displaySessionId: 'Default Session',
    };
  }

  const observer = normalizeText(turn.observer) ?? 'observer';
  return {
    sessionKey: `${OBSERVER_DEFAULT_SESSION_PREFIX}${observer}`,
    displaySessionId: `Observer Default (${observer})`,
  };
}

function matchesSessionNode(turn: BoardSessionTurn, sessionKey: string): boolean {
  return resolveSessionNode(turn).sessionKey === sessionKey;
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

async function loadAllSessionTurns(): Promise<Awaited<ReturnType<typeof sessions.list>>> {
  if (sessionTreeCache) {
    return sessionTreeCache;
  }

  if (!sessionTreeLoading) {
    const loadGeneration = sessionTreeCacheGeneration;
    const loadingPromise = sessions
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
  return {
    memoryId: `SESSION:${turn.turnId}`,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
    title: turn.title,
    summary: turn.summary!,
  };
}

async function loadSessionTurnPreviewsPage(params: {
  agent: string;
  sessionKey: string;
  offset: number;
  limit: number;
}): Promise<{ turns: TurnPreview[]; nextOffset: number | null }> {
  const turns = (await loadAllSessionTurns())
    .filter((turn) => turn.agent === params.agent)
    .filter((turn) => matchesSessionNode(turn, params.sessionKey))
    .filter(hasSummary);
  const previews = turns
    .slice(params.offset, params.offset + params.limit)
    .map(toTurnPreview);
  const hasMore = params.offset + params.limit < turns.length;
  return {
    turns: previews,
    nextOffset: hasMore ? params.offset + params.limit : null,
  };
}

async function loadObservingReferences(references: string[]): Promise<MemoryReference[]> {
  const resolved = await Promise.all(
    references.map(async (memoryId) => {
      if (memoryId.startsWith('SESSION:')) {
        const turn = await sessions.get(memoryId);
        if (!turn || !hasSummary(turn)) {
          return null;
        }
        return {
          memoryId,
          timestamp: turn.updatedAt,
          summary: turn.summary!,
        };
      }

      if (memoryId.startsWith('OBSERVING:')) {
        const observing = await observings.get(memoryId);
        if (!observing) {
          return null;
        }
        return {
          memoryId,
          timestamp: observing.updatedAt,
          summary: observing.summary,
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

  const turns = (await loadAllSessionTurns()).filter(hasSummary);
  const grouped = new Map<string, string>();

  for (const turn of turns) {
    const latest = grouped.get(turn.agent);
    if (!latest || turn.updatedAt > latest) {
      grouped.set(turn.agent, turn.updatedAt);
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

  const turns = (await loadAllSessionTurns())
    .filter((turn) => turn.agent === agent)
    .filter(hasSummary);
  const grouped = new Map<string, { latestUpdatedAt: string; displaySessionId: string }>();

  for (const turn of turns) {
    const sessionNode = resolveSessionNode(turn);
    const latest = grouped.get(sessionNode.sessionKey);
    if (!latest || turn.updatedAt > latest.latestUpdatedAt) {
      grouped.set(sessionNode.sessionKey, {
        latestUpdatedAt: turn.updatedAt,
        displaySessionId: sessionNode.displaySessionId,
      });
    }
  }

  const sessionNodes = [...grouped.entries()]
    .map(([sessionKey, sessionNode]) => ({
      sessionKey,
      displaySessionId: sessionNode.displaySessionId,
      latestUpdatedAt: sessionNode.latestUpdatedAt,
    }))
    .sort((left, right) => right.latestUpdatedAt.localeCompare(left.latestUpdatedAt));

  const response: SessionGroupsResponse = {
    sessions: sessionNodes,
    requestId: generateRequestId(),
  };

  return c.json(response);
});

boardApp.get('/api/v1/ui/session/agents/:agent/sessions/:sessionKey/turns', async (c) => {
  const agent = c.req.param('agent');
  const sessionKey = c.req.param('sessionKey');
  const offsetRaw = c.req.query('offset');
  const limitRaw = c.req.query('limit');

  const offset = offsetRaw ? Number(offsetRaw) : 0;
  const limit = limitRaw ? Number(limitRaw) : 10;

  console.log('[BOARD_UI_SESSION_TURNS] agent:', agent, 'sessionKey:', sessionKey, 'offset:', offset, 'limit:', limit);

  if (Number.isNaN(offset) || offset < 0) {
    return c.json(errorResponse('invalidRequest', 'offset must be a non-negative number'), 400);
  }

  if (Number.isNaN(limit) || limit <= 0) {
    return c.json(errorResponse('invalidRequest', 'limit must be a positive number'), 400);
  }

  const page = await loadSessionTurnPreviewsPage({
    agent,
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
    document: renderRenderedMemoryDocument(memory),
    requestId: generateRequestId(),
  };

  return c.json(response);
});

boardApp.get('/api/v1/ui/observing', async (c) => {
  console.log('[BOARD_UI_OBSERVING]');

  const rows = await observings.list({
    mode: { type: 'recency', limit: 50 },
  });
  const observationCards = await Promise.all(
    rows
      .slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(async (observing) => ({
        memoryId: `OBSERVING:${observing.snapshotId}`,
        title: observing.title,
        summary: observing.summary,
        updatedAt: observing.updatedAt,
        references: await loadObservingReferences(observing.references),
      })),
  );

  const response: ObservingListResponse = {
    observations: observationCards,
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
      return c.json(errorResponse('internalError', 'failed to read settings.json'), 500);
    }
  }

  const response: SettingsConfigResponse = {
    pathLabel: configPath,
    content,
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
    validateSettingsJson(body.content);
  } catch (error) {
    return c.json(errorResponse('invalidRequest', error instanceof Error ? error.message : String(error)), 400);
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
    return c.json(errorResponse('internalError', 'failed to write settings.json'), 500);
  }

  const response: SettingsConfigResponse = {
    pathLabel: configPath,
    content: body.content,
    requestId: generateRequestId(),
  };

  return c.json(response);
});
