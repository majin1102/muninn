import { Hono } from 'hono';
import type { ErrorResponse, MemoryHit, MemoryResponse } from '@munnai/types';
import { renderTurnHit } from './render.js';
import { readTurns } from './storage.js';
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

function includesQuery(value: string | undefined, query: string): boolean {
  return !!value && value.toLowerCase().includes(query.toLowerCase());
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
  const turns = await readTurns();
  const matched = turns
    .filter((turn) =>
      includesQuery(turn.summary, query) ||
      includesQuery(turn.details, query) ||
      includesQuery(turn.prompt, query) ||
      includesQuery(turn.response, query)
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, maxResults)
    .map(renderTurnHit);

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
  const turns = await readTurns();
  const recent = turns
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, maxResults)
    .map(renderTurnHit);

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

  const before = beforeLimit ? Number(beforeLimit) : 3;
  const after = afterLimit ? Number(afterLimit) : 3;
  const turns = (await readTurns()).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const anchorIndex = turns.findIndex((turn) => turn.turnId === memoryId);

  if (anchorIndex === -1) {
    return c.json(errorResponse('notFound', 'memoryId not found'), 404);
  }

  const startIndex = Math.max(0, anchorIndex - before);
  const endIndex = Math.min(turns.length, anchorIndex + after + 1);
  const windowed = turns.slice(startIndex, endIndex).map(renderTurnHit);

  return c.json(memoryResponse(windowed));
});

memoryLoader.get('/api/v1/detail', async (c) => {
  const memoryId = c.req.query('memoryId');

  console.log('[DETAIL] memoryId:', memoryId);

  if (!memoryId) {
    return c.json(errorResponse('invalidRequest', 'memoryId is required'), 400);
  }

  const turns = await readTurns();
  const turn = turns.find((entry) => entry.turnId === memoryId);

  if (!turn) {
    return c.json(errorResponse('notFound', 'memoryId not found'), 404);
  }

  return c.json(memoryResponse([renderTurnHit(turn)]));
});
