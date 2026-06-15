import { Hono } from 'hono';
import type { RecallProvidersResponse, SearchResponse, SearchSessionResult } from '@muninn/common';
import { memories } from '../backend.js';
import { ndjsonStream, recallEvents, recallProviderOptions } from './recall.js';
import { searchAppMemory } from './search.js';
import { errorResponse, generateRequestId } from './request.js';

export const recallRoutes = new Hono();

function normalizeText(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeTextList(values: string[] | undefined): string[] {
  return [...new Set((values ?? [])
    .map((value) => normalizeText(value))
    .filter((value): value is string => Boolean(value) && value !== 'all'))];
}

recallRoutes.get('/app/api/recall/providers', (c) => {
  const response: RecallProvidersResponse = {
    providers: recallProviderOptions(),
    requestId: generateRequestId(),
  };
  return c.json(response);
});

recallRoutes.get('/app/api/recall/search', async (c) => {
  const query = normalizeText(c.req.query('query'));
  if (!query) {
    return c.json(errorResponse('invalidRequest', 'query is required'), 400);
  }

  const projectKeys = normalizeTextList(c.req.queries('projectKey'));
  const sessionKeys = normalizeTextList(c.req.queries('sessionKey'));

  const sessionTopN = parsePositiveInteger(c.req.query('sessionTopN'), 3);
  if (typeof sessionTopN === 'string') {
    return c.json(errorResponse('invalidRequest', `sessionTopN ${sessionTopN}`), 400);
  }
  const topN = parsePositiveInteger(c.req.query('topN'), 20);
  if (typeof topN === 'string') {
    return c.json(errorResponse('invalidRequest', `topN ${topN}`), 400);
  }

  const search = await searchAppMemory({
    query,
    projectKeys,
    sessionKeys,
    sessionTopN,
    topN,
  }, {
    recall: memories.recall,
  });

  const response: SearchResponse = {
    results: search.results,
    requestId: generateRequestId(),
  };
  return c.json(response);
});

recallRoutes.post('/app/api/recall/agent', async (c) => {
  const body = await c.req.json().catch(() => null) as {
    query?: unknown;
    provider?: unknown;
    results?: unknown;
  } | null;
  const query = normalizeText(typeof body?.query === 'string' ? body.query : undefined);
  if (!query) {
    return c.json(errorResponse('invalidRequest', 'query is required'), 400);
  }
  const provider = normalizeText(typeof body?.provider === 'string' ? body.provider : undefined) ?? 'default';
  if (provider === 'none') {
    return c.json(errorResponse('invalidRequest', 'provider none does not run agent recall'), 400);
  }
  const results = Array.isArray(body?.results) ? body.results as SearchSessionResult[] : null;
  if (!results) {
    return c.json(errorResponse('invalidRequest', 'results is required'), 400);
  }
  return ndjsonStream(recallEvents({
    query,
    provider,
    results,
    signal: c.req.raw.signal,
  }));
});

function parsePositiveInteger(value: string | undefined, fallback: number): number | string {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 'must be a positive integer';
}
