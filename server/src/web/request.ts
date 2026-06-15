import type { ErrorResponse } from '@muninn/common';

export function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

export function errorResponse(errorCode: string, errorMessage: string): ErrorResponse {
  return {
    errorCode,
    errorMessage,
    requestId: generateRequestId(),
  };
}

export function parseNumber(value: string | undefined, defaultValue?: number): number | undefined {
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}
