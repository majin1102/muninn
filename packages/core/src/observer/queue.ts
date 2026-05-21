import type { QueuedExtractionChange } from '../checkpoint.js';

export type ObserveQueue = {
  anchors: ObserveAnchorBucket[];
};

export type ObserveAnchorBucket = {
  key: string;
  anchor: string;
  extractionChanges: QueuedExtractionChange[];
};

export type ObserveBatch = {
  key: string;
  anchor: string;
  extractionChanges: QueuedExtractionChange[];
};

export function enqueueChanges(queue: ObserveQueue, changes: QueuedExtractionChange[]): ObserveQueue {
  let next = cloneQueue(queue);
  for (const change of changes) {
    for (const bucket of next.anchors) {
      if (bucket.extractionChanges.some((queued) => queued.extraction.id === change.extraction.id)) {
        next = replaceInBucket(next, bucket.key, change);
      }
    }
    for (const anchor of entityAnchors(change.extraction.anchors)) {
      next = enqueueForAnchor(next, anchor, change);
    }
  }
  return next;
}

export function readyBucket(
  queue: ObserveQueue,
  options: { threshold: number; batchSize: number; finalize: boolean },
): ObserveBatch | null {
  for (const bucket of queue.anchors) {
    const ready = options.finalize
      ? bucket.extractionChanges.length > 0
      : bucket.extractionChanges.length >= options.threshold;
    if (!ready) {
      continue;
    }
    return {
      key: bucket.key,
      anchor: bucket.anchor,
      extractionChanges: bucket.extractionChanges.slice(0, options.batchSize),
    };
  }
  return null;
}

export function ackBucket(queue: ObserveQueue, key: string, extractionIds: string[]): ObserveQueue {
  const acked = new Set(extractionIds);
  return {
    anchors: queue.anchors
      .map((bucket) => {
        if (bucket.key !== key) {
          return bucket;
        }
        return {
          ...bucket,
          extractionChanges: bucket.extractionChanges.filter((change) => !acked.has(change.extraction.id)),
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
  for (const bucket of queue.anchors) {
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
    anchors: queue.anchors.map((bucket) => ({
      key: bucket.key,
      anchor: bucket.anchor,
      extractionChanges: bucket.extractionChanges.map(cloneChange),
    })),
  };
}

export function normalizeAnchor(anchor: string): string {
  return anchor.trim().toLowerCase().replace(/\s+/g, ' ');
}

function enqueueForAnchor(queue: ObserveQueue, anchor: string, change: QueuedExtractionChange): ObserveQueue {
  const key = normalizeAnchor(anchor);
  const anchors = [...queue.anchors];
  const index = anchors.findIndex((bucket) => bucket.key === key);
  if (index < 0) {
    anchors.push({ key, anchor, extractionChanges: [cloneChange(change)] });
    return { anchors };
  }
  anchors[index] = upsertChange(anchors[index], change);
  return { anchors };
}

function replaceInBucket(queue: ObserveQueue, key: string, change: QueuedExtractionChange): ObserveQueue {
  return {
    anchors: queue.anchors.map((bucket) => (bucket.key === key ? upsertChange(bucket, change) : bucket)),
  };
}

function upsertChange(bucket: ObserveAnchorBucket, change: QueuedExtractionChange): ObserveAnchorBucket {
  const index = bucket.extractionChanges.findIndex((queued) => queued.extraction.id === change.extraction.id);
  if (index < 0) {
    return { ...bucket, extractionChanges: [...bucket.extractionChanges, cloneChange(change)] };
  }
  const extractionChanges = [...bucket.extractionChanges];
  extractionChanges[index] = cloneChange(change);
  return { ...bucket, extractionChanges };
}

function entityAnchors(anchors: string[]): string[] {
  return anchors
    .map((anchor) => anchor.match(/^Entity:\s*(.+?)\s*$/i)?.[1]?.trim() ?? '')
    .filter(Boolean);
}

function cloneChange(change: QueuedExtractionChange): QueuedExtractionChange {
  return {
    type: change.type,
    extraction: {
      ...change.extraction,
      anchors: [...change.extraction.anchors],
      vector: [...change.extraction.vector],
      turnRefs: [...change.extraction.turnRefs],
      observationPaths: [...change.extraction.observationPaths],
      observedRootAnchors: [...change.extraction.observedRootAnchors],
    },
  };
}
