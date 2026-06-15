import type { ObserverCheckpoint } from '../checkpoint.js';
import type { CheckpointLock, MemoryWatermark } from '../backend.js';
import { getObserverLlmConfig, getObserverRuntimeConfig, resolveDatabaseName } from '../config.js';
import { writeMuninnLog } from '../logging.js';
import type { NativeTables } from '../native.js';
import { applyObservationBatch } from './observation.js';
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
      observationContext: 0,
      observation: 0,
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

  enqueue(changes: QueuedExtractionChange[]): void {
    this.observeQueue = enqueueChanges(this.observeQueue, changes);
    this.lastError = null;
    this.wake();
  }

  async watermark(): Promise<MemoryWatermark> {
    const pendingExtractionIds = pendingQueueExtractionIds(this.observeQueue);
    const phase = this.lastError
      ? 'error'
      : this.drainRequested
        ? 'draining'
        : this.running
          ? 'running'
          : pendingExtractionIds.length > 0
            ? 'pending'
            : 'idle';
    return {
      pending: {
        turns: [],
        extractions: pendingExtractionIds,
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
        await applyObservationBatch({
          client: this.client,
          observerName: this.name,
          cwd: batch.cwd,
          extractionChanges: batch.extractionChanges,
          signal: this.shutdownController.signal,
          database: this.database,
        });
      });
      this.lastError = null;
      this.observeQueue = ackBucket(
        this.observeQueue,
        batch.key,
        batch.extractionChanges.map((change) => change.extraction.id),
      );
      if (finalize && pendingQueueExtractionIds(this.observeQueue).length === 0) {
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

function pendingQueueExtractionIds(queue: ObserveQueue): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const bucket of queue.cwdBuckets) {
    for (const change of bucket.extractionChanges) {
      if (seen.has(change.extraction.id)) {
        continue;
      }
      seen.add(change.extraction.id);
      ids.push(change.extraction.id);
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

export type ObserveQueue = {
  cwdBuckets: ObserveCwdBucket[];
};

export type ObserveCwdBucket = {
  key: string;
  cwd: string;
  extractionChanges: QueuedExtractionChange[];
};

export type ObserveBatch = {
  key: string;
  cwd: string;
  extractionChanges: QueuedExtractionChange[];
};

export function enqueueChanges(queue: ObserveQueue, changes: QueuedExtractionChange[]): ObserveQueue {
  let next = cloneQueue(queue);
  for (const change of changes) {
    const cwd = normalizedCwd(change.extraction.cwd);
    if (!cwd) {
      throw new Error(`extraction ${change.extraction.id} missing cwd`);
    }
    for (const bucket of next.cwdBuckets) {
      if (bucket.extractionChanges.some((queued) => queued.extraction.id === change.extraction.id)) {
        next = replaceInBucket(next, bucket.key, change);
      }
    }
    next = enqueueForCwd(next, cwd, change);
  }
  return next;
}

export function readyBucket(
  queue: ObserveQueue,
  options: { threshold: number; batchSize: number; finalize: boolean },
): ObserveBatch | null {
  for (const bucket of queue.cwdBuckets) {
    const ready = options.finalize
      ? bucket.extractionChanges.length > 0
      : bucket.extractionChanges.length >= options.threshold;
    if (!ready) {
      continue;
    }
    return {
      key: bucket.key,
      cwd: bucket.cwd,
      extractionChanges: bucket.extractionChanges.slice(0, options.batchSize),
    };
  }
  return null;
}

export function ackBucket(queue: ObserveQueue, key: string, extractionIds: string[]): ObserveQueue {
  const acked = new Set(extractionIds);
  return {
    cwdBuckets: queue.cwdBuckets
      .map((bucket) => {
        if (bucket.key !== key) {
          return bucket;
        }
        return {
          ...bucket,
          extractionChanges: bucket.extractionChanges
            .filter((change) => !acked.has(change.extraction.id)),
        };
      })
      .filter((bucket) => bucket.extractionChanges.length > 0),
  };
}

export function queueStats(queue: ObserveQueue, threshold: number): {
  queuedCount: number;
  readyBucketCount: number;
  readyCount: number;
} {
  let queuedCount = 0;
  let readyBucketCount = 0;
  let readyCount = 0;
  for (const bucket of queue.cwdBuckets) {
    queuedCount += bucket.extractionChanges.length;
    if (bucket.extractionChanges.length >= threshold) {
      readyBucketCount += 1;
      readyCount += bucket.extractionChanges.length;
    }
  }
  return { queuedCount, readyBucketCount, readyCount };
}

export function cloneQueue(queue: ObserveQueue): ObserveQueue {
  return {
    cwdBuckets: queue.cwdBuckets.map((bucket) => ({
      key: bucket.key,
      cwd: bucket.cwd,
      extractionChanges: bucket.extractionChanges.map(cloneChange),
    })),
  };
}

export function normalizeCwd(cwd: string): string {
  return normalizedCwd(cwd);
}

function normalizedCwd(cwd: string): string {
  return cwd.trim().replace(/\/+$/, '') || cwd.trim();
}

function enqueueForCwd(queue: ObserveQueue, cwd: string, change: QueuedExtractionChange): ObserveQueue {
  const key = normalizeCwd(cwd);
  const cwdBuckets = [...queue.cwdBuckets];
  const index = cwdBuckets.findIndex((bucket) => bucket.key === key);
  if (index < 0) {
    cwdBuckets.push({ key, cwd, extractionChanges: [cloneChange(change)] });
    return { cwdBuckets };
  }
  cwdBuckets[index] = upsertChange(cwdBuckets[index], change);
  return { cwdBuckets };
}

function replaceInBucket(queue: ObserveQueue, key: string, change: QueuedExtractionChange): ObserveQueue {
  return {
    cwdBuckets: queue.cwdBuckets.map((bucket) => (bucket.key === key ? upsertChange(bucket, change) : bucket)),
  };
}

function upsertChange(bucket: ObserveCwdBucket, change: QueuedExtractionChange): ObserveCwdBucket {
  const index = bucket.extractionChanges
    .findIndex((queued) => queued.extraction.id === change.extraction.id);
  if (index < 0) {
    return {
      ...bucket,
      extractionChanges: [...bucket.extractionChanges, cloneChange(change)],
    };
  }
  const extractionChanges = [...bucket.extractionChanges];
  extractionChanges[index] = cloneChange(change);
  return { ...bucket, extractionChanges };
}

function cloneChange(change: QueuedExtractionChange): QueuedExtractionChange {
  return {
    type: change.type,
    extraction: {
      ...change.extraction,
      vector: [...change.extraction.vector],
      turnRefs: [...change.extraction.turnRefs],
      observationPaths: [...change.extraction.observationPaths],
    },
  };
}
