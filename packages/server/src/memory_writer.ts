import { captureTurn, turns } from '@muninn/core';
import { invalidateSessionTreeCache, isCaptureEnabled } from './ui/app.js';
import { Hono } from 'hono';
import type {
  Artifact,
  CaptureTurnRequest,
  ErrorResponse,
  TurnEvent,
  TurnContent,
} from '@muninn/types';
import { generateRequestId } from './utils.js';

export const memoryWriter = new Hono();

const TURN_CONTENT_FIELDS = new Set([
  'sessionId',
  'project',
  'cwd',
  'agent',
  'metadata',
  'createdAt',
  'updatedAt',
  'title',
  'summary',
  'events',
  'artifacts',
  'prompt',
  'response',
]);

function errorResponse(errorCode: string, errorMessage: string): ErrorResponse {
  return {
    errorCode,
    errorMessage,
    requestId: generateRequestId(),
  };
}

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

  if (!hasTextContent(turn.prompt)) {
    return 'turn.prompt is required';
  }

  if (!hasTextContent(turn.response)) {
    return 'turn.response is required';
  }

  if (turn.createdAt !== undefined && !isTimestamp(turn.createdAt)) {
    return 'turn.createdAt must be an ISO timestamp';
  }

  if (turn.updatedAt !== undefined && !isTimestamp(turn.updatedAt)) {
    return 'turn.updatedAt must be an ISO timestamp';
  }

  if (turn.title !== undefined && !hasTextContent(turn.title)) {
    return 'turn.title must be a non-empty string';
  }

  if (turn.summary !== undefined && !hasTextContent(turn.summary)) {
    return 'turn.summary must be a non-empty string';
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

memoryWriter.post('/api/v1/turn/capture', async (c) => {
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

memoryWriter.post('/api/v1/benchmark/locomo/turn/capture', async (c) => {
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
