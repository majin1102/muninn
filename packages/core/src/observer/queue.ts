import type { QueuedExtractionChange } from '../checkpoint.js';

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
      globalObservationPaths: [...change.extraction.globalObservationPaths],
    },
  };
}
