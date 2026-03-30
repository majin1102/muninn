export type LoggerLike = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export function logWarn(logger: LoggerLike, message: string, error?: unknown): void {
  const suffix = error ? `: ${formatError(error)}` : "";
  logger.warn?.(`[munnai] ${message}${suffix}`);
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
