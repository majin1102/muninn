import { addMessage } from '@munnai/core';
import { Hono } from 'hono';
import type {
  AddMessageToSessionRequest,
  ErrorResponse,
  SessionMessageInput,
} from '@munnai/types';
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
  const storedTurn = await addMessage(persistedSession);

  return c.json({
    turnId: storedTurn.turnId,
    requestId: generateRequestId(),
  });
});
