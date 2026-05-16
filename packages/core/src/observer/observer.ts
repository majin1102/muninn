import type { ObserverCheckpoint } from '../checkpoint.js';
import type { CheckpointLock, MemoryWatermark } from '../backend.js';
import { getObserverLlmConfig, getObserverRuntimeConfig } from '../config.js';
import type { NativeTables } from '../native.js';
import { hasPendingObserverWork, runObserver } from './runner.js';

const BASE_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 5_000;
const IDLE_POLL_MS = 1_000;

const noopCheckpointLock: CheckpointLock = {
  shared: async (operation) => operation(),
  exclusive: async (operation) => operation(),
};

export class Observer {
  readonly name: string;
  private readonly anchorThreshold: number;
  private readonly shutdownController = new AbortController();
  private readonly changeWaiters = new Set<() => void>();
  private loopPromise: Promise<void> | null = null;
  private running = false;
  private shuttingDown = false;

  constructor(
    private readonly client: NativeTables,
    private readonly checkpoint: ObserverCheckpoint | null = null,
    private readonly checkpointLock: CheckpointLock = noopCheckpointLock,
  ) {
    const config = getObserverLlmConfig();
    if (!config) {
      throw new Error('observer is required.');
    }
    this.name = config.name;
    this.anchorThreshold = getObserverRuntimeConfig().anchorThreshold;
  }

  start(): void {
    if (!this.loopPromise) {
      this.loopPromise = this.run();
    }
  }

  notify(): void {
    this.wake();
  }

  async watermark(): Promise<MemoryWatermark> {
    const pending = await hasPendingObserverWork({
      client: this.client,
      anchorThreshold: this.anchorThreshold,
      signal: this.shutdownController.signal,
    });
    if (pending) {
      this.notify();
    }
    return {
      resolved: !this.running && !pending,
      pendingTurnIds: [],
      observerPending: pending || this.running,
    };
  }

  exportCheckpoint(): ObserverCheckpoint {
    return {
      baseline: this.checkpoint?.baseline ?? {
        extraction: 0,
        observationContext: 0,
        observation: 0,
      },
      runs: [],
    };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.shutdownController.abort(abortError('observer shutdown'));
    this.wake();
    if (this.loopPromise) {
      await this.loopPromise.catch(() => undefined);
    }
  }

  private async run(): Promise<void> {
    let retryDelayMs = BASE_RETRY_DELAY_MS;
    while (!this.shuttingDown) {
      try {
        const pending = await hasPendingObserverWork({
          client: this.client,
          anchorThreshold: this.anchorThreshold,
          signal: this.shutdownController.signal,
        });
        if (!pending) {
          await this.waitForChange(IDLE_POLL_MS);
          retryDelayMs = BASE_RETRY_DELAY_MS;
          continue;
        }
        this.running = true;
        await this.checkpointLock.shared(async () => {
          await runObserver({
            client: this.client,
            observerName: this.name,
            anchorThreshold: this.anchorThreshold,
            signal: this.shutdownController.signal,
          });
        });
        this.running = false;
        retryDelayMs = BASE_RETRY_DELAY_MS;
      } catch (error) {
        this.running = false;
        if (this.shuttingDown || isAbortError(error)) {
          break;
        }
        console.error(`[muninn:observer] observer run failed: ${String(error)}`);
        await sleep(retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
      }
    }
  }

  private waitForChange(timeoutMs: number): Promise<void> {
    if (this.shuttingDown) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.changeWaiters.delete(waiter);
        resolve();
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      const waiter = () => {
        clearTimeout(timer);
        this.changeWaiters.delete(waiter);
        resolve();
      };
      this.changeWaiters.add(waiter);
    });
  }

  private wake(): void {
    for (const waiter of this.changeWaiters) {
      waiter();
    }
    this.changeWaiters.clear();
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
