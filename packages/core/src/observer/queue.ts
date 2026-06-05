import type { QueuedSessionObservationChange } from '../checkpoint.js';

export type ObserveQueue = {
  cwdBuckets: ObserveCwdBucket[];
};

export type ObserveCwdBucket = {
  key: string;
  cwd: string;
  sessionObservationChanges: QueuedSessionObservationChange[];
};

export type ObserveBatch = {
  key: string;
  cwd: string;
  sessionObservationChanges: QueuedSessionObservationChange[];
};

export function enqueueChanges(queue: ObserveQueue, changes: QueuedSessionObservationChange[]): ObserveQueue {
  let next = cloneQueue(queue);
  for (const change of changes) {
    const cwd = normalizedCwd(change.sessionObservation.cwd);
    if (!cwd) {
      throw new Error(`session observation ${change.sessionObservation.id} missing cwd`);
    }
    for (const bucket of next.cwdBuckets) {
      if (bucket.sessionObservationChanges.some((queued) => queued.sessionObservation.id === change.sessionObservation.id)) {
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
      ? bucket.sessionObservationChanges.length > 0
      : bucket.sessionObservationChanges.length >= options.threshold;
    if (!ready) {
      continue;
    }
    return {
      key: bucket.key,
      cwd: bucket.cwd,
      sessionObservationChanges: bucket.sessionObservationChanges.slice(0, options.batchSize),
    };
  }
  return null;
}

export function ackBucket(queue: ObserveQueue, key: string, sessionObservationIds: string[]): ObserveQueue {
  const acked = new Set(sessionObservationIds);
  return {
    cwdBuckets: queue.cwdBuckets
      .map((bucket) => {
        if (bucket.key !== key) {
          return bucket;
        }
        return {
          ...bucket,
          sessionObservationChanges: bucket.sessionObservationChanges
            .filter((change) => !acked.has(change.sessionObservation.id)),
        };
      })
      .filter((bucket) => bucket.sessionObservationChanges.length > 0),
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
    queuedCount += bucket.sessionObservationChanges.length;
    if (bucket.sessionObservationChanges.length >= threshold) {
      readyBucketCount += 1;
      readyCount += bucket.sessionObservationChanges.length;
    }
  }
  return { queuedCount, readyBucketCount, readyCount };
}

export function cloneQueue(queue: ObserveQueue): ObserveQueue {
  return {
    cwdBuckets: queue.cwdBuckets.map((bucket) => ({
      key: bucket.key,
      cwd: bucket.cwd,
      sessionObservationChanges: bucket.sessionObservationChanges.map(cloneChange),
    })),
  };
}

export function normalizeCwd(cwd: string): string {
  return normalizedCwd(cwd);
}

function normalizedCwd(cwd: string): string {
  return cwd.trim().replace(/\/+$/, '') || cwd.trim();
}

function enqueueForCwd(queue: ObserveQueue, cwd: string, change: QueuedSessionObservationChange): ObserveQueue {
  const key = normalizeCwd(cwd);
  const cwdBuckets = [...queue.cwdBuckets];
  const index = cwdBuckets.findIndex((bucket) => bucket.key === key);
  if (index < 0) {
    cwdBuckets.push({ key, cwd, sessionObservationChanges: [cloneChange(change)] });
    return { cwdBuckets };
  }
  cwdBuckets[index] = upsertChange(cwdBuckets[index], change);
  return { cwdBuckets };
}

function replaceInBucket(queue: ObserveQueue, key: string, change: QueuedSessionObservationChange): ObserveQueue {
  return {
    cwdBuckets: queue.cwdBuckets.map((bucket) => (bucket.key === key ? upsertChange(bucket, change) : bucket)),
  };
}

function upsertChange(bucket: ObserveCwdBucket, change: QueuedSessionObservationChange): ObserveCwdBucket {
  const index = bucket.sessionObservationChanges
    .findIndex((queued) => queued.sessionObservation.id === change.sessionObservation.id);
  if (index < 0) {
    return {
      ...bucket,
      sessionObservationChanges: [...bucket.sessionObservationChanges, cloneChange(change)],
    };
  }
  const sessionObservationChanges = [...bucket.sessionObservationChanges];
  sessionObservationChanges[index] = cloneChange(change);
  return { ...bucket, sessionObservationChanges };
}

function cloneChange(change: QueuedSessionObservationChange): QueuedSessionObservationChange {
  return {
    type: change.type,
    sessionObservation: {
      ...change.sessionObservation,
      vector: [...change.sessionObservation.vector],
      turnRefs: [...change.sessionObservation.turnRefs],
      globalObservationPaths: [...change.sessionObservation.globalObservationPaths],
    },
  };
}
