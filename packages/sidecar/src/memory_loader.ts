import {
  memories,
  observer,
} from '@muninn/core';
import { Hono } from 'hono';
import type {
  ErrorResponse,
  MemoryHit,
  MemoryResponse,
  MemoryWatermarkResponse,
} from '@muninn/types';
import type { RecallMode } from '@muninn/core';
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

function memoryWatermarkResponse(
  resolved: boolean,
  pendingTurnIds: string[],
  extractingEpoch?: number,
  committedEpoch?: number,
  observerPending?: boolean,
): MemoryWatermarkResponse {
  return {
    resolved,
    pendingTurnIds,
    extractingEpoch,
    committedEpoch,
    observerPending,
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

memoryLoader.get('/api/v1/recall', async (c) => {
  const query = c.req.query('query');
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

  console.log('[RECALL] query:', query, 'limit:', limit, 'budget:', budget, 'queryLimit:', queryLimit, 'thinkingRatio:', thinkingRatio, 'recallMode:', recallMode);

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
    })).map(renderRecallHit);
  } catch (error) {
    const mapped = mapCoreLookupError(error);
    return c.json(mapped.body, mapped.status as 400 | 500);
  }

  return c.json(memoryResponse(matched));
});

memoryLoader.get('/api/v1/list', async (c) => {
  const mode = c.req.query('mode');
  const limit = c.req.query('limit');
  const thinkingRatio = c.req.query('thinkingRatio');

  console.log('[LIST] mode:', mode, 'limit:', limit, 'thinkingRatio:', thinkingRatio);

  if (mode && mode !== 'recency') {
    return c.json(errorResponse('invalidRequest', 'mode must be "recency"'), 400);
  }

  const parsedLimit = parseNonNegativeInteger(limit, 'limit');
  if (parsedLimit.error) {
    return c.json(errorResponse('invalidRequest', parsedLimit.error), 400);
  }

  const maxResults = parsedLimit.value ?? 10;
  const recent = (await memories.list({ mode: { type: 'recency', limit: maxResults } })).map(renderRenderedMemoryHit);

  return c.json(memoryResponse(recent));
});

memoryLoader.get('/api/v1/timeline', async (c) => {
  const memoryId = c.req.query('memoryId');
  const beforeLimit = c.req.query('beforeLimit');
  const afterLimit = c.req.query('afterLimit');

  console.log('[TIMELINE] memoryId:', memoryId, 'beforeLimit:', beforeLimit, 'afterLimit:', afterLimit);

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

  console.log('[DETAIL] memoryId:', memoryId);

  if (!memoryId) {
    return c.json(errorResponse('invalidRequest', 'memoryId is required'), 400);
  }

  let memory;
  try {
    memory = await memories.get(memoryId);
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
  let watermark;
  try {
    watermark = await observer.watermark();
  } catch (error) {
    const mapped = mapCoreLookupError(error);
    return c.json(mapped.body, mapped.status as 400 | 500);
  }

  return c.json(
    memoryWatermarkResponse(
      watermark.resolved,
      watermark.pendingTurnIds,
      watermark.extractingEpoch,
      watermark.committedEpoch,
      watermark.observerPending,
    )
  );
});
