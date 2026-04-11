import { addMessage } from '@muninn/core';
import { invalidateSessionTreeCache } from '@muninn/board/server';
import { Hono } from 'hono';
import type {
  AddMessageToSessionRequest,
  ErrorResponse,
  TurnContent,
} from '@muninn/types';
import { generateRequestId } from './utils.js';

export const memoryWriter = new Hono();

const TURN_CONTENT_FIELDS = new Set([
  'sessionId',
  'agent',
  'title',
  'summary',
  'toolCalling',
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

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === 'string');
}

function hasTextContent(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasMessageContent(session: TurnContent): boolean {
  return hasTextContent(session.title)
    || hasTextContent(session.summary)
    || hasTextContent(session.prompt)
    || hasTextContent(session.response)
    || (session.toolCalling !== undefined && session.toolCalling.length > 0)
    || (session.artifacts !== undefined && Object.keys(session.artifacts).length > 0);
}

function mapCoreWriteError(error: unknown): { status: number; body: ErrorResponse } {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();

  if (
    lowered.includes('invalid')
    || lowered.includes('turn must include at least one message field')
    || lowered.includes('message session does not match')
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

function validateSession(session: TurnContent | undefined): string | null {
  if (!session) {
    return 'session is required';
  }

  const unknownFields = Object.keys(session).filter((key) => !TURN_CONTENT_FIELDS.has(key));
  if (unknownFields.length > 0) {
    return `session contains unexpected fields: ${unknownFields.join(', ')}`;
  }

  if (!session.agent || typeof session.agent !== 'string') {
    return 'session.agent is required';
  }

  if (session.sessionId !== undefined && typeof session.sessionId !== 'string') {
    return 'session.sessionId must be a string';
  }

  if (session.title !== undefined && typeof session.title !== 'string') {
    return 'session.title must be a string';
  }

  if (session.summary !== undefined && typeof session.summary !== 'string') {
    return 'session.summary must be a string';
  }

  if (session.prompt !== undefined && typeof session.prompt !== 'string') {
    return 'session.prompt must be a string';
  }

  if (session.response !== undefined && typeof session.response !== 'string') {
    return 'session.response must be a string';
  }

  if (session.toolCalling !== undefined && !Array.isArray(session.toolCalling)) {
    return 'session.toolCalling must be an array of strings';
  }

  if (session.toolCalling && !session.toolCalling.every((entry: string) => typeof entry === 'string')) {
    return 'session.toolCalling must be an array of strings';
  }

  if (session.artifacts !== undefined && !isStringRecord(session.artifacts)) {
    return 'session.artifacts must be a record of string values';
  }

  if (!hasMessageContent(session)) {
    return 'session must include at least one message field';
  }

  return null;
}

memoryWriter.post('/api/v1/session/messages', async (c) => {
  let body: AddMessageToSessionRequest;
  try {
    body = await c.req.json<AddMessageToSessionRequest>();
  } catch {
    return c.json(errorResponse('invalidRequest', 'Invalid JSON body'), 400);
  }

  console.log('[SESSION_MESSAGES]', JSON.stringify(body, null, 2));

  const validationError = validateSession(body.session);
  if (validationError) {
    return c.json(errorResponse('invalidRequest', validationError), 400);
  }
  if (!body.session) {
    return c.json(errorResponse('invalidRequest', 'session is required'), 400);
  }

  let storedTurn;
  try {
    storedTurn = await addMessage(body.session);
  } catch (error) {
    const mapped = mapCoreWriteError(error);
    return c.json(mapped.body, mapped.status as 400 | 500);
  }

  invalidateSessionTreeCache();

  return c.json({
    turnId: storedTurn.turnId,
    requestId: generateRequestId(),
  });
});
