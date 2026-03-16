import { Hono } from 'hono';
import type { AddTurnRequest, ErrorResponse, Turn } from '@munnai/types';
import { appendTurn } from './storage.js';
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

function validateTurn(turn: Turn | undefined): string | null {
  if (!turn) {
    return 'turn is required';
  }

  if (!turn.agent || typeof turn.agent !== 'string') {
    return 'turn.agent is required';
  }

  if (turn.tool_calling !== undefined && !Array.isArray(turn.tool_calling)) {
    return 'turn.tool_calling must be an array of strings';
  }

  if (turn.tool_calling && !turn.tool_calling.every((entry) => typeof entry === 'string')) {
    return 'turn.tool_calling must be an array of strings';
  }

  if (turn.artifacts !== undefined && !isStringRecord(turn.artifacts)) {
    return 'turn.artifacts must be a record of string values';
  }

  return null;
}

memoryWriter.post('/api/v1/message/add', async (c) => {
  let body: AddTurnRequest;
  try {
    body = await c.req.json<AddTurnRequest>();
  } catch {
    return c.json(errorResponse('invalidRequest', 'Invalid JSON body'), 400);
  }

  console.log('[MESSAGE_ADD]', JSON.stringify(body, null, 2));

  const validationError = validateTurn(body.turn);
  if (validationError) {
    return c.json(errorResponse('invalidRequest', validationError), 400);
  }

  const turnId = generateTurnId();
  const createdAt = new Date().toISOString();
  await appendTurn({
    turnId,
    createdAt,
    ...body.turn,
  });

  return c.json({
    turnId,
    requestId: generateRequestId(),
  });
});
