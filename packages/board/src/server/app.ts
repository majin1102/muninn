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
import { previewCodexImport, runCodexImport } from './codex_import.js';
import { renderRenderedMemoryDocument } from './render.js';
import { sessionDisplayTitle } from './session_labels.js';

const AGENT_DEFAULT_SESSION_PREFIX = '__agent_default__:';
const OBSERVER_DEFAULT_SESSION_PREFIX = '__observer_default__:';
const SESSION_TREE_PAGE_LIMIT = 1_000_000;
const packageDir = path.resolve(__dirname, '..');

export const boardApp = new Hono();

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
    '    "llm": "default_extractor_llm",',
    '    "maxAttempts": 3,',
    '    "activeWindowDays": 7',
    '  },',
    '  "observer": {',
    '    "name": "default-observer",',
    '    "llm": "default_observer_llm",',
    '    "maxAttempts": 3,',
    '    "anchorThreshold": 8',
    '  },',
    '  "llm": {',
    '    "default_extractor_llm": {',
    '      "provider": "mock"',
    '    },',
    '    "default_observer_llm": {',
    '      "provider": "mock"',
    '    }',
    '  },',
    '  "extraction": {',
    '    "embedding": {',
    '      "provider": "mock",',
    '      "dimensions": 8',
    '    },',
    '    "defaultImportance": 0.7',
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

function normalizeText(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveSessionNode(turn: Pick<BoardSessionTurn, 'sessionId' | 'agent' | 'observer'>): {
  sessionKey: string;
  displaySessionId: string;
  projectKey?: string;
} {
  const sessionId = normalizeText(turn.sessionId);
  if (sessionId) {
    const [projectKey] = sessionId.split('/');
    return {
      sessionKey: sessionId,
      displaySessionId: sessionDisplayTitle(sessionId),
      projectKey: projectKey || undefined,
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
  return {
    memoryId: turn.turnId,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
    title: turn.title ?? undefined,
    summary: turn.summary!,
    prompt: turn.prompt ?? undefined,
    response: turn.response ?? undefined,
    events: turn.events.length > 0 ? turn.events : undefined,
    artifacts: turn.artifacts ?? undefined,
    toolCalls: toolCallsFromEvents(turn.events),
  };
}

function toolCallsFromEvents(events: BoardSessionTurn['events']): TurnPreview['toolCalls'] {
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
  return {
    ...document,
    agent: turn.agent,
    observer: turn.observer,
    sessionId: turn.sessionId ?? undefined,
    prompt: turn.prompt ?? undefined,
    response: turn.response ?? undefined,
    events: turn.events.length > 0 ? turn.events : undefined,
    toolCalls: toolCallsFromEvents(turn.events),
    artifacts: turn.artifacts ?? undefined,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
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
  const grouped = new Map<string, { latestUpdatedAt: string; displaySessionId: string; projectKey?: string }>();

  for (const turn of turns) {
    const sessionNode = resolveSessionNode(turn);
    const latest = grouped.get(sessionNode.sessionKey);
    if (!latest || turn.updatedAt > latest.latestUpdatedAt) {
      grouped.set(sessionNode.sessionKey, {
        latestUpdatedAt: turn.updatedAt,
        displaySessionId: sessionNode.displaySessionId,
        projectKey: sessionNode.projectKey,
      });
    }
  }

  const sessionNodes = [...grouped.entries()]
    .map(([sessionKey, sessionNode]) => ({
      sessionKey,
      displaySessionId: sessionNode.displaySessionId,
      projectKey: sessionNode.projectKey,
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
    document: await enrichMemoryDocument(renderRenderedMemoryDocument(memory), memoryId),
    requestId: generateRequestId(),
  };

  return c.json(response);
});

boardApp.get('/api/v1/ui/observing', async (c) => {
  console.log('[BOARD_UI_OBSERVING]');

  const rows = await sessions.list({
    mode: { type: 'recency', limit: 50 },
  });
  const extractionCards = await Promise.all(
    rows
      .slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(async (observing) => ({
        memoryId: observing.snapshotId,
        title: observing.title,
        summary: observing.summary,
        updatedAt: observing.updatedAt,
        references: await loadObservingReferences(observing.references),
      })),
  );

  const response: ObservingListResponse = {
    extractions: extractionCards,
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

boardApp.get('/api/v1/ui/artifacts/:name', async (c) => {
  const name = c.req.param('name');
  if (!/^[a-f0-9]{64}(?:\.[a-z0-9]+)?$/i.test(name)) {
    return c.json(errorResponse('invalidRequest', 'invalid artifact name'), 400);
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

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
