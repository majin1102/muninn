const PROVIDER_TIMEOUT_MS = 180_000;

export function withProviderTimeout(parentSignal: AbortSignal | undefined, operation: string): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    const error = new Error(`${operation} timed out after ${PROVIDER_TIMEOUT_MS}ms`);
    error.name = 'TimeoutError';
    controller.abort(error);
  }, PROVIDER_TIMEOUT_MS);

  const abort = (): void => {
    controller.abort(parentSignal?.reason ?? abortError());
  };

  if (parentSignal?.aborted) {
    abort();
  } else {
    parentSignal?.addEventListener('abort', abort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', abort);
    },
  };
}

function abortError(): Error {
  const error = new Error('operation aborted');
  error.name = 'AbortError';
  return error;
}
