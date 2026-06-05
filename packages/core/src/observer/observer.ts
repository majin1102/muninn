import type { ObserverCheckpoint } from '../checkpoint.js';
import type { CheckpointLock, MemoryWatermark } from '../backend.js';
import { getObserverLlmConfig, getObserverRuntimeConfig, resolveDatabaseName } from '../config.js';
import { writeMuninnLog } from '../logging.js';
import type { NativeTables } from '../native.js';
import { runObserver } from './runner.js';
import { ackBucket, enqueueChanges, queueStats, readyBucket, type ObserveQueue } from './queue.js';
import type { QueuedSessionObservationChange } from '../checkpoint.js';

const BASE_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 5_000;
const IDLE_POLL_MS = 1_000;

const noopCheckpointLock: CheckpointLock = {
  shared: async (operation) => operation(),
  exclusive: async (operation) => operation(),
};

export class Observer {
  readonly name: string;
  private readonly cwdThreshold: number;
  private readonly cwdBatchSize: number;
  private readonly shutdownController = new AbortController();
  private readonly changeWaiters = new Set<() => void>();
  private loopPromise: Promise<void> | null = null;
  private running = false;
  private shuttingDown = false;
  private drainRequested = false;
  private lastError: { message: string } | null = null;
  private baseline: ObserverCheckpoint['baseline'];
  private observeQueue: ObserveQueue;

  constructor(
    private readonly client: NativeTables,
    private readonly checkpoint: ObserverCheckpoint | null = null,
    private readonly checkpointLock: CheckpointLock = noopCheckpointLock,
    database: string = 'main',
  ) {
    this.database = resolveDatabaseName(database);
    const config = getObserverLlmConfig();
    if (!config) {
      throw new Error('observer is required.');
    }
    this.name = config.name;
    const runtime = getObserverRuntimeConfig();
    this.cwdThreshold = runtime.cwdThreshold;
    this.cwdBatchSize = runtime.cwdBatchSize;
    this.baseline = checkpoint?.baseline ?? {
      globalObservationContext: 0,
      global_observation: 0,
    };
    this.observeQueue = checkpoint?.observeQueue ?? { cwdBuckets: [] };
  }

  private readonly database: string;

  start(): void {
    if (!this.loopPromise) {
      this.loopPromise = this.run();
    }
  }

  notify(): void {
    this.wake();
  }

  enqueue(changes: QueuedSessionObservationChange[]): void {
    this.observeQueue = enqueueChanges(this.observeQueue, changes);
    this.lastError = null;
    this.wake();
  }

  async watermark(): Promise<MemoryWatermark> {
    const pendingSessionObservationIds = pendingQueueSessionObservationIds(this.observeQueue);
    const phase = this.lastError
      ? 'error'
      : this.drainRequested
        ? 'draining'
        : this.running
          ? 'running'
          : pendingSessionObservationIds.length > 0
            ? 'pending'
            : 'idle';
    return {
      pending: {
        turns: [],
        extractions: pendingSessionObservationIds,
      },
      phases: {
        extractor: 'idle',
        observer: phase,
      },
      ...(this.lastError
        ? { error: { phase: 'observer' as const, message: this.lastError.message } }
        : {}),
    };
  }

  async finalize(): Promise<MemoryWatermark> {
    if (!this.shuttingDown) {
      this.drainRequested = true;
      this.lastError = null;
      this.wake();
    }
    return this.watermark();
  }

  exportCheckpoint(): ObserverCheckpoint {
    return {
      baseline: { ...this.baseline },
      observeQueue: this.observeQueue,
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
        const batch = readyBucket(this.observeQueue, {
          threshold: this.cwdThreshold,
          batchSize: this.cwdBatchSize,
          finalize: this.drainRequested,
        });
        if (!batch) {
          if (this.drainRequested && queueStats(this.observeQueue, Number.POSITIVE_INFINITY).queuedCount === 0) {
            this.drainRequested = false;
          }
          await this.waitForChange(IDLE_POLL_MS);
          retryDelayMs = BASE_RETRY_DELAY_MS;
          continue;
        }
        await this.runOnce(this.drainRequested);
        retryDelayMs = BASE_RETRY_DELAY_MS;
      } catch (error) {
        this.running = false;
        if (this.shuttingDown || isAbortError(error)) {
          break;
        }
        const message = String(error);
        this.lastError = { message };
        console.error(`[muninn:observer] observer run failed: ${message}`);
        await writeMuninnLog(this.database, 'error', 'observer', 'run_failed', { message });
        await sleep(retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
      }
    }
  }

  private async runOnce(finalize: boolean): Promise<void> {
    const batch = readyBucket(this.observeQueue, {
      threshold: this.cwdThreshold,
      batchSize: this.cwdBatchSize,
      finalize,
    });
    if (!batch) {
      return;
    }
    this.running = true;
    try {
      await this.checkpointLock.shared(async () => {
        await runObserver({
          client: this.client,
          observerName: this.name,
          cwd: batch.cwd,
          sessionObservationChanges: batch.sessionObservationChanges,
          signal: this.shutdownController.signal,
          database: this.database,
        });
      });
      this.lastError = null;
      this.observeQueue = ackBucket(
        this.observeQueue,
        batch.key,
        batch.sessionObservationChanges.map((change) => change.sessionObservation.id),
      );
      if (finalize && pendingQueueSessionObservationIds(this.observeQueue).length === 0) {
        this.drainRequested = false;
      }
    } finally {
      this.running = false;
      this.wake();
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

function pendingQueueSessionObservationIds(queue: ObserveQueue): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const bucket of queue.cwdBuckets) {
    for (const change of bucket.sessionObservationChanges) {
      if (seen.has(change.sessionObservation.id)) {
        continue;
      }
      seen.add(change.sessionObservation.id);
      ids.push(change.sessionObservation.id);
    }
  }
  return ids;
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
