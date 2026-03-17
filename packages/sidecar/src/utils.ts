/**
 * Generate a unique request ID
 * Format: req_ followed by random string
 */
export function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Generate a unique turn ID for newly added turn records.
 */
export function generateTurnId(): string {
  return `turn_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Parse query parameter as number
 */
export function parseNumber(value: string | undefined, defaultValue?: number): number | undefined {
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}
