import { Hono } from 'hono';
import type { AddMessageRequest, ErrorResponse, Message } from '@munnai/types';
import { appendMessage } from './storage.js';
import { generateRequestId, generateTurnId } from './utils.js';

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

function validateMessage(message: Message | undefined): string | null {
  if (!message) {
    return 'message is required';
  }

  if (!message.agent || typeof message.agent !== 'string') {
    return 'message.agent is required';
  }

  if (message.trace !== undefined && !Array.isArray(message.trace)) {
    return 'message.trace must be an array of strings';
  }

  if (message.trace && !message.trace.every((entry) => typeof entry === 'string')) {
    return 'message.trace must be an array of strings';
  }

  if (message.artifacts !== undefined && !isStringRecord(message.artifacts)) {
    return 'message.artifacts must be a record of string values';
  }

  return null;
}

memoryWriter.post('/api/v1/message/add', async (c) => {
  let body: AddMessageRequest;
  try {
    body = await c.req.json<AddMessageRequest>();
  } catch {
    return c.json(errorResponse('invalidRequest', 'Invalid JSON body'), 400);
  }

  console.log('[MESSAGE_ADD]', JSON.stringify(body, null, 2));

  const validationError = validateMessage(body.message);
  if (validationError) {
    return c.json(errorResponse('invalidRequest', validationError), 400);
  }

  const turnId = generateTurnId();
  const createdAt = new Date().toISOString();
  await appendMessage({
    turnId,
    createdAt,
    ...body.message,
  });

  return c.json({
    turnId,
    requestId: generateRequestId(),
  });
});
