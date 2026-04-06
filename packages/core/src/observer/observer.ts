import type { CoreBinding } from '../native.js';
import type { ObserverWatermarkRecord } from '../client.js';
import { getEffectiveObserverName } from '../config.js';
import { cloneTurn, fromWireTurn, toWireTurn, type SessionTurnRow } from '../session/types.js';
import { ObserverTask } from './task.js';
import { loadThreads } from './thread.js';
import { flushObserverWindow, restoreIndexBatches, retryIndexBatches } from './update.js';
import { Window } from './window.js';
import type { IndexBatch, ObservingSnapshotRow, ObservingThread } from './types.js';

export class Observer {
  name = getEffectiveObserverName();
  private committedEpoch?: number;
  private observingEpoch?: number;
  private nextEpoch = 0;
  private sessionWriters = 0;
  private buffer: SessionTurnRow[] = [];
  private observingBuffer: SessionTurnRow[] = [];
  private threads: ObservingThread[] = [];
  private indexBatches: IndexBatch[] = [];
  private flushing = false;
  private shutdownRequested = false;
  private bootstrapped = false;
  private bootstrapPromise: Promise<void> | null = null;
  private readonly task = new ObserverTask();

  constructor(private readonly client: CoreBinding) {}

  async ensureBootstrapped(): Promise<void> {
    if (this.bootstrapped) {
      return;
    }
    if (!this.bootstrapPromise) {
      this.bootstrapPromise = this.bootstrapInternal().finally(() => {
        this.bootstrapPromise = null;
      });
    }
    await this.bootstrapPromise;
  }

  async window(): Promise<Window> {
    await this.ensureBootstrapped();
    this.sessionWriters += 1;
    return new Window(this, this.nextEpoch);
  }

  async include(turn: SessionTurnRow): Promise<void> {
    if (this.shutdownRequested || !isObservable(turn)) {
      return;
    }
    enqueueTurn(this.buffer, turn);
  }

  completeWindow(): void {
    if (this.sessionWriters > 0) {
      this.sessionWriters -= 1;
    }
    this.scheduleFlushIfReady();
  }

  async watermark(): Promise<ObserverWatermarkRecord> {
    await this.ensureBootstrapped();
    this.scheduleFlushIfReady();
    const pendingById = new Map<string, SessionTurnRow>();
    for (const turn of this.observingBuffer) {
      keepNewestTurn(pendingById, turn);
    }
    for (const turn of this.buffer) {
      keepNewestTurn(pendingById, turn);
    }
    for (const batch of this.indexBatches) {
      for (const turn of batch.turns) {
        keepNewestTurn(pendingById, turn);
      }
    }
    const pendingTurnIds = [...pendingById.values()]
      .sort(compareTurns)
      .map((turn) => turn.turnId);
    return {
      resolved: pendingTurnIds.length === 0,
      pendingTurnIds,
      observingEpoch: this.observingEpoch,
      committedEpoch: this.committedEpoch,
    };
  }

  async shutdown(): Promise<void> {
    this.shutdownRequested = true;
    await this.task.wait();
  }

  async flushPending(): Promise<void> {
    await this.ensureBootstrapped();
    this.scheduleFlushIfReady();
    await this.task.wait();
  }

  private async bootstrapInternal(): Promise<void> {
    const snapshots = await this.client.observingListSnapshots({
      observer: this.name,
    });
    this.threads = loadThreads(snapshots, this.name);
    this.committedEpoch = snapshots.reduce<number | undefined>((max, snapshot) => {
      const epoch = snapshot.checkpoint.observingEpoch;
      return max == null || epoch > max ? epoch : max;
    }, undefined);
    this.nextEpoch = this.committedEpoch == null ? 0 : this.committedEpoch + 1;

    let pendingTurns = (await this.client.sessionLoadTurnsAfterEpoch({
      observer: this.name,
      committedEpoch: this.committedEpoch ?? null,
    })).map(fromWireTurn);
    const needsRepair = pendingTurns.some((turn) => turn.observingEpoch !== this.nextEpoch);
    if (needsRepair && pendingTurns.length > 0) {
      const repaired = pendingTurns.map((turn) => ({
        ...turn,
        observingEpoch: this.nextEpoch,
      }));
      const persisted = await this.client.sessionUpsert({
        turns: repaired.map(toWireTurn),
      });
      pendingTurns = persisted.map(fromWireTurn);
    }
    this.buffer = pendingTurns.map(cloneTurn);
    this.observingBuffer = [];
    this.indexBatches = restoreIndexBatches(this.threads, pendingTurns);
    this.observingEpoch = undefined;
    this.flushing = false;
    this.bootstrapped = true;
    this.scheduleFlushIfReady();
  }

  private scheduleFlushIfReady(): void {
    if (this.shutdownRequested || this.task.active || this.flushing) {
      return;
    }
    if (this.sessionWriters > 0) {
      return;
    }
    if (this.buffer.length === 0 && this.indexBatches.length === 0) {
      return;
    }
    this.task.run(async () => {
      await this.runFlushLoop();
    });
  }

  private async runFlushLoop(): Promise<void> {
    while (!this.shutdownRequested) {
      const flushed = await this.flushOnce().catch((error) => {
        console.error(`[muninn:observer] flush failed: ${String(error)}`);
        return false;
      });
      if (!flushed) {
        break;
      }
    }
  }

  private async flushOnce(): Promise<boolean> {
    if (this.flushing || this.sessionWriters > 0) {
      return false;
    }

    if (this.buffer.length > 0) {
      this.flushing = true;
      this.observingEpoch = this.nextEpoch;
      const turns = this.buffer.map(cloneTurn);
      this.buffer = [];
      this.observingBuffer = turns.map(cloneTurn);

      try {
        const result = await flushObserverWindow({
          client: this.client,
          observerName: this.name,
          threads: this.threads,
          epoch: this.observingEpoch,
          pendingTurns: turns,
        });
        this.threads = result.threads;
        if (result.failedIndexIds.length > 0) {
          this.indexBatches.push({
            turns: turns.map(cloneTurn),
            observingIds: result.failedIndexIds,
          });
        }
        this.committedEpoch = this.observingEpoch;
        this.observingEpoch = undefined;
        this.observingBuffer = [];
        this.nextEpoch += 1;
        this.flushing = false;
        return this.buffer.length > 0 || this.indexBatches.length > 0;
      } catch (error) {
        this.buffer = [...this.observingBuffer.map(cloneTurn), ...this.buffer];
        this.observingBuffer = [];
        this.observingEpoch = undefined;
        this.flushing = false;
        throw error;
      }
    }

    if (this.indexBatches.length > 0) {
      this.indexBatches = await retryIndexBatches(this.client, this.threads, this.indexBatches);
      return this.buffer.length > 0 || this.indexBatches.length > 0;
    }

    return false;
  }
}

function isObservable(turn: SessionTurnRow): boolean {
  return Boolean(turn.response?.trim() && turn.summary?.trim());
}

function enqueueTurn(buffer: SessionTurnRow[], turn: SessionTurnRow): void {
  const index = buffer.findIndex((entry) => entry.turnId === turn.turnId);
  if (index >= 0) {
    buffer[index] = cloneTurn(turn);
  } else {
    buffer.push(cloneTurn(turn));
  }
  buffer.sort(compareTurns);
}

function keepNewestTurn(byId: Map<string, SessionTurnRow>, turn: SessionTurnRow): void {
  const existing = byId.get(turn.turnId);
  if (!existing || existing.updatedAt < turn.updatedAt) {
    byId.set(turn.turnId, cloneTurn(turn));
  }
}

function compareTurns(left: SessionTurnRow, right: SessionTurnRow): number {
  return left.createdAt.localeCompare(right.createdAt)
    || left.updatedAt.localeCompare(right.updatedAt)
    || left.turnId.localeCompare(right.turnId);
}
