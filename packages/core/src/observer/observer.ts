import type { ObserverCheckpoint } from '../checkpoint.js';
import type { CheckpointLock, MemoryWatermark } from '../backend.js';
import { getObserverLlmConfig, getObserverRuntimeConfig, resolveDatabaseName } from '../config.js';
import { writeMuninnLog } from '../logging.js';
import type { NativeTables } from '../native.js';
import { runObserver } from './runner.js';
import { ackBucket, enqueueChanges, queueStats, readyBucket, type ObserveQueue } from './queue.js';
import type { QueuedExtractionChange } from '../checkpoint.js';

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
  private readonly anchorBatchSize: number;
  private readonly shutdownController = new AbortController();
  private readonly changeWaiters = new Set<() => void>();
  private loopPromise: Promise<void> | null = null;
  private running = false;
  private shuttingDown = false;
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
    this.anchorThreshold = runtime.anchorThreshold;
    this.anchorBatchSize = runtime.anchorBatchSize;
    this.baseline = checkpoint?.baseline ?? {
      observationContext: 0,
      observation: 0,
    };
    this.observeQueue = checkpoint?.observeQueue ?? { anchors: [] };
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

  enqueue(changes: QueuedExtractionChange[]): void {
    this.observeQueue = enqueueChanges(this.observeQueue, changes);
    this.wake();
  }

  async watermark(): Promise<MemoryWatermark> {
    const stats = queueStats(this.observeQueue, this.anchorThreshold);
    const pending = this.running || stats.readyCount > 0;
    return {
      resolved: !pending,
      pendingTurnIds: [],
      observerPending: pending,
      observerQueuedCount: stats.queuedCount,
      observerReadyCount: stats.readyCount,
      observerReadyBucketCount: stats.readyBucketCount,
    };
  }

  async finalize(): Promise<MemoryWatermark> {
    while (!this.shuttingDown) {
      const stats = queueStats(this.observeQueue, Number.POSITIVE_INFINITY);
      const pending = stats.queuedCount > 0 || this.running;
      if (!pending) {
        return {
          resolved: true,
          pendingTurnIds: [],
          observerPending: false,
          observerQueuedCount: 0,
          observerReadyCount: 0,
          observerReadyBucketCount: 0,
        };
      }
      if (this.running) {
        await sleep(50);
        continue;
      }
      await this.runOnce(true);
    }
    return {
      resolved: false,
      pendingTurnIds: [],
      observerPending: true,
      observerQueuedCount: queueStats(this.observeQueue, this.anchorThreshold).queuedCount,
    };
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
          threshold: this.anchorThreshold,
          batchSize: this.anchorBatchSize,
          finalize: false,
        });
        if (!batch) {
          await this.waitForChange(IDLE_POLL_MS);
          retryDelayMs = BASE_RETRY_DELAY_MS;
          continue;
        }
        await this.runOnce(false);
        retryDelayMs = BASE_RETRY_DELAY_MS;
      } catch (error) {
        this.running = false;
        if (this.shuttingDown || isAbortError(error)) {
          break;
        }
        const message = String(error);
        console.error(`[muninn:observer] observer run failed: ${message}`);
        await writeMuninnLog(this.database, 'error', 'observer', 'run_failed', { message });
        await sleep(retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
      }
    }
  }

  private async runOnce(finalize: boolean): Promise<void> {
    const batch = readyBucket(this.observeQueue, {
      threshold: this.anchorThreshold,
      batchSize: this.anchorBatchSize,
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
          anchor: batch.anchor,
          extractionChanges: batch.extractionChanges,
          signal: this.shutdownController.signal,
          database: this.database,
        });
      });
      this.observeQueue = ackBucket(
        this.observeQueue,
        batch.key,
        batch.extractionChanges.map((change) => change.extraction.id),
      );
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
