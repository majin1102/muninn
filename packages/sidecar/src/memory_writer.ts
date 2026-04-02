import { addMessage } from '@muninn/core';
import { invalidateSessionTreeCache } from '@muninn/board/server';
import { Hono } from 'hono';
import type {
  AddMessageToSessionRequest,
  ErrorResponse,
  SessionMessageInput,
} from '@muninn/types';
import { generateRequestId } from './utils.js';

export const memoryWriter = new Hono();

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

function hasMessageContent(session: SessionMessageInput): boolean {
  return hasTextContent(session.title)
    || hasTextContent(session.summary)
    || hasTextContent(session.prompt)
    || hasTextContent(session.response)
    || (session.tool_calling !== undefined && session.tool_calling.length > 0)
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

function validateSession(session: SessionMessageInput | undefined): string | null {
  if (!session) {
    return 'session is required';
  }

  if (!session.agent || typeof session.agent !== 'string') {
    return 'session.agent is required';
  }

  if (session.session_id !== undefined && typeof session.session_id !== 'string') {
    return 'session.session_id must be a string';
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

  if (session.tool_calling !== undefined && !Array.isArray(session.tool_calling)) {
    return 'session.tool_calling must be an array of strings';
  }

  if (session.tool_calling && !session.tool_calling.every((entry: string) => typeof entry === 'string')) {
    return 'session.tool_calling must be an array of strings';
  }

  if (session.artifacts !== undefined && !isStringRecord(session.artifacts)) {
    return 'session.artifacts must be a record of string values';
  }

  if (session.extra !== undefined && !isStringRecord(session.extra)) {
    return 'session.extra must be a record of string values';
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

  const { extra: _extra, ...persistedSession } = body.session;
  let storedTurn;
  try {
    storedTurn = await addMessage(persistedSession);
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
