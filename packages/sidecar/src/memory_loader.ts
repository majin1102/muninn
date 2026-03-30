import {
  memories,
} from '@munnai/core';
import { Hono } from 'hono';
import type { ErrorResponse, MemoryHit, MemoryResponse } from '@munnai/types';
import { renderRenderedMemoryHit } from './render.js';
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

memoryLoader.get('/api/v1/recall', async (c) => {
  const query = c.req.query('query');
  const limit = c.req.query('limit');
  const thinkingRatio = c.req.query('thinkingRatio');

  console.log('[RECALL] query:', query, 'limit:', limit, 'thinkingRatio:', thinkingRatio);

  if (!query) {
    return c.json(errorResponse('invalidRequest', 'query is required'), 400);
  }

  const maxResults = limit ? Number(limit) : 10;
  const matched = (await memories.recall(query, maxResults)).map(renderRenderedMemoryHit);

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

  const maxResults = limit ? Number(limit) : 10;
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

  let windowed;
  try {
    windowed = (await memories.timeline({
      memoryId,
      beforeLimit: beforeLimit ? Number(beforeLimit) : 3,
      afterLimit: afterLimit ? Number(afterLimit) : 3,
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
