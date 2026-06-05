import {
  memories,
  observer,
} from '@muninn/core';
import { Hono } from 'hono';
import type {
  ErrorResponse,
  MemoryHit,
  MemoryResponse,
  MemoryWatermark,
  MemoryWatermarkResponse,
} from '@muninn/types';
import type { RecallMode, RenderedMemory } from '@muninn/core';
import { renderRecallHit, renderRenderedMemoryHit } from './render.js';
import { generateRequestId } from './utils.js';

export const memoryLoader = new Hono();

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
  observationRatio?: number | null;
};

memoryLoader.get('/api/v1/recall', async (c) => {
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

memoryLoader.post('/api/v1/benchmark/locomo/recall', async (c) => {
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
      hits.push(toLocomoHit(rendered, row.text));
    }
    return c.json({ hits, requestId: generateRequestId() });
  } catch (error) {
    const mapped = mapCoreLookupError(error);
    return c.json(mapped.body, mapped.status as 400 | 500);
  }
});

memoryLoader.get('/api/v1/list', async (c) => {
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
  row: { memoryId: string; text: string },
): LocomoBridgeHit {
  return {
    memory_id: row.memoryId,
    matched_text: row.text,
    detail: row.text,
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
    observationRatio: observingRatio(rendered.detail),
  };
}

function renderBridgeMemoryText(rendered: RenderedMemory, matchedText: string): string {
  if (rendered.memoryId.startsWith('session_observation:')) {
    const sessionObservation = matchedText || rendered.summary || rendered.title || '';
    const context = rendered.detail?.match(/(?:^|\n)Context:\n([\s\S]*?)(?:\n\nReferences:|$)/)?.[1]?.trim();
    return [
      `SESSION_OBSERVATION: ${sessionObservation}`,
      context ? `CONTEXT: ${context}` : '',
    ].filter(Boolean).join('\n');
  }
  return matchedText || rendered.summary || rendered.title || rendered.detail || '';
}

function observingRatio(detail?: string | null): number | null | undefined {
  if (!detail) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const extractions = Array.isArray(record.extractions) ? record.extractions : [];
  const contextRefs = Array.isArray(record.contextRefs) ? record.contextRefs : [];
  return contextRefs.length === 0 ? null : extractions.length / contextRefs.length;
}

memoryLoader.get('/api/v1/timeline', async (c) => {
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

memoryLoader.get('/api/v1/detail', async (c) => {
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

memoryLoader.get('/api/v1/memory/watermark', async (c) => {
  const database = c.req.query('database');
  let watermark;
  try {
    watermark = await observer.watermark(database);
  } catch (error) {
    const mapped = mapCoreLookupError(error);
    return c.json(mapped.body, mapped.status as 400 | 500);
  }

  return c.json(memoryWatermarkResponse(watermark));
});

memoryLoader.post('/api/v1/memory/finalize', async (c) => {
  let database: string | undefined;
  try {
    const body = await c.req.json().catch(() => ({})) as { database?: unknown };
    database = typeof body.database === 'string' ? body.database : c.req.query('database');
  } catch {
    database = c.req.query('database');
  }
  let watermark;
  try {
    watermark = await observer.finalize(database);
  } catch (error) {
    const mapped = mapCoreLookupError(error);
    return c.json(mapped.body, mapped.status as 400 | 500);
  }

  return c.json(memoryWatermarkResponse(watermark));
});
