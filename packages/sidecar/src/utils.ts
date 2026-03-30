import os from 'node:os';
import path from 'node:path';

/**
 * Generate a unique request ID
 * Format: req_ followed by random string
 */
export function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Parse query parameter as number
 */
export function parseNumber(value: string | undefined, defaultValue?: number): number | undefined {
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

export function resolveConfigPath(): string {
  if (process.env.MUNNAI_HOME) {
    return path.join(process.env.MUNNAI_HOME, 'settings.json');
  }

  return path.join(os.homedir(), '.munnai', 'settings.json');
}
