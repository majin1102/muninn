import { Hono, type Context, type Next } from 'hono';
import { cors } from 'hono/cors';
import type {
  AppStatusResponse,
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
import { muninnSessionKey, type MuninnSessionIdentity } from '@muninn/common/session-identity';
import {
  captureTurn,
  captureTurns,
  dreaming,
  memories,
  memoryPipeline,
  sessions,
  turns,
} from './backend.js';
import type { RecallMode, SessionSnapshot } from './backend.js';
import type { RecallHit, RenderedMemory } from './api/memory.js';
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

app.get('/app/api/status', async (c) => {
  const database = c.req.query('database');
  const requestId = generateRequestId();
  let watermark;
  try {
    watermark = await memoryPipeline.watermark(database);
  } catch (error) {
    const mapped = mapCoreLookupError(error);
    return c.json(mapped.body, mapped.status as 400 | 500 | 503);
  }

  return c.json(appStatusFromWatermark(watermark, requestId));
});

app.post('/api/v1/mcp/recall', async (c) => {
  const parsed = await readJsonRecord(c);
  if (!parsed.body) {
    return c.text(parsed.error ?? 'Invalid JSON body', 400);
  }
  const unsupported = rejectUnsupportedFields(parsed.body, new Set(['query', 'budget', 'top_k']));
  if (unsupported) {
    return c.text(unsupported, 400);
  }
  const query = readRequiredString(parsed.body, 'query');
  if (query.error || !query.value) {
    return c.text(query.error ?? 'query is required', 400);
  }
  const topK = readPositiveInteger(parsed.body, 'top_k', MCP_DEFAULT_TOP_K, MCP_MAX_TOP_K);
  if (topK.error) {
    return c.text(topK.error, 400);
  }
  const budget = readNonNegativeInteger(parsed.body, 'budget', MCP_DEFAULT_BUDGET, MCP_MAX_BUDGET);
  if (budget.error) {
    return c.text(budget.error, 400);
  }

  try {
    const hits = await memories.recall(query.value, topK.value, {
      budget: budget.value,
      queryLimit: topK.value,
    });
    return c.text(renderMcpRecall(hits), 200);
  } catch (error) {
    const mapped = mapCoreLookupError(error);
    return c.text(mapped.body.errorMessage, mapped.status as 400 | 500 | 503);
  }
});

app.post('/api/v1/mcp/list', async (c) => {
  const parsed = await readJsonRecord(c);
  if (!parsed.body) {
    return c.text(parsed.error ?? 'Invalid JSON body', 400);
  }
  const unsupported = rejectUnsupportedFields(parsed.body, new Set(['query', 'top_k', 'session_identity']));
  if (unsupported) {
    return c.text(unsupported, 400);
  }
  const query = readRequiredString(parsed.body, 'query');
  if (query.error || !query.value) {
    return c.text(query.error ?? 'query is required', 400);
  }
  const topK = readPositiveInteger(parsed.body, 'top_k', MCP_DEFAULT_TOP_K, MCP_MAX_TOP_K);
  if (topK.error) {
    return c.text(topK.error, 400);
  }
  const currentSession = parseMcpSessionIdentity(parsed.body.session_identity);
  if (currentSession.error) {
    return c.text(currentSession.error, 400);
  }

  try {
    return c.text(renderMcpList(await mcpListCandidates({
      query: query.value,
      topK: topK.value,
      currentSession: currentSession.value,
    })), 200);
  } catch (error) {
    const mapped = mapCoreLookupError(error);
    return c.text(mapped.body.errorMessage, mapped.status as 400 | 500 | 503);
  }
});

app.post('/api/v1/mcp/read', async (c) => {
  const parsed = await readJsonRecord(c);
  if (!parsed.body) {
    return c.text(parsed.error ?? 'Invalid JSON body', 400);
  }
  const unsupported = rejectUnsupportedFields(parsed.body, new Set(['context_ids']));
  if (unsupported) {
    return c.text(unsupported, 400);
  }
  const contextIds = readOptionalStringArray(parsed.body, 'context_ids');
  if (contextIds.error || !contextIds.value) {
    return c.text(contextIds.error ?? 'context_ids is required', 400);
  }
  try {
    return c.text(await renderMcpRead(contextIds.value), 200);
  } catch (error) {
    const mapped = mapCoreLookupError(error);
    return c.text(mapped.body.errorMessage, mapped.status as 400 | 500 | 503);
  }
});

app.post('/api/v1/mcp/explain', async (c) => {
  const parsed = await readJsonRecord(c);
  if (!parsed.body) {
    return c.text(parsed.error ?? 'Invalid JSON body', 400);
  }
  const unsupported = rejectUnsupportedFields(parsed.body, new Set(['context_id']));
  if (unsupported) {
    return c.text(unsupported, 400);
  }
  const contextId = readRequiredString(parsed.body, 'context_id');
  if (contextId.error || !contextId.value) {
    return c.text(contextId.error ?? 'context_id is required', 400);
  }
  try {
    const result = await renderMcpExplain(contextId.value);
    return c.text(result.text, result.status ?? 200);
  } catch (error) {
    const mapped = mapCoreLookupError(error);
    return c.text(mapped.body.errorMessage, mapped.status as 400 | 500 | 503);
  }
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

export function appStatusFromWatermark(watermark: MemoryWatermark, requestId: string): AppStatusResponse {
  const phase = watermark.phases.extractor;
  const pendingTurns = watermark.pending.turns.length;
  const status = watermark.error || phase === 'error'
    ? 'error'
    : phase === 'pending' || phase === 'running' || phase === 'draining' || pendingTurns > 0
      ? 'warning'
      : 'ok';

  return {
    status,
    extractor: {
      phase,
      pendingTurns,
      ...(watermark.error ? { error: watermark.error } : {}),
    },
    requestId,
  };
}

const MCP_DEFAULT_TOP_K = 8;
const MCP_MAX_TOP_K = 50;
const MCP_DEFAULT_BUDGET = 4_000;
const MCP_MAX_BUDGET = 20_000;
const MCP_SESSION_SCAN_LIMIT = 500;

type JsonRecord = Record<string, unknown>;

type McpSessionCandidate = {
  contextId: string;
  title: string;
  summary: string;
  snapshot: SessionSnapshot;
};

async function readJsonRecord(c: Context): Promise<{ body: JsonRecord | null; error: string | null }> {
  try {
    const body = await c.req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { body: null, error: 'JSON body must be an object' };
    }
    return { body: body as JsonRecord, error: null };
  } catch {
    return { body: null, error: 'Invalid JSON body' };
  }
}

function rejectUnsupportedFields(body: JsonRecord, allowed: Set<string>): string | null {
  const unsupported = Object.keys(body).filter((key) => !allowed.has(key));
  return unsupported.length > 0 ? `unsupported fields: ${unsupported.join(', ')}` : null;
}

function readRequiredString(body: JsonRecord, fieldName: string): { value: string | null; error: string | null } {
  const value = body[fieldName];
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { value: null, error: `${fieldName} is required` };
  }
  return { value: value.trim(), error: null };
}

function readPositiveInteger(
  body: JsonRecord,
  fieldName: string,
  fallback: number,
  max: number,
): { value: number; error: string | null } {
  const raw = body[fieldName];
  if (raw === undefined) {
    return { value: fallback, error: null };
  }
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) {
    return { value: fallback, error: `${fieldName} must be a positive integer` };
  }
  if (raw > max) {
    return { value: fallback, error: `${fieldName} must be less than or equal to ${max}` };
  }
  return { value: raw, error: null };
}

function readNonNegativeInteger(
  body: JsonRecord,
  fieldName: string,
  fallback: number,
  max: number,
): { value: number; error: string | null } {
  const raw = body[fieldName];
  if (raw === undefined) {
    return { value: fallback, error: null };
  }
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    return { value: fallback, error: `${fieldName} must be a non-negative integer` };
  }
  if (raw > max) {
    return { value: fallback, error: `${fieldName} must be less than or equal to ${max}` };
  }
  return { value: raw, error: null };
}

function readOptionalStringArray(body: JsonRecord, fieldName: string): { value: string[] | null; error: string | null } {
  const value = body[fieldName];
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    return { value: null, error: `${fieldName} must be a non-empty string array` };
  }
  return { value: value.map((item) => item.trim()), error: null };
}

function parseMcpSessionIdentity(value: unknown): { value: MuninnSessionIdentity | undefined; error: string | null } {
  if (value === undefined) {
    return { value: undefined, error: null };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { value: undefined, error: 'session_identity must be an object' };
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.project !== 'string'
    || row.project.trim().length === 0
    || typeof row.sessionId !== 'string'
    || row.sessionId.trim().length === 0
    || typeof row.agent !== 'string'
    || row.agent.trim().length === 0
  ) {
    return { value: undefined, error: 'session_identity requires project, sessionId, and agent' };
  }
  return {
    value: {
      project: row.project.trim(),
      sessionId: row.sessionId.trim(),
      agent: row.agent.trim(),
    },
    error: null,
  };
}

function toContextId(memoryId: string): string | null {
  if (memoryId.startsWith('turn:')) {
    return `turn_${memoryId.slice('turn:'.length)}`;
  }
  if (memoryId.startsWith('session:')) {
    return `session_${memoryId.slice('session:'.length)}`;
  }
  if (memoryId.startsWith('ext:')) {
    return memoryId;
  }
  return null;
}

function toMemoryId(contextId: string): { memoryId: string | null; kind: 'session' | 'turn' | 'extraction' | null } {
  if (contextId.startsWith('ext:') && contextId.length > 'ext:'.length) {
    return { memoryId: contextId, kind: 'extraction' };
  }
  if (contextId.startsWith('turn_') && contextId.length > 'turn_'.length) {
    return { memoryId: `turn:${contextId.slice('turn_'.length)}`, kind: 'turn' };
  }
  if (contextId.startsWith('session_') && contextId.length > 'session_'.length) {
    return { memoryId: `session:${contextId.slice('session_'.length)}`, kind: 'session' };
  }
  return { memoryId: null, kind: null };
}

function previewText(value: string | undefined, maxChars = 120): string {
  const singleLine = (value ?? '').replace(/\s+/g, ' ').trim();
  return singleLine.length > maxChars ? `${singleLine.slice(0, maxChars - 1)}...` : singleLine;
}

function stripExtractionReferences(detail: string | undefined): string | undefined {
  if (!detail) {
    return undefined;
  }
  const stripped = detail.replace(/\n\nReferences:\n[\s\S]*$/m, '').trim();
  return stripped || undefined;
}

function renderMcpRecall(hits: RecallHit[]): string {
  const lines = ['# Muninn Recall'];
  const sourceRows = new Map<string, { reason: string; preview: string }>();
  if (hits.length === 0) {
    lines.push('', 'No matching Muninn context found.');
  }
  for (const hit of hits) {
    if (hit.memoryId === 'recalled:memory') {
      lines.push('', hit.content.trim());
    } else {
      const contextId = toContextId(hit.memoryId);
      if (contextId) {
        sourceRows.set(contextId, {
          reason: hit.title ?? 'matched extracted context',
          preview: previewText(hit.summary ?? hit.content),
        });
      }
      lines.push(
        '',
        `## ${contextId ?? hit.memoryId}`,
        '',
        hit.title ? `Title: ${hit.title}` : '',
        hit.summary ? `Summary: ${hit.summary}` : '',
        hit.content ? `Preview: ${previewText(hit.content, 500)}` : '',
      );
    }
    for (const reference of hit.references ?? []) {
      const contextId = toContextId(reference);
      if (contextId && !sourceRows.has(contextId)) {
        sourceRows.set(contextId, {
          reason: `source reference for ${hit.title ?? hit.memoryId}`,
          preview: '',
        });
      }
    }
  }
  if (sourceRows.size > 0) {
    lines.push('', '## Source Context References', '', '| context_id | reason | preview |', '|---|---|---|');
    for (const [contextId, row] of sourceRows) {
      lines.push(`| ${contextId} | ${row.reason.replace(/\|/g, '\\|')} | ${row.preview.replace(/\|/g, '\\|')} |`);
    }
  }
  return lines.filter((line) => line !== '').join('\n');
}

function sessionMatchesHit(snapshot: SessionSnapshot, hit: RecallHit): boolean {
  return snapshot.sessionId === hit.sessionId
    && snapshot.agent === hit.agent
    && (snapshot.project === hit.project || snapshot.cwd === hit.cwd);
}

function sessionKeyForSnapshot(snapshot: SessionSnapshot): string {
  return muninnSessionKey({
    project: snapshot.project,
    agent: snapshot.agent,
    sessionId: snapshot.sessionId,
  });
}

async function mcpListCandidates(params: {
  query: string;
  topK: number;
  currentSession?: MuninnSessionIdentity;
}): Promise<McpSessionCandidate[]> {
  const hits = await memories.recall(params.query, params.topK * 4, {
    budget: 0,
    queryLimit: params.topK * 4,
  });
  const snapshots = await sessions.list({ mode: { type: 'recency', limit: MCP_SESSION_SCAN_LIMIT } });
  const currentSessionKey = params.currentSession ? muninnSessionKey(params.currentSession) : undefined;
  const candidates: McpSessionCandidate[] = [];
  const seen = new Set<string>();

  for (const hit of hits) {
    const snapshot = snapshots.find((candidate) => sessionMatchesHit(candidate, hit));
    if (!snapshot || seen.has(snapshot.snapshotId)) {
      continue;
    }
    if (currentSessionKey && sessionKeyForSnapshot(snapshot) === currentSessionKey) {
      continue;
    }
    const contextId = toContextId(snapshot.snapshotId);
    if (!contextId) {
      continue;
    }
    seen.add(snapshot.snapshotId);
    candidates.push({
      contextId,
      title: snapshot.title || hit.displaySession || hit.title || snapshot.sessionId,
      summary: snapshot.summary || hit.summary || previewText(hit.content, 240),
      snapshot,
    });
    if (candidates.length >= params.topK) {
      break;
    }
  }
  return candidates;
}

function renderMcpList(candidates: McpSessionCandidate[]): string {
  const lines = ['# Muninn List'];
  if (candidates.length === 0) {
    lines.push('', 'No matching prior session contexts found.');
    return lines.join('\n');
  }
  candidates.forEach((candidate, index) => {
    lines.push(
      '',
      `${index + 1}. ${candidate.title}`,
      `   context_id: ${candidate.contextId}`,
      `   summary: ${candidate.summary || '(empty)'}`,
    );
  });
  return lines.join('\n');
}

function renderReadMemory(contextId: string, memory: RenderedMemory): string {
  const detail = contextId.startsWith('ext:')
    ? stripExtractionReferences(memory.detail)
    : memory.detail;
  return [
    `## ${contextId}`,
    memory.title ? `Title: ${memory.title}` : '',
    memory.summary ? `Summary: ${memory.summary}` : '',
    detail ? ['', detail].join('\n') : '',
  ].filter((line) => line !== '').join('\n');
}

async function renderMcpRead(contextIds: string[]): Promise<string> {
  const lines = ['# Muninn Read'];
  for (const contextId of contextIds) {
    const { memoryId } = toMemoryId(contextId);
    if (!memoryId) {
      lines.push('', `## ${contextId}`, 'Error: unsupported context_id');
      continue;
    }
    const memory = await memories.get(memoryId);
    if (!memory) {
      lines.push('', `## ${contextId}`, 'Error: context not found');
      continue;
    }
    lines.push('', renderReadMemory(contextId, memory));
  }
  return lines.join('\n');
}

async function renderMcpExplain(contextId: string): Promise<{ text: string; status?: 400 | 404 }> {
  const { memoryId, kind } = toMemoryId(contextId);
  if (!memoryId || kind !== 'session') {
    return { text: 'muninn-explain only accepts session_* context_id values', status: 400 };
  }
  const snapshot = await sessions.get(memoryId);
  if (!snapshot) {
    return { text: 'context not found', status: 404 };
  }
  const lines = [
    '# Muninn Explain',
    '',
    `Explained: ${contextId}`,
    '',
    '## Source Provenance',
    '',
    `Project: ${snapshot.project}`,
    `Agent: ${snapshot.agent}`,
    `Session ID: ${snapshot.sessionId}`,
    `Snapshot: ${snapshot.snapshotId}`,
  ];
  if (snapshot.references.length === 0) {
    lines.push('', 'No source references recorded.');
    return { text: lines.join('\n') };
  }
  for (const reference of snapshot.references) {
    const referenceContextId = toContextId(reference) ?? reference;
    lines.push('', `### ${referenceContextId}`);
    try {
      const turn = reference.startsWith('turn:') ? await turns.get(reference) : null;
      if (turn?.prompt) {
        lines.push('', `Prompt: ${previewText(turn.prompt, 500)}`);
      }
      if (turn?.response) {
        lines.push('', `Response: ${previewText(turn.response, 500)}`);
      }
      if (!turn) {
        lines.push('', 'Source detail unavailable.');
      }
    } catch {
      lines.push('', 'Source detail unavailable.');
    }
  }
  return { text: lines.join('\n') };
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
  if (rendered.memoryId.startsWith('ext:')) {
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

  let capturedTurns = 0;
  try {
    if (validated.turns.length > 0) {
      capturedTurns = await captureTurns(validated.turns, body.database);
    }
  } catch (error) {
    const mapped = mapCoreWriteError(error);
    return c.json(mapped.body, mapped.status as 400 | 500);
  }

  if (capturedTurns > 0) {
    invalidateSessionTreeCache();
  }
  const dedupedTurns = validated.turns.length - capturedTurns;
  const response: CaptureTurnsResponse = {
    capturedTurns,
    skippedTurns: dedupedTurns,
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
