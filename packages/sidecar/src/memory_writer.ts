import { addMessage } from '@muninn/core';
import { invalidateSessionTreeCache } from '@muninn/board/server';
import { Hono } from 'hono';
import type {
  Artifact,
  CaptureTurnRequest,
  ErrorResponse,
  ToolCall,
  TurnContent,
} from '@muninn/types';
import { generateRequestId } from './utils.js';

export const memoryWriter = new Hono();

const TURN_CONTENT_FIELDS = new Set([
  'sessionId',
  'agent',
  'toolCalls',
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

function isToolCall(value: unknown): value is ToolCall {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.name === 'string'
    && (candidate.id === undefined || typeof candidate.id === 'string')
    && (candidate.input === undefined || typeof candidate.input === 'string')
    && (candidate.output === undefined || typeof candidate.output === 'string');
}

function isArtifact(value: unknown): value is Artifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.key === 'string'
    && typeof candidate.content === 'string';
}

function mapCoreWriteError(error: unknown): { status: number; body: ErrorResponse } {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();

  if (
    lowered.includes('invalid')
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

  if (!hasTextContent(turn.prompt)) {
    return 'turn.prompt is required';
  }

  if (!hasTextContent(turn.response)) {
    return 'turn.response is required';
  }

  if (turn.toolCalls !== undefined && !Array.isArray(turn.toolCalls)) {
    return 'turn.toolCalls must be an array';
  }

  if (turn.toolCalls && !turn.toolCalls.every(isToolCall)) {
    return 'turn.toolCalls must be an array of tool call objects';
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

  try {
    await addMessage(body.turn);
  } catch (error) {
    const mapped = mapCoreWriteError(error);
    return c.json(mapped.body, mapped.status as 400 | 500);
  }

  invalidateSessionTreeCache();
  return c.body(null, 204);
});
