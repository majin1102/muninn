import {
  memories,
  observer,
} from '@muninn/core';
import { Hono } from 'hono';
import type {
  ErrorResponse,
  MemoryHit,
  MemoryResponse,
  ObserverWatermarkResponse,
} from '@muninn/types';
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

function observerWatermarkResponse(
  resolved: boolean,
  pendingTurnIds: string[],
): ObserverWatermarkResponse {
  return {
    resolved,
    pendingTurnIds,
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
  const thinkingRatio = c.req.query('thinkingRatio');

  console.log('[RECALL] query:', query, 'limit:', limit, 'thinkingRatio:', thinkingRatio);

  if (!query) {
    return c.json(errorResponse('invalidRequest', 'query is required'), 400);
  }

  const parsedLimit = parseNonNegativeInteger(limit, 'limit');
  if (parsedLimit.error) {
    return c.json(errorResponse('invalidRequest', parsedLimit.error), 400);
  }

  const maxResults = parsedLimit.value ?? 10;
  const matched = (await memories.recall(query, maxResults)).map(renderRecallHit);

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

memoryLoader.get('/api/v1/observer/watermark', async (c) => {
  let watermark;
  try {
    watermark = await observer.watermark();
  } catch (error) {
    const mapped = mapCoreLookupError(error);
    return c.json(mapped.body, mapped.status as 400 | 500);
  }

  return c.json(
    observerWatermarkResponse(watermark.resolved, watermark.pendingTurnIds)
  );
});
