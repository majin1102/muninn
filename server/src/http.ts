import { Hono, type Context, type Next } from 'hono';
import { cors } from 'hono/cors';
import type {
  Artifact,
  CaptureTurnRequest,
  CaptureTurnsRequest,
  CaptureTurnsResponse,
  ErrorResponse,
  MemoryHit,
  MemoryResponse,
  MemoryWatermark,
  MemoryWatermarkResponse,
  ProjectDreamResponse,
  ProjectDreamSignals as ApiProjectDreamSignals,
  ProjectDreamSignalsResponse,
  TurnContent,
  TurnEvent,
} from '@muninn/common';
import {
  captureTurn,
  captureTurns,
  dreaming,
  memories,
  memoryPipeline,
  turns,
} from './backend.js';
import type { RecallMode } from './backend.js';
import type { RenderedMemory } from './api/memory.js';
import { isCaptureEnabled } from './api/capture.js';
import { renderRecallHit, renderRenderedMemoryHit } from './web/render.js';
import { invalidateSessionTreeCache, webRoutes } from './web/routes.js';
import { generateRequestId } from './web/request.js';

export const app = new Hono();

const LOCAL_WEB_CORS_ORIGINS = [
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

app.use('/api/*', cors({
  origin: LOCAL_WEB_CORS_ORIGINS,
}));
app.use('/app/api/*', cors({
  origin: LOCAL_WEB_CORS_ORIGINS,
}));
app.use('/version', cors({
  origin: LOCAL_WEB_CORS_ORIGINS,
}));
app.use('/health', cors({
  origin: LOCAL_WEB_CORS_ORIGINS,
}));

async function requireDesktopToken(c: Context, next: Next) {
  const token = process.env.MUNINN_DESKTOP_TOKEN;
  if (!token) {
    await next();
    return;
  }

  if (c.req.header('authorization') !== `Bearer ${token}`) {
    return c.json({
      errorCode: 'unauthorized',
      errorMessage: 'desktop authorization token is required',
      requestId: generateRequestId(),
    }, 401);
  }

  await next();
}

app.use('/api/*', requireDesktopToken);
app.use('/app/api/*', requireDesktopToken);
app.use('/app/artifacts/*', requireDesktopToken);

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    version: '0.1.0',
    datasetPath: '/data',
    requestId: generateRequestId(),
  });
});

app.get('/version', (c) => {
  return c.json({
    version: '0.1.0',
    capabilities: {
      vectorSearch: true,
      fullTextSearch: true,
      merge: true,
    },
    requestId: generateRequestId(),
  });
});

function errorResponse(errorCode: string, errorMessage: string): ErrorResponse {
  return {
    errorCode,
    errorMessage,
    requestId: generateRequestId(),
  };
}

function memoryResponse(memoryHits: MemoryHit[]): MemoryResponse {
  return {
    memoryHits,
    requestId: generateRequestId(),
  };
}

function memoryWatermarkResponse(watermark: MemoryWatermark): MemoryWatermarkResponse {
  return {
    ...watermark,
    requestId: generateRequestId(),
  };
}

function projectDreamResponse(project: string, signals: ApiProjectDreamSignals | null, created?: boolean): ProjectDreamResponse {
  return {
    project,
    created,
    memorySignals: signals?.memorySignals ?? [],
    skillSignals: signals?.skillSignals ?? [],
    requestId: generateRequestId(),
  };
}

function projectDreamSignalsResponse(signals: ApiProjectDreamSignals): ProjectDreamSignalsResponse {
  return {
    ...signals,
    requestId: generateRequestId(),
  };
}

function parseNonNegativeInteger(
  raw: string | undefined,
  fieldName: string,
): { value: number | undefined; error: string | null } {
  if (raw === undefined) {
    return { value: undefined, error: null };
  }

  if (raw.trim() === '') {
    return {
      value: undefined,
      error: `${fieldName} must be a non-negative integer`,
    };
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    return {
      value: undefined,
      error: `${fieldName} must be a non-negative integer`,
    };
  }

  return { value, error: null };
}

function parseRecallMode(raw: string | undefined): RecallMode | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === 'vector' || raw === 'fts' || raw === 'hybrid') {
    return raw;
  }
  throw new Error('recallMode must be one of: vector, fts, hybrid');
}

function mapCoreLookupError(error: unknown): { status: number; body: ErrorResponse } {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();

  if (
    lowered.includes('invalid')
    || lowered.includes('database must')
    || lowered.includes('memory layer')
  ) {
    return {
      status: 400,
      body: errorResponse('invalidRequest', message),
    };
  }

  if (isTransientUpstreamError(message)) {
    return {
      status: 503,
      body: errorResponse('upstreamError', message),
    };
  }

  return {
    status: 500,
    body: errorResponse('internalError', 'internal server error'),
  };
}

function isTransientUpstreamError(message: string): boolean {
  return /fetch failed|upstream connect error|connection termination|ECONNRESET|ETIMEDOUT/i.test(message)
    || /\b(?:408|429|502|503|504)\b/.test(message);
}

type LocomoManifestTurn = {
  turn_id: string;
  source_id: string;
  sample_id: string;
  session_id: string;
  date_time: string;
  import_order: number;
};

type LocomoImportManifest = {
  sample_id: string;
  turns: LocomoManifestTurn[];
};

type LocomoBridgeHit = {
  memory_id: string;
  matched_text: string;
  detail?: string;
};

app.get('/api/v1/dreaming/project', async (c) => {
  const project = c.req.query('project')?.trim();
  const database = c.req.query('database');
  if (!project) {
    return c.json(errorResponse('invalidRequest', 'project is required'), 400);
  }
  let signals;
  try {
    signals = await dreaming.getProjectSignals(project, database);
  } catch (error) {
    const mapped = mapCoreLookupError(error);
    return c.json(mapped.body, mapped.status as 400 | 500 | 503);
  }
  if (!signals) {
    return c.json(errorResponse('notFound', 'project dream not found'), 404);
  }
  return c.json(projectDreamResponse(project, signals));
});

app.get('/api/v1/dreaming/project/signals', async (c) => {
  const project = c.req.query('project')?.trim();
  const database = c.req.query('database');
  if (!project) {
    return c.json(errorResponse('invalidRequest', 'project is required'), 400);
  }
  let signals;
  try {
    signals = await dreaming.getProjectSignals(project, database);
  } catch (error) {
    const mapped = mapCoreLookupError(error);
    return c.json(mapped.body, mapped.status as 400 | 500 | 503);
  }
  if (!signals) {
    return c.json(errorResponse('notFound', 'project dream not found'), 404);
  }
  return c.json(projectDreamSignalsResponse(signals));
});

app.post('/api/v1/dreaming/project', async (c) => {
  const rawBody = await c.req.text();
  let body: { database?: unknown; project?: unknown } = {};
  if (rawBody.trim().length > 0) {
    try {
      body = JSON.parse(rawBody) as { database?: unknown; project?: unknown };
    } catch {
      return c.json(errorResponse('invalidRequest', 'Invalid JSON body'), 400);
    }
  }
  const project = (c.req.query('project') ?? (typeof body.project === 'string' ? body.project : '')).trim();
  const database = c.req.query('database') ?? (typeof body.database === 'string' ? body.database : undefined);
  if (!project) {
    return c.json(errorResponse('invalidRequest', 'project is required'), 400);
  }
  let result;
  try {
    result = await dreaming.createProject(project, database);
  } catch (error) {
    const mapped = mapCoreLookupError(error);
    return c.json(mapped.body, mapped.status as 400 | 500 | 503);
  }
  const signals = await dreaming.getProjectSignals(project, database);
  if (!signals) {
    return c.json(errorResponse('notFound', 'no project signals available'), 404);
  }
  return c.json(projectDreamResponse(project, signals, result.created));
});

app.get('/api/v1/recall', async (c) => {
  const query = c.req.query('query');
  const database = c.req.query('database');
  const limit = c.req.query('limit');
  const budget = c.req.query('budget');
  const queryLimit = c.req.query('queryLimit');
  const thinkingRatio = c.req.query('thinkingRatio');
  let recallMode: RecallMode | undefined;

  try {
    recallMode = parseRecallMode(c.req.query('recallMode'));
  } catch (error) {
    return c.json(errorResponse('invalidRequest', error instanceof Error ? error.message : String(error)), 400);
  }

  console.log('[RECALL] database:', database ?? 'main', 'query:', query, 'limit:', limit, 'budget:', budget, 'queryLimit:', queryLimit, 'thinkingRatio:', thinkingRatio, 'recallMode:', recallMode);

  if (!query) {
    return c.json(errorResponse('invalidRequest', 'query is required'), 400);
  }

  const parsedLimit = parseNonNegativeInteger(limit, 'limit');
  if (parsedLimit.error) {
    return c.json(errorResponse('invalidRequest', parsedLimit.error), 400);
  }
  const parsedBudget = parseNonNegativeInteger(budget, 'budget');
  if (parsedBudget.error) {
    return c.json(errorResponse('invalidRequest', parsedBudget.error), 400);
  }
  const parsedQueryLimit = parseNonNegativeInteger(queryLimit, 'queryLimit');
  if (parsedQueryLimit.error) {
    return c.json(errorResponse('invalidRequest', parsedQueryLimit.error), 400);
  }
  if ((parsedBudget.value ?? 0) > 0 && parsedQueryLimit.value === 0) {
    return c.json(errorResponse('invalidRequest', 'queryLimit must be positive when budget is positive'), 400);
  }

  const maxResults = parsedLimit.value ?? 10;
  let matched;
  try {
    matched = (await memories.recall(query, maxResults, {
      mode: recallMode,
      budget: parsedBudget.value,
      queryLimit: parsedQueryLimit.value,
      database,
    })).map(renderRecallHit);
  } catch (error) {
    const mapped = mapCoreLookupError(error);
    return c.json(mapped.body, mapped.status as 400 | 500);
  }

  return c.json(memoryResponse(matched));
});

app.post('/api/v1/benchmark/locomo/recall', async (c) => {
  let body: {
    query?: unknown;
    database?: unknown;
    limit?: unknown;
    budget?: unknown;
    queryLimit?: unknown;
    recallMode?: unknown;
    manifest?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json(errorResponse('invalidRequest', 'Invalid JSON body'), 400);
  }

  if (typeof body.query !== 'string' || body.query.trim().length === 0) {
    return c.json(errorResponse('invalidRequest', 'query is required'), 400);
  }
  const parsedLimit = parseRequestInteger(body.limit, 'limit', 10, false);
  if (parsedLimit.error) {
    return c.json(errorResponse('invalidRequest', parsedLimit.error), 400);
  }
  const parsedBudget = parseRequestInteger(body.budget, 'budget', undefined, true);
  if (parsedBudget.error) {
    return c.json(errorResponse('invalidRequest', parsedBudget.error), 400);
  }
  const parsedQueryLimit = parseRequestInteger(body.queryLimit, 'queryLimit', undefined, false);
  if (parsedQueryLimit.error) {
    return c.json(errorResponse('invalidRequest', parsedQueryLimit.error), 400);
  }
  let recallMode: RecallMode | undefined;
  try {
    recallMode = parseRecallMode(typeof body.recallMode === 'string' ? body.recallMode : undefined);
  } catch (error) {
    return c.json(errorResponse('invalidRequest', error instanceof Error ? error.message : String(error)), 400);
  }
  const manifest = parseLocomoManifest(body.manifest);
  if (!manifest) {
    return c.json(errorResponse('invalidRequest', 'manifest.turns is required'), 400);
  }

  const database = typeof body.database === 'string' ? body.database : undefined;
  try {
    const rows = await memories.recall(body.query, parsedLimit.value ?? 10, {
      mode: recallMode,
      budget: parsedBudget.value,
      queryLimit: parsedQueryLimit.value,
      database,
    });
    const hits: LocomoBridgeHit[] = [];
    for (const row of rows) {
      if (row.memoryId === 'recalled:memory') {
        hits.push(toRecalledLocomoHit(row));
        continue;
      }
      const rendered = await memories.get(row.memoryId, database);
      if (!rendered) {
        continue;
      }
      hits.push(toLocomoHit(rendered, row.content));
    }
    return c.json({ hits, requestId: generateRequestId() });
  } catch (error) {
    const mapped = mapCoreLookupError(error);
    return c.json(mapped.body, mapped.status as 400 | 500);
  }
});

app.get('/api/v1/list', async (c) => {
  const mode = c.req.query('mode');
  const database = c.req.query('database');
  const limit = c.req.query('limit');
  const thinkingRatio = c.req.query('thinkingRatio');

  console.log('[LIST] database:', database ?? 'main', 'mode:', mode, 'limit:', limit, 'thinkingRatio:', thinkingRatio);

  if (mode && mode !== 'recency') {
    return c.json(errorResponse('invalidRequest', 'mode must be "recency"'), 400);
  }

  const parsedLimit = parseNonNegativeInteger(limit, 'limit');
  if (parsedLimit.error) {
    return c.json(errorResponse('invalidRequest', parsedLimit.error), 400);
  }

  const maxResults = parsedLimit.value ?? 10;
  const recent = (await memories.list({ mode: { type: 'recency', limit: maxResults }, database })).map(renderRenderedMemoryHit);

  return c.json(memoryResponse(recent));
});

function parseRequestInteger(
  raw: unknown,
  fieldName: string,
  fallback: number | undefined,
  allowZero: boolean,
): { value: number | undefined; error: string | null } {
  if (raw === undefined || raw === null) {
    return { value: fallback, error: null };
  }
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0 || (!allowZero && raw === 0)) {
    return {
      value: undefined,
      error: allowZero
        ? `${fieldName} must be a non-negative integer`
        : `${fieldName} must be a positive integer`,
    };
  }
  return { value: raw, error: null };
}

function parseLocomoManifest(value: unknown): LocomoImportManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const manifest = value as Record<string, unknown>;
  if (typeof manifest.sample_id !== 'string' || !Array.isArray(manifest.turns)) {
    return null;
  }
  const parsedTurns: LocomoManifestTurn[] = [];
  for (const turn of manifest.turns) {
    if (!turn || typeof turn !== 'object' || Array.isArray(turn)) {
      return null;
    }
    const row = turn as Record<string, unknown>;
    if (
      typeof row.turn_id !== 'string'
      || typeof row.source_id !== 'string'
      || typeof row.sample_id !== 'string'
      || typeof row.session_id !== 'string'
      || typeof row.date_time !== 'string'
      || typeof row.import_order !== 'number'
    ) {
      return null;
    }
    parsedTurns.push({
      turn_id: row.turn_id,
      source_id: row.source_id,
      sample_id: row.sample_id,
      session_id: row.session_id,
      date_time: row.date_time,
      import_order: row.import_order,
    });
  }
  return {
    sample_id: manifest.sample_id,
    turns: parsedTurns,
  };
}

function toRecalledLocomoHit(
  row: { memoryId: string; content: string },
): LocomoBridgeHit {
  return {
    memory_id: row.memoryId,
    matched_text: row.content,
    detail: row.content,
  };
}

function toLocomoHit(
  rendered: RenderedMemory,
  matchedText: string,
): LocomoBridgeHit {
  return {
    memory_id: rendered.memoryId,
    matched_text: matchedText,
    detail: renderBridgeMemoryText(rendered, matchedText),
  };
}

function renderBridgeMemoryText(rendered: RenderedMemory, matchedText: string): string {
  if (rendered.memoryId.startsWith('extraction:')) {
    const extraction = matchedText || rendered.summary || rendered.title || '';
    const context = rendered.detail?.match(/(?:^|\n)Context:\n([\s\S]*?)(?:\n\nReferences:|$)/)?.[1]?.trim();
    return [
      `EXTRACTION: ${extraction}`,
      context ? `CONTEXT: ${context}` : '',
    ].filter(Boolean).join('\n');
  }
  return matchedText || rendered.summary || rendered.title || rendered.detail || '';
}

app.get('/api/v1/timeline', async (c) => {
  const memoryId = c.req.query('memoryId');
  const database = c.req.query('database');
  const beforeLimit = c.req.query('beforeLimit');
  const afterLimit = c.req.query('afterLimit');

  console.log('[TIMELINE] database:', database ?? 'main', 'memoryId:', memoryId, 'beforeLimit:', beforeLimit, 'afterLimit:', afterLimit);

  if (!memoryId) {
    return c.json(errorResponse('invalidRequest', 'memoryId is required'), 400);
  }

  const parsedBeforeLimit = parseNonNegativeInteger(beforeLimit, 'beforeLimit');
  if (parsedBeforeLimit.error) {
    return c.json(errorResponse('invalidRequest', parsedBeforeLimit.error), 400);
  }

  const parsedAfterLimit = parseNonNegativeInteger(afterLimit, 'afterLimit');
  if (parsedAfterLimit.error) {
    return c.json(errorResponse('invalidRequest', parsedAfterLimit.error), 400);
  }

  let windowed;
  try {
    windowed = (await memories.timeline({
      memoryId,
      beforeLimit: parsedBeforeLimit.value ?? 3,
      afterLimit: parsedAfterLimit.value ?? 3,
      database,
    })).map(renderRenderedMemoryHit);
  } catch (error) {
    const mapped = mapCoreLookupError(error);
    return c.json(mapped.body, mapped.status as 400 | 500);
  }

  if (windowed.length === 0) {
    return c.json(errorResponse('notFound', 'memoryId not found'), 404);
  }

  return c.json(memoryResponse(windowed));
});

app.get('/api/v1/detail', async (c) => {
  const memoryId = c.req.query('memoryId');
  const database = c.req.query('database');

  console.log('[DETAIL] database:', database ?? 'main', 'memoryId:', memoryId);

  if (!memoryId) {
    return c.json(errorResponse('invalidRequest', 'memoryId is required'), 400);
  }

  let memory;
  try {
    memory = await memories.get(memoryId, database);
  } catch (error) {
    const mapped = mapCoreLookupError(error);
    return c.json(mapped.body, mapped.status as 400 | 500);
  }

  if (!memory) {
    return c.json(errorResponse('notFound', 'memoryId not found'), 404);
  }

  return c.json(memoryResponse([renderRenderedMemoryHit(memory)]));
});

app.get('/api/v1/memory/watermark', async (c) => {
  const database = c.req.query('database');
  let watermark;
  try {
    watermark = await memoryPipeline.watermark(database);
  } catch (error) {
    const mapped = mapCoreLookupError(error);
    return c.json(mapped.body, mapped.status as 400 | 500);
  }

  return c.json(memoryWatermarkResponse(watermark));
});

app.post('/api/v1/memory/finalize', async (c) => {
  let database: string | undefined;
  try {
    const body = await c.req.json().catch(() => ({})) as { database?: unknown };
    database = typeof body.database === 'string' ? body.database : c.req.query('database');
  } catch {
    database = c.req.query('database');
  }
  let watermark;
  try {
    watermark = await memoryPipeline.finalize(database);
  } catch (error) {
    const mapped = mapCoreLookupError(error);
    return c.json(mapped.body, mapped.status as 400 | 500);
  }

  return c.json(memoryWatermarkResponse(watermark));
});

app.route('/', webRoutes);

const TURN_CONTENT_FIELDS = new Set([
  'sessionId',
  'project',
  'cwd',
  'agent',
  'metadata',
  'createdAt',
  'updatedAt',
  'turnSequence',
  'title',
  'summary',
  'events',
  'artifacts',
  'prompt',
  'response',
]);

function hasTextContent(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function isTurnEvent(value: unknown): value is TurnEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const timestamp = candidate.timestamp;
  if (timestamp !== undefined && !isTimestamp(timestamp)) {
    return false;
  }
  if (candidate.artifacts !== undefined) {
    if (!Array.isArray(candidate.artifacts) || !candidate.artifacts.every(isArtifact)) {
      return false;
    }
  }
  switch (candidate.type) {
    case 'userMessage':
    case 'assistantMessage':
      return typeof candidate.text === 'string'
        && candidate.text.trim().length > 0;
    case 'toolCall':
      return typeof candidate.name === 'string'
        && candidate.name.trim().length > 0
        && (candidate.id === undefined || typeof candidate.id === 'string')
        && (candidate.input === undefined || typeof candidate.input === 'string');
    case 'toolOutput':
      return (candidate.id === undefined || typeof candidate.id === 'string')
        && (candidate.output === undefined || typeof candidate.output === 'string');
    default:
      return false;
  }
}

function isArtifact(value: unknown): value is Artifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const kind = candidate.kind;
  const source = candidate.source;
  const hasContent = candidate.content === undefined || typeof candidate.content === 'string';
  const hasUri = candidate.uri === undefined || typeof candidate.uri === 'string';
  const hasName = candidate.name === undefined || typeof candidate.name === 'string';
  const hasMimeType = candidate.mimeType === undefined || typeof candidate.mimeType === 'string';
  const hasSize = candidate.sizeBytes === undefined
    || (typeof candidate.sizeBytes === 'number' && Number.isFinite(candidate.sizeBytes) && candidate.sizeBytes >= 0);
  const hasBody = typeof candidate.content === 'string' || typeof candidate.uri === 'string';
  return typeof candidate.key === 'string'
    && (kind === 'metadata' || kind === 'text' || kind === 'image' || kind === 'file')
    && (source === 'prompt' || source === 'response' || source === 'tool' || source === 'import')
    && hasContent
    && hasUri
    && hasName
    && hasMimeType
    && hasSize
    && hasBody;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function mapCoreWriteError(error: unknown): { status: number; body: ErrorResponse } {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();

  if (
    lowered.includes('invalid')
    || lowered.includes('database must')
    || lowered.includes('turn must include')
    || lowered.includes('turn session does not match')
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

function validateTurn(turn: TurnContent | undefined): string | null {
  if (!turn) {
    return 'turn is required';
  }

  const unknownFields = Object.keys(turn).filter((key) => !TURN_CONTENT_FIELDS.has(key));
  if (unknownFields.length > 0) {
    return `turn contains unexpected fields: ${unknownFields.join(', ')}`;
  }

  if (typeof turn.sessionId !== 'string' || !hasTextContent(turn.sessionId)) {
    return 'turn.sessionId is required';
  }

  if (typeof turn.agent !== 'string' || !hasTextContent(turn.agent)) {
    return 'turn.agent is required';
  }

  if (turn.project !== undefined && !hasTextContent(turn.project)) {
    return 'turn.project must be a non-empty string';
  }

  if (turn.cwd !== undefined && !hasTextContent(turn.cwd)) {
    return 'turn.cwd must be a non-empty string';
  }

  if (
    turn.metadata !== undefined
    && turn.metadata !== null
    && (typeof turn.metadata !== 'object' || Array.isArray(turn.metadata))
  ) {
    return 'turn.metadata must be an object or null';
  }

  if (
    turn.turnSequence !== undefined
    && (!Number.isSafeInteger(turn.turnSequence) || turn.turnSequence < 0)
  ) {
    return 'turn.turnSequence must be a non-negative safe integer';
  }

  if (!hasTextContent(turn.prompt)) {
    return 'turn.prompt is required';
  }

  if (!hasTextContent(turn.response)) {
    return 'turn.response is required';
  }

  if ('title' in turn) {
    return 'turn.title is not supported';
  }

  if ('summary' in turn) {
    return 'turn.summary is not supported';
  }

  if (turn.createdAt !== undefined && !isTimestamp(turn.createdAt)) {
    return 'turn.createdAt must be an ISO timestamp';
  }

  if (turn.updatedAt !== undefined && !isTimestamp(turn.updatedAt)) {
    return 'turn.updatedAt must be an ISO timestamp';
  }

  if (!Array.isArray(turn.events) || turn.events.length === 0) {
    return 'turn.events must be a non-empty array';
  }

  if (!turn.events.every(isTurnEvent)) {
    return 'turn.events must be an array of turn event objects';
  }

  if (turn.artifacts !== undefined && !Array.isArray(turn.artifacts)) {
    return 'turn.artifacts must be an array';
  }

  if (turn.artifacts && !turn.artifacts.every(isArtifact)) {
    return 'turn.artifacts must be an array of artifact objects';
  }

  return null;
}

function validateBatchTurns(turnsInput: unknown): { turns: TurnContent[] | null; error: string | null } {
  if (!Array.isArray(turnsInput) || turnsInput.length === 0) {
    return { turns: null, error: 'turns must be a non-empty array' };
  }

  const turns: TurnContent[] = [];
  for (const [index, turn] of turnsInput.entries()) {
    if (!turn || typeof turn !== 'object' || Array.isArray(turn)) {
      return { turns: null, error: `turns[${index}] must be a turn object` };
    }
    const validationError = validateTurn(turn as TurnContent);
    if (validationError) {
      return { turns: null, error: `turns[${index}]: ${validationError}` };
    }
    turns.push(turn as TurnContent);
  }

  return { turns, error: null };
}

async function filterAllowedTurns(turns: TurnContent[]): Promise<{ turns: TurnContent[]; skippedTurns: number }> {
  const allowedTurns: TurnContent[] = [];
  let skippedTurns = 0;
  for (const turn of turns) {
    const ingest = typeof turn.metadata?.ingest === 'string' ? turn.metadata.ingest : '';
    if (ingest.endsWith('-hook') && turn.project) {
      if (!(await isCaptureEnabled(turn.agent, turn.project))) {
        skippedTurns += 1;
        continue;
      }
    }
    allowedTurns.push(turn);
  }
  return { turns: allowedTurns, skippedTurns };
}

app.post('/api/v1/turn/capture', async (c) => {
  let body: CaptureTurnRequest;
  try {
    body = await c.req.json<CaptureTurnRequest>();
  } catch {
    return c.json(errorResponse('invalidRequest', 'Invalid JSON body'), 400);
  }

  const validationError = validateTurn(body.turn);
  if (validationError) {
    return c.json(errorResponse('invalidRequest', validationError), 400);
  }
  if (!body.turn) {
    return c.json(errorResponse('invalidRequest', 'turn is required'), 400);
  }

  // Live hook captures are gated by the per-project capture allowlist; manual
  // imports (ingest ending in '-import') and other writers are unaffected.
  const ingest = typeof body.turn.metadata?.ingest === 'string' ? body.turn.metadata.ingest : '';
  if (ingest.endsWith('-hook') && body.turn.project) {
    if (!(await isCaptureEnabled(body.turn.agent, body.turn.project))) {
      return c.body(null, 204);
    }
  }

  try {
    await captureTurn(body.turn, body.database);
  } catch (error) {
    const mapped = mapCoreWriteError(error);
    return c.json(mapped.body, mapped.status as 400 | 500);
  }

  invalidateSessionTreeCache();
  return c.body(null, 204);
});

app.post('/api/v1/turn/capture/batch', async (c) => {
  let body: CaptureTurnsRequest | null;
  try {
    body = await c.req.json<CaptureTurnsRequest>();
  } catch {
    return c.json(errorResponse('invalidRequest', 'Invalid JSON body'), 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json(errorResponse('invalidRequest', 'request body must be an object'), 400);
  }

  const validated = validateBatchTurns(body.turns);
  if (validated.error || !validated.turns) {
    return c.json(errorResponse('invalidRequest', validated.error ?? 'turns are required'), 400);
  }

  const allowed = await filterAllowedTurns(validated.turns);
  let capturedTurns = 0;
  try {
    if (allowed.turns.length > 0) {
      capturedTurns = await captureTurns(allowed.turns, body.database);
    }
  } catch (error) {
    const mapped = mapCoreWriteError(error);
    return c.json(mapped.body, mapped.status as 400 | 500);
  }

  if (capturedTurns > 0) {
    invalidateSessionTreeCache();
  }
  const dedupedTurns = allowed.turns.length - capturedTurns;
  const response: CaptureTurnsResponse = {
    capturedTurns,
    skippedTurns: allowed.skippedTurns + dedupedTurns,
    requestId: generateRequestId(),
  };
  return c.json(response, 200);
});

app.post('/api/v1/benchmark/locomo/turn/capture', async (c) => {
  let body: CaptureTurnRequest;
  try {
    body = await c.req.json<CaptureTurnRequest>();
  } catch {
    return c.json(errorResponse('invalidRequest', 'Invalid JSON body'), 400);
  }

  const validationError = validateTurn(body.turn);
  if (validationError) {
    return c.json(errorResponse('invalidRequest', validationError), 400);
  }
  if (!body.turn) {
    return c.json(errorResponse('invalidRequest', 'turn is required'), 400);
  }

  try {
    await captureTurn(body.turn, body.database);
    const written = await findWrittenTurn(body.turn, body.database);
    if (!written) {
      return c.json(errorResponse('internalError', 'failed to resolve captured turn'), 500);
    }
    invalidateSessionTreeCache();
    return c.json({
      turn: written,
      requestId: generateRequestId(),
    });
  } catch (error) {
    const mapped = mapCoreWriteError(error);
    if (mapped.status === 500) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json(errorResponse('internalError', message), 500);
    }
    return c.json(mapped.body, mapped.status as 400 | 500);
  }
});

async function findWrittenTurn(turn: TurnContent, database?: string) {
  const recent = await turns.list({
    mode: { type: 'recency', limit: 20 },
    agent: turn.agent,
    sessionId: turn.sessionId,
    database,
  });
  return recent.find((candidate) => (
    candidate.prompt === turn.prompt
    && candidate.response === turn.response
  )) ?? null;
}
