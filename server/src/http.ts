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
import type { MuninnSessionIdentity } from '@muninn/common/session-identity';
import {
  captureTurn,
  captureTurns,
  dreaming,
  memories,
  memoryPipeline,
  turns,
} from './backend.js';
import type { RecallPublicMode } from './backend.js';
import { type RecallHit, type RenderedContext } from './api/memory.js';
import { parseSnapshotContent } from './pipeline/snapshot.js';
import { renderRecallHit, renderRenderedContextHit } from './web/render.js';
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
  const unsupported = rejectUnsupportedFields(parsed.body, new Set(['query', 'budget', 'top_k', 'mode', 'session_identity']));
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
  const mode = parseMcpRecallMode(parsed.body.mode);
  if (mode.error) {
    return c.text(mode.error, 400);
  }
  const currentSession = parseMcpSessionIdentity(parsed.body.session_identity);
  if (currentSession.error) {
    return c.text(currentSession.error, 400);
  }
  const budget = mode.value === 'session'
    ? { value: undefined, error: parsed.body.budget === undefined ? null : 'budget is only supported in extraction recall mode' }
    : readNonNegativeInteger(parsed.body, 'budget', MCP_DEFAULT_BUDGET, MCP_MAX_BUDGET);
  if (budget.error) {
    return c.text(budget.error, 400);
  }

  try {
    const hits = mode.value === 'session'
      ? await memories.recall(query.value, topK.value, currentSession.value
        ? { mode: 'session', excludeSession: currentSession.value }
        : { mode: 'session' })
      : await memories.recall(query.value, topK.value, {
        mode: 'extraction',
        budget: budget.value,
        queryLimit: topK.value,
      });
    return c.text(renderMcpRecall(hits, mode.value), 200);
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

function errorResponse(errorCode: string, errorMessage: string): ErrorResponse {
  return {
    errorCode,
    errorMessage,
    requestId: generateRequestId(),
  };
}

function memoryResponse(contextHits: MemoryHit[]): MemoryResponse {
  return {
    contextHits,
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
const MCP_SESSION_EXTRACTION_SUMMARY_CHARS = 100;

type JsonRecord = Record<string, unknown>;

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

function parseMcpRecallMode(value: unknown): { value: RecallPublicMode; error: string | null } {
  if (value === undefined) {
    return { value: 'extraction', error: null };
  }
  if (value === 'session' || value === 'extraction') {
    return { value, error: null };
  }
  return { value: 'extraction', error: 'mode must be one of: session, extraction' };
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

function renderMcpRecall(hits: RecallHit[], mode: RecallPublicMode = 'extraction'): string {
  if (mode === 'session') {
    return renderMcpSessionRecall(hits);
  }
  const lines = ['# Muninn Recall'];
  const sourceRows = new Map<string, { reason: string; preview: string }>();
  if (hits.length === 0) {
    lines.push('', 'No matching Muninn context found.');
  }
  for (const hit of hits) {
    if (hit.kind === 'synthesis') {
      lines.push('', hit.content.trim());
    } else {
      const contextId = hit.contextId;
      if (contextId) {
        sourceRows.set(contextId, {
          reason: hit.title ?? 'matched extracted context',
          preview: previewText(hit.summary ?? hit.content),
        });
      }
      lines.push(
        '',
        `## ${contextId ?? 'unknown context'}`,
        '',
        hit.title ? `Title: ${hit.title}` : '',
        hit.summary ? `Summary: ${hit.summary}` : '',
        hit.content ? `Preview: ${previewText(hit.content, 500)}` : '',
      );
    }
    for (const reference of hit.references ?? []) {
      const contextId = reference.trim();
      if (contextId && !sourceRows.has(contextId)) {
        sourceRows.set(contextId, {
          reason: `source reference for ${hit.title ?? hit.contextId ?? 'synthesis'}`,
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

function renderMcpSessionRecall(hits: RecallHit[]): string {
  const lines = ['# Muninn Recall'];
  if (hits.length === 0) {
    lines.push('', 'No matching prior session contexts found.');
    return lines.join('\n');
  }
  hits.forEach((hit, index) => {
    if (!hit.contextId?.startsWith('session:')) {
      return;
    }
    lines.push(
      '',
      `${index + 1}. ${hit.title || hit.displaySession || hit.sessionId || hit.contextId}`,
      `   context_id: ${hit.contextId}`,
      `   summary: ${hit.summary || previewText(hit.content, 240) || '(empty)'}`,
    );
  });
  return lines.join('\n');
}

function truncateMcpSummary(value: string, maxChars = MCP_SESSION_EXTRACTION_SUMMARY_CHARS): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  const chars = Array.from(normalized);
  if (chars.length <= maxChars) {
    return normalized;
  }
  return `${chars.slice(0, Math.max(0, maxChars - 3)).join('')}...`;
}

function snapshotRefsFromMarkdown(markdown: string | undefined): Set<string> {
  const refs = new Set<string>();
  const text = markdown ?? '';
  for (const match of text.matchAll(/(?:<!--|^|;)\s*refs:\s*\[([^\]]*)\]/gim)) {
    const list = match[1] ?? '';
    for (const item of list.split(',')) {
      const ref = item.trim();
      if (ref) {
        refs.add(ref);
      }
    }
  }
  return refs;
}

function renderSessionExtractionSummaries(detail: string | undefined): string | undefined {
  if (!detail?.trim()) {
    return undefined;
  }
  let parsed: ReturnType<typeof parseSnapshotContent>;
  try {
    parsed = parseSnapshotContent(detail, snapshotRefsFromMarkdown(detail), {
      includeContextIds: true,
    });
  } catch {
    return undefined;
  }
  if (parsed.extractions.length === 0) {
    return undefined;
  }
  const lines = ['## Extractions'];
  parsed.extractions.forEach((extraction, index) => {
    lines.push(
      '',
      `${index + 1}. context_id: ${extraction.id ? `ext:${extraction.id}` : '(missing)'}`,
      `   summary: ${truncateMcpSummary(extraction.text)}`,
    );
  });
  return lines.join('\n');
}

function renderReadContext(contextId: string, context: RenderedContext): string {
  const detail = contextId.startsWith('ext:')
    ? stripExtractionReferences(context.detail)
    : contextId.startsWith('session:')
      ? renderSessionExtractionSummaries(context.detail)
      : context.detail;
  return [
    `## ${contextId}`,
    context.title ? `Title: ${context.title}` : '',
    context.summary ? `Summary: ${context.summary}` : '',
    detail ? ['', detail].join('\n') : '',
  ].filter((line) => line !== '').join('\n');
}

async function renderMcpRead(contextIds: string[]): Promise<string> {
  const lines = ['# Muninn Read'];
  for (const contextId of contextIds) {
    try {
      const context = await memories.getContext(contextId);
      if (!context) {
        lines.push('', `## ${contextId}`, 'Error: context not found');
        continue;
      }
      lines.push('', renderReadContext(contextId, context));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push('', `## ${contextId}`, `Error: ${message}`);
    }
  }
  return lines.join('\n');
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

function parseRecallPublicMode(raw: string | undefined): RecallPublicMode | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === 'session' || raw === 'extraction') {
    return raw;
  }
  throw new Error('mode must be one of: session, extraction');
}

function parseThinkingRatio(raw: string | undefined): { value: number | undefined; error: string | null } {
  if (raw === undefined) {
    return { value: undefined, error: null };
  }
  if (raw.trim() === '') {
    return { value: undefined, error: 'thinkingRatio must be a number between 0 and 1' };
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    return { value: undefined, error: 'thinkingRatio must be a number between 0 and 1' };
  }
  return { value, error: null };
}

type ErrorStatus = 400 | 404 | 500 | 503;

function mapCoreLookupError(error: unknown): { status: ErrorStatus; body: ErrorResponse } {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();

  if (
    lowered.includes('invalid')
    || lowered.includes('database must')
    || lowered.includes('memory layer')
    || lowered.includes('unsupported context id')
  ) {
    return {
      status: 400,
      body: errorResponse('invalidRequest', message),
    };
  }

  if (
    lowered.includes('session context not found')
    || lowered.includes('session snapshot not found')
  ) {
    return {
      status: 404,
      body: errorResponse('notFound', message),
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
  context_id: string;
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
  let mode: RecallPublicMode | undefined;

  try {
    if (c.req.query('recallMode') !== undefined) {
      throw new Error('recallMode is no longer supported; use mode with session or extraction');
    }
    mode = parseRecallPublicMode(c.req.query('mode'));
  } catch (error) {
    return c.json(errorResponse('invalidRequest', error instanceof Error ? error.message : String(error)), 400);
  }

  console.log('[RECALL] database:', database ?? 'main', 'query:', query, 'limit:', limit, 'budget:', budget, 'queryLimit:', queryLimit, 'thinkingRatio:', thinkingRatio, 'mode:', mode);

  if (!query) {
    return c.json(errorResponse('invalidRequest', 'query is required'), 400);
  }

  if (
    mode === 'session'
    && (budget !== undefined || queryLimit !== undefined || thinkingRatio !== undefined)
  ) {
    return c.json(errorResponse(
      'invalidRequest',
      'budget, queryLimit, and thinkingRatio are only supported in extraction recall mode',
    ), 400);
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
  const parsedThinkingRatio = parseThinkingRatio(thinkingRatio);
  if (parsedThinkingRatio.error) {
    return c.json(errorResponse('invalidRequest', parsedThinkingRatio.error), 400);
  }
  if ((parsedBudget.value ?? 0) > 0 && parsedQueryLimit.value === 0) {
    return c.json(errorResponse('invalidRequest', 'queryLimit must be positive when budget is positive'), 400);
  }

  const maxResults = parsedLimit.value ?? 10;
  let matched;
  try {
    matched = (await memories.recall(query, maxResults, {
      mode,
      budget: parsedBudget.value,
      queryLimit: parsedQueryLimit.value,
      thinkingRatio: parsedThinkingRatio.value,
      database,
    })).map(renderRecallHit);
  } catch (error) {
    const mapped = mapCoreLookupError(error);
    return c.json(mapped.body, mapped.status);
  }

  return c.json(memoryResponse(matched));
});

app.post('/api/v1/context/read', async (c) => {
  let body: { database?: unknown; context_ids?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json(errorResponse('invalidRequest', 'Invalid JSON body'), 400);
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json(errorResponse('invalidRequest', 'request body must be an object'), 400);
  }
  if (!Array.isArray(body.context_ids) || body.context_ids.length === 0) {
    return c.json(errorResponse('invalidRequest', 'context_ids must be a non-empty array'), 400);
  }
  if (!body.context_ids.every((contextId) => typeof contextId === 'string')) {
    return c.json(errorResponse('invalidRequest', 'context_ids must contain only strings'), 400);
  }
  if (body.database !== undefined && typeof body.database !== 'string') {
    return c.json(errorResponse('invalidRequest', 'database must be a string'), 400);
  }

  try {
    const contexts = await memories.readContextIds(body.context_ids, body.database);
    return c.json({ contexts, requestId: generateRequestId() });
  } catch (error) {
    const mapped = mapCoreLookupError(error);
    return c.json(mapped.body, mapped.status);
  }
});

app.post('/api/v1/benchmark/locomo/recall', async (c) => {
  let body: {
    query?: unknown;
    database?: unknown;
    limit?: unknown;
    budget?: unknown;
    queryLimit?: unknown;
    thinkingRatio?: unknown;
    mode?: unknown;
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
  let mode: RecallPublicMode | undefined;
  try {
    if (body.recallMode !== undefined) {
      throw new Error('recallMode is no longer supported; use mode with session or extraction');
    }
    if (body.mode !== undefined && typeof body.mode !== 'string') {
      throw new Error('mode must be one of: session, extraction');
    }
    mode = parseRecallPublicMode(body.mode);
  } catch (error) {
    return c.json(errorResponse('invalidRequest', error instanceof Error ? error.message : String(error)), 400);
  }
  if (
    mode === 'session'
    && (body.budget !== undefined || body.queryLimit !== undefined || body.thinkingRatio !== undefined)
  ) {
    return c.json(errorResponse(
      'invalidRequest',
      'budget, queryLimit, and thinkingRatio are only supported in extraction recall mode',
    ), 400);
  }
  const parsedThinkingRatio = parseRequestRatio(body.thinkingRatio, 'thinkingRatio');
  if (parsedThinkingRatio.error) {
    return c.json(errorResponse('invalidRequest', parsedThinkingRatio.error), 400);
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
  const manifest = parseLocomoManifest(body.manifest);
  if (!manifest) {
    return c.json(errorResponse('invalidRequest', 'manifest.turns is required'), 400);
  }

  const database = typeof body.database === 'string' ? body.database : undefined;
  try {
    const rows = await memories.recall(body.query, parsedLimit.value ?? 10, {
      mode,
      budget: parsedBudget.value,
      queryLimit: parsedQueryLimit.value,
      thinkingRatio: parsedThinkingRatio.value,
      database,
    });
    const hits: LocomoBridgeHit[] = [];
    for (const row of rows) {
      if (row.kind === 'synthesis') {
        hits.push(toRecalledLocomoHit(row));
        continue;
      }
      if (!row.contextId) {
        continue;
      }
      const rendered = await memories.getContext(row.contextId, database);
      if (!rendered) {
        continue;
      }
      hits.push(toLocomoHit(rendered, row.content));
    }
    return c.json({ hits, requestId: generateRequestId() });
  } catch (error) {
    const mapped = mapCoreLookupError(error);
    return c.json(mapped.body, mapped.status);
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
  const recent = (await memories.list({ mode: { type: 'recency', limit: maxResults }, database })).map(renderRenderedContextHit);

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

function parseRequestRatio(
  raw: unknown,
  fieldName: string,
): { value: number | undefined; error: string | null } {
  if (raw === undefined || raw === null) {
    return { value: undefined, error: null };
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) {
    return {
      value: undefined,
      error: `${fieldName} must be a number between 0 and 1`,
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
  row: { content: string },
): LocomoBridgeHit {
  return {
    context_id: 'synthesis',
    matched_text: row.content,
    detail: row.content,
  };
}

function toLocomoHit(
  rendered: RenderedContext,
  matchedText: string,
): LocomoBridgeHit {
  return {
    context_id: rendered.contextId,
    matched_text: matchedText,
    detail: renderBridgeContextText(rendered, matchedText),
  };
}

function renderBridgeContextText(rendered: RenderedContext, matchedText: string): string {
  if (rendered.contextId.startsWith('ext:')) {
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
  const contextId = c.req.query('contextId');
  const database = c.req.query('database');
  const beforeLimit = c.req.query('beforeLimit');
  const afterLimit = c.req.query('afterLimit');

  console.log('[TIMELINE] database:', database ?? 'main', 'contextId:', contextId, 'beforeLimit:', beforeLimit, 'afterLimit:', afterLimit);

  if (!contextId) {
    return c.json(errorResponse('invalidRequest', 'contextId is required'), 400);
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
      contextId,
      beforeLimit: parsedBeforeLimit.value ?? 3,
      afterLimit: parsedAfterLimit.value ?? 3,
      database,
    })).map(renderRenderedContextHit);
  } catch (error) {
    const mapped = mapCoreLookupError(error);
    return c.json(mapped.body, mapped.status);
  }

  if (windowed.length === 0) {
    return c.json(errorResponse('notFound', 'contextId not found'), 404);
  }

  return c.json(memoryResponse(windowed));
});

app.get('/api/v1/detail', async (c) => {
  const contextId = c.req.query('contextId');
  const database = c.req.query('database');

  console.log('[DETAIL] database:', database ?? 'main', 'contextId:', contextId);

  if (!contextId) {
    return c.json(errorResponse('invalidRequest', 'contextId is required'), 400);
  }

  let context;
  try {
    context = await memories.getContext(contextId, database);
  } catch (error) {
    const mapped = mapCoreLookupError(error);
    return c.json(mapped.body, mapped.status);
  }

  if (!context) {
    return c.json(errorResponse('notFound', 'contextId not found'), 404);
  }

  return c.json(memoryResponse([renderRenderedContextHit(context)]));
});

app.get('/api/v1/memory/watermark', async (c) => {
  const database = c.req.query('database');
  let watermark;
  try {
    watermark = await memoryPipeline.watermark(database);
  } catch (error) {
    const mapped = mapCoreLookupError(error);
    return c.json(mapped.body, mapped.status);
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
    return c.json(mapped.body, mapped.status);
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

function mapCoreWriteError(error: unknown): { status: 400 | 500; body: ErrorResponse } {
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
    return c.json(mapped.body, mapped.status);
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
    return c.json(mapped.body, mapped.status);
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
    return c.json(mapped.body, mapped.status);
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
