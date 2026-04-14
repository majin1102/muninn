import {
  type ObserverCheckpoint,
  type ThreadRef,
} from '../checkpoint.js';
import type { CheckpointLock } from '../backend.js';
import type { NativeTables } from '../native.js';
import type { ObserverWatermark, SessionTurn, TurnContent } from '../client.js';
import { getObserverLlmConfig } from '../config.js';
import type { SessionRegistry } from '../session/registry.js';
import { cloneTurn, readSessionTurn } from '../session/types.js';
import { EpochQueue, EpochSealedError, OpenEpoch, type SealedEpoch } from './epoch.js';
import {
  cloneObservingThreads,
  getPendingIndex,
  getPendingIndexUpTo,
  isActiveThread,
  loadThreads,
  replaySnapshots,
  threadFromSnapshots,
} from './thread.js';
import type { ObservingThread } from './types.js';
import { buildSemanticIndex, buildTouchedIndex, observeEpoch } from './update.js';

const BASE_RETRY_DELAY_MS = 100;
const MAX_RETRY_DELAY_MS = 2_000;
const INDEX_RETRY_DELAY_MS = 5_000;

export type ObserverCheckpointState = {
  committedEpoch?: number;
  nextEpoch: number;
  threads: ThreadRef[];
};

const noopCheckpointLock: CheckpointLock = {
  shared: async (operation) => operation(),
  exclusive: async (operation) => operation(),
};

export class Observer {
  name: string;
  private readonly activeWindowDays: number;
  private committedEpoch?: number;
  private openEpoch!: OpenEpoch;
  private currentEpoch: SealedEpoch | null = null;
  private publishingEpochs: OpenEpoch[] = [];
  private threads: ObservingThread[] = [];
  private nextIndexRetryAt?: number;
  private shuttingDown = false;
  private bootstrapped = false;
  private bootstrapPromise: Promise<void> | null = null;
  private checkpointCommittedEpoch?: number;
  private checkpointNextEpoch = 0;
  private checkpointThreads: ThreadRef[] = [];
  // Serializes sealed epoch publish order so epoch N never lands after epoch N+1.
  private publishChain: Promise<void> = Promise.resolve();
  private loopPromise: Promise<void> | null = null;
  private changeVersion = 0;
  private readonly changeWaiters = new Set<() => void>();
  private readonly shutdownController = new AbortController();
  private readonly epochQueue = new EpochQueue();

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
    this.activeWindowDays = config.activeWindowDays;
  }

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

  async accept(
    turnContent: TurnContent,
    sessionRegistry: SessionRegistry,
  ): Promise<SessionTurn> {
    if (this.shuttingDown) {
      throw new Error('observer is shutting down');
    }
    await this.ensureBootstrapped();
    if (this.shuttingDown) {
      throw new Error('observer is shutting down');
    }
    while (true) {
      const openEpoch = this.openEpoch;
      try {
        const turn = await openEpoch.accept(turnContent, sessionRegistry);
        if (isObservable(turn)) {
          this.sealOpenEpoch(openEpoch);
        }
        return turn;
      } catch (error) {
        if (error instanceof EpochSealedError && openEpoch !== this.openEpoch) {
          continue;
        }
        throw error;
      }
    }
  }

  async watermark(): Promise<ObserverWatermark> {
    await this.ensureBootstrapped();
    const pendingById = new Map<string, SessionTurn>();
    for (const turn of this.openEpoch.stagedTurns()) {
      keepNewestTurn(pendingById, turn);
    }
    for (const publishingEpoch of this.publishingEpochs) {
      for (const turn of publishingEpoch.stagedTurns()) {
        keepNewestTurn(pendingById, turn);
      }
    }
    for (const turn of this.epochQueue.pendingTurns()) {
      keepNewestTurn(pendingById, turn);
    }
    for (const turn of this.currentEpoch?.turns ?? []) {
      keepNewestTurn(pendingById, turn);
    }
    const pendingTurnIds = [...pendingById.values()]
      .sort(compareTurns)
      .map((turn) => turn.turnId);
    return {
      resolved: pendingTurnIds.length === 0 && !this.hasPendingSemanticIndex() && !this.currentEpoch,
      pendingTurnIds,
      observingEpoch: this.currentEpoch?.epoch,
      committedEpoch: this.committedEpoch,
    };
  }

  async shutdown(): Promise<void> {
    // Fast stop: abort in-flight network work and exit without draining observer backlog.
    this.shuttingDown = true;
    this.shutdownController.abort(abortError('observer shutdown'));
    this.epochQueue.close();
    this.notifyChange();
    if (this.loopPromise) {
      await this.loopPromise.catch(() => undefined);
    }
  }

  exportCheckpoint(): ObserverCheckpointState | null {
    if (!this.bootstrapped) {
      return null;
    }
    return {
      committedEpoch: this.checkpointCommittedEpoch,
      nextEpoch: this.checkpointNextEpoch,
      threads: this.checkpointThreads.map((thread) => ({ ...thread })),
    };
  }

  async flushPending(): Promise<void> {
    // Explicit barrier-drain: only work that has entered the observer before this call is guaranteed to drain.
    await this.ensureBootstrapped();
    const barrier = this.sealOpenEpoch(this.openEpoch, true);
    if (!barrier) {
      return;
    }
    const sealedEpoch = await barrier.sealed;
    const barrierRequiresObserve = sealedEpoch.turns.length > 0;
    const barrierComplete = () => {
      const observed = !barrierRequiresObserve || (this.committedEpoch ?? -1) >= barrier.epoch;
      return observed && !this.hasPendingSemanticIndexUpTo(barrier.epoch);
    };

    while (true) {
      if (this.shuttingDown) {
        return;
      }
      if (barrierComplete()) {
        return;
      }
      const version = this.changeVersion;
      if (barrierComplete()) {
        return;
      }
      await this.waitForChange(version);
    }
  }

  private async bootstrapInternal(): Promise<void> {
    let pendingTurns: SessionTurn[] = [];
    const restored = await this.restoreCheckpointState();
    if (restored) {
      this.threads = restored.threads;
      this.committedEpoch = restored.committedEpoch;
      pendingTurns = restored.pendingTurns;
    } else {
      const snapshots = await this.client.observingTable.listSnapshots({
        observer: this.name,
      });
      const turns = (await this.client.sessionTable.loadTurnsAfterEpoch({
        observer: this.name,
        committedEpoch: null,
      })).map(readSessionTurn);
      const fallback = await this.restoreThreadsFromCheckpoint({
        baseline: {
          turn: 0,
          observing: 0,
          semanticIndex: 0,
        },
        nextEpoch: 0,
        openTurns: [],
        threads: [],
      }, snapshots, new Map(turns.map((turn) => [turn.turnId, turn])));
      if (fallback) {
        this.threads = fallback.threads;
        this.committedEpoch = fallback.committedEpoch;
        pendingTurns = pendingObservableTurns(
          turns.filter((turn) => !fallback.observedTurnIds.has(turn.turnId)),
          fallback.committedEpoch,
        );
      } else {
        this.committedEpoch = undefined;
        this.threads = loadThreads(
          snapshots,
          this.name,
          this.activeWindowDays,
          0,
        );
        pendingTurns = pendingObservableTurns(turns, undefined);
      }
    }

    let nextEpoch = this.committedEpoch == null ? 0 : this.committedEpoch + 1;
    if (pendingTurns.length > 0) {
      this.epochQueue.publishEpoch({
        epoch: nextEpoch,
        turns: pendingTurns.map(cloneTurn),
      });
      nextEpoch += 1;
    }

    this.openEpoch = new OpenEpoch(nextEpoch);
    this.refreshCheckpointSnapshot();
    this.bootstrapped = true;
    this.start();
    this.notifyChange();
  }

  private start(): void {
    if (!this.loopPromise) {
      this.loopPromise = this.run();
    }
  }

  private async run(): Promise<void> {
    let retryDelayMs = BASE_RETRY_DELAY_MS;
    while (true) {
      try {
        if (this.currentEpoch) {
          await this.observeCurrentEpoch();
          retryDelayMs = BASE_RETRY_DELAY_MS;
          continue;
        }

        if (this.shouldRetrySemanticIndex()) {
          await this.retrySemanticIndex();
          retryDelayMs = BASE_RETRY_DELAY_MS;
          continue;
        }

        const sealedEpoch = this.epochQueue.shift();
        if (sealedEpoch) {
          this.currentEpoch = sealedEpoch;
          retryDelayMs = BASE_RETRY_DELAY_MS;
          continue;
        }

        if (this.hasPendingSemanticIndex()) {
          await this.waitForIndexRetryOrChange();
          retryDelayMs = BASE_RETRY_DELAY_MS;
          continue;
        }

        const nextEpoch = await this.epochQueue.take();
        if (!nextEpoch) {
          break;
        }
        this.currentEpoch = nextEpoch;
      } catch (error) {
        if (this.shuttingDown || isAbortError(error)) {
          break;
        }
        console.error(`[muninn:observer] epoch processing failed: ${String(error)}`);
        await sleep(retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
      }
    }
  }

  private async observeCurrentEpoch(): Promise<void> {
    if (!this.currentEpoch) {
      return;
    }

    await this.checkpointLock.shared(async () => {
      const threads = cloneObservingThreads(this.threads);
      const result = await observeEpoch({
        client: this.client,
        observerName: this.name,
        activeWindowDays: this.activeWindowDays,
        threads,
        sealedEpoch: this.currentEpoch!,
        signal: this.shutdownController.signal,
      });
      this.threads = result.threads;
      try {
        await this.buildCurrentEpochIndex(result.touchedIds);
        if (!this.hasPendingSemanticIndex()) {
          this.nextIndexRetryAt = undefined;
        }
      } catch (error) {
        if (this.shuttingDown || isAbortError(error)) {
          throw error;
        }
        console.error(`[muninn:observer] semantic index build failed: ${String(error)}`);
        this.nextIndexRetryAt = Date.now() + INDEX_RETRY_DELAY_MS;
      }
      this.committedEpoch = this.currentEpoch?.epoch;
      this.currentEpoch = null;
      this.refreshCheckpointSnapshot();
      this.notifyChange();
    });
  }

  private buildCurrentEpochIndex(touchedIds: Set<string>): Promise<void> {
    return buildTouchedIndex(
      this.client,
      this.threads,
      touchedIds,
      this.shutdownController.signal,
    );
  }

  private sealOpenEpoch(
    openEpoch: OpenEpoch,
    force = false,
  ): { epoch: number; sealed: Promise<SealedEpoch> } | null {
    if (this.shuttingDown || this.openEpoch !== openEpoch || (!force && !openEpoch.hasStagedTurns())) {
      return null;
    }
    // Swap to the next epoch synchronously so any later accept() starts in the next generation.
    this.openEpoch = new OpenEpoch(openEpoch.epoch + 1);
    this.publishingEpochs.push(openEpoch);
    let resolveSealed!: (sealedEpoch: SealedEpoch) => void;
    let rejectSealed!: (error: unknown) => void;
    const sealed = new Promise<SealedEpoch>((resolve, reject) => {
      resolveSealed = resolve;
      rejectSealed = reject;
    });
    // Fast-stop shutdown may leave staged turns unpublished; bootstrap replay recovers them from session rows.
    this.publishChain = this.publishChain.then(async () => {
      try {
        if (this.shuttingDown || this.shutdownController.signal.aborted) {
          resolveSealed({ epoch: openEpoch.epoch, turns: [] });
          return;
        }
        const sealedEpoch = await openEpoch.seal();
        resolveSealed(sealedEpoch);
        if (this.shuttingDown || this.shutdownController.signal.aborted) {
          return;
        }
        this.epochQueue.publishEpoch(sealedEpoch);
        this.notifyChange();
      } catch (error) {
        rejectSealed(error);
        console.error(`[muninn:observer] failed to publish epoch ${openEpoch.epoch}: ${String(error)}`);
      } finally {
        const index = this.publishingEpochs.indexOf(openEpoch);
        if (index >= 0) {
          this.publishingEpochs.splice(index, 1);
        }
      }
    });
    return {
      epoch: openEpoch.epoch,
      sealed,
    };
  }

  private hasPendingSemanticIndex(): boolean {
    return this.threads.some((thread) => getPendingIndex(thread) !== null);
  }

  private hasPendingSemanticIndexUpTo(maxEpoch: number): boolean {
    return this.threads.some((thread) => getPendingIndexUpTo(thread, maxEpoch) !== null);
  }

  private shouldRetrySemanticIndex(): boolean {
    return this.hasPendingSemanticIndex()
      && (this.nextIndexRetryAt == null || Date.now() >= this.nextIndexRetryAt);
  }

  private async retrySemanticIndex(): Promise<void> {
    try {
      await this.checkpointLock.shared(async () => {
        await buildSemanticIndex(this.client, this.threads, this.shutdownController.signal);
        this.refreshCheckpointSnapshot();
        this.nextIndexRetryAt = undefined;
      });
    } catch (error) {
      if (this.shuttingDown || isAbortError(error)) {
        throw error;
      }
      console.error(`[muninn:observer] semantic index retry failed: ${String(error)}`);
      this.nextIndexRetryAt = Date.now() + INDEX_RETRY_DELAY_MS;
    } finally {
      if (!this.hasPendingSemanticIndex()) {
        this.nextIndexRetryAt = undefined;
      }
      this.notifyChange();
    }
  }

  private exportCheckpointThreads(): ThreadRef[] {
    return this.threads
      .filter((thread) => isActiveThread(thread.updatedAt, this.activeWindowDays))
      .map((thread) => ({
        observingId: thread.observingId,
        latestSnapshotId: thread.snapshotId ?? '',
        latestSnapshotSequence: thread.snapshots.length - 1,
        indexedSnapshotSequence: thread.indexedSnapshotSequence ?? null,
        updatedAt: thread.updatedAt,
      }))
      .filter((thread) => thread.latestSnapshotId.length > 0);
  }

  private refreshCheckpointSnapshot(): void {
    this.checkpointCommittedEpoch = this.committedEpoch;
    this.checkpointNextEpoch = this.openEpoch?.epoch ?? (this.committedEpoch ?? -1) + 1;
    this.checkpointThreads = this.exportCheckpointThreads();
  }

  private async restoreCheckpointState(): Promise<{
    threads: ObservingThread[];
    committedEpoch?: number;
    pendingTurns: SessionTurn[];
  } | null> {
    const section = this.checkpoint;
    if (!section) {
      return null;
    }
    const observingDelta = await this.client.observingTable.delta({
      observer: this.name,
      baselineVersion: section.baseline.observing,
    });
    const turns = (await this.client.sessionTable.loadTurnsAfterEpoch({
      observer: this.name,
      committedEpoch: section.committedEpoch ?? null,
    })).map(readSessionTurn);
    const turnById = new Map(turns.map((turn) => [turn.turnId, turn]));
    const restored = await this.restoreThreadsFromCheckpoint(
      section,
      observingDelta,
      turnById,
    );
    if (!restored) {
      return null;
    }
    return {
      threads: restored.threads,
      committedEpoch: restored.committedEpoch,
      pendingTurns: pendingObservableTurns(
        turns.filter((turn) => !restored.observedTurnIds.has(turn.turnId)),
        restored.committedEpoch,
      ),
    };
  }

  private async restoreThreadsFromCheckpoint(
    section: ObserverCheckpoint,
    deltaRows: Array<import('./types.js').ObservingSnapshot>,
    turnById: Map<string, SessionTurn>,
  ): Promise<{
    threads: ObservingThread[];
    observedTurnIds: Set<string>;
    committedEpoch?: number;
  } | null> {
    const rowsById = new Map<string, Array<import('./types.js').ObservingSnapshot>>();
    for (const row of deltaRows) {
      const rows = rowsById.get(row.observingId) ?? [];
      rows.push(row);
      rowsById.set(row.observingId, rows);
    }
    const restored: ObservingThread[] = [];
    const observedTurnIds = new Set<string>();
    let committedEpoch = section.committedEpoch;
    for (const threadRef of section.threads) {
      if (!isActiveThread(threadRef.updatedAt, this.activeWindowDays)) {
        continue;
      }
      const rows = await this.client.observingTable.threadSnapshots(threadRef.observingId);
      if (rows.length === 0) {
        return null;
      }
      const baselineRows = rows
        .filter((row) => row.snapshotSequence <= threadRef.latestSnapshotSequence)
        .sort((left, right) => left.snapshotSequence - right.snapshotSequence);
      const latest = baselineRows[baselineRows.length - 1];
      if (!latest) {
        return null;
      }
      if (latest.snapshotId !== threadRef.latestSnapshotId) {
        return null;
      }
      const thread = threadFromSnapshots(
        baselineRows,
        section.committedEpoch ?? 0,
        threadRef.indexedSnapshotSequence ?? null,
      );
      let previousRefs = new Set(latest.references);
      const appendedRows = (rowsById.get(threadRef.observingId) ?? [])
        .filter((row) => row.snapshotSequence > threadRef.latestSnapshotSequence)
        .sort((left, right) => left.snapshotSequence - right.snapshotSequence);
      for (const row of appendedRows) {
        const newRefs = row.references.filter((reference) => !previousRefs.has(reference));
        if (newRefs.length === 0) {
          return null;
        }
        let rowEpoch: number | undefined;
        for (const reference of newRefs) {
          const turn = turnById.get(reference);
          if (turn?.observingEpoch == null) {
            return null;
          }
          observedTurnIds.add(reference);
          rowEpoch = rowEpoch == null || turn.observingEpoch > rowEpoch
            ? turn.observingEpoch
            : rowEpoch;
        }
        if (rowEpoch == null) {
          return null;
        }
        replaySnapshots(thread, [row], rowEpoch);
        committedEpoch = committedEpoch == null || rowEpoch > committedEpoch
          ? rowEpoch
          : committedEpoch;
        previousRefs = new Set(row.references);
      }
      rowsById.delete(threadRef.observingId);
      restored.push(thread);
    }
    for (const rows of rowsById.values()) {
      const ordered = [...rows].sort((left, right) => left.snapshotSequence - right.snapshotSequence);
      let previousRefs = new Set<string>();
      let thread: ObservingThread | null = null;
      for (const row of ordered) {
        const newRefs = row.references.filter((reference) => !previousRefs.has(reference));
        if (newRefs.length === 0) {
          return null;
        }
        let rowEpoch: number | undefined;
        for (const reference of newRefs) {
          const turn = turnById.get(reference);
          if (turn?.observingEpoch == null) {
            return null;
          }
          observedTurnIds.add(reference);
          rowEpoch = rowEpoch == null || turn.observingEpoch > rowEpoch
            ? turn.observingEpoch
            : rowEpoch;
        }
        if (rowEpoch == null) {
          return null;
        }
        if (!thread) {
          thread = threadFromSnapshots([row], rowEpoch);
        } else {
          replaySnapshots(thread, [row], rowEpoch);
        }
        committedEpoch = committedEpoch == null || rowEpoch > committedEpoch
          ? rowEpoch
          : committedEpoch;
        previousRefs = new Set(row.references);
      }
      if (!thread) {
        continue;
      }
      restored.push(thread);
    }
    return {
      threads: restored.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt)),
      observedTurnIds,
      committedEpoch,
    };
  }

  private waitForChange(version: number): Promise<void> {
    if (this.changeVersion !== version || this.shuttingDown) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const waiter = () => {
        this.changeWaiters.delete(waiter);
        resolve();
      };
      this.changeWaiters.add(waiter);
    });
  }

  private async waitForIndexRetryOrChange(): Promise<void> {
    const version = this.changeVersion;
    const retryDelay = Math.max((this.nextIndexRetryAt ?? Date.now()) - Date.now(), 0);
    if (retryDelay === 0) {
      return;
    }
    await Promise.race([
      sleep(retryDelay),
      this.waitForChange(version),
    ]);
  }

  private notifyChange(): void {
    this.changeVersion += 1;
    for (const waiter of this.changeWaiters) {
      waiter();
    }
    this.changeWaiters.clear();
  }
}

function isObservable(turn: SessionTurn): boolean {
  return Boolean(turn.response?.trim() && turn.summary?.trim());
}

function keepNewestTurn(byId: Map<string, SessionTurn>, turn: SessionTurn): void {
  const existing = byId.get(turn.turnId);
  if (!existing || existing.updatedAt < turn.updatedAt) {
    byId.set(turn.turnId, cloneTurn(turn));
  }
}

function pendingObservableTurns(
  turns: SessionTurn[],
  committedEpoch?: number,
): SessionTurn[] {
  const recoveredEpoch = committedEpoch == null ? 0 : committedEpoch + 1;
  return turns
    .filter(isObservable)
    .filter((turn) => (
      turn.observingEpoch == null
      || committedEpoch == null
      || turn.observingEpoch > committedEpoch
    ))
    .sort((left, right) => (
      (left.observingEpoch ?? recoveredEpoch) - (right.observingEpoch ?? recoveredEpoch)
      || left.createdAt.localeCompare(right.createdAt)
      || left.updatedAt.localeCompare(right.updatedAt)
    ))
    .map(cloneTurn);
}

function compareTurns(left: SessionTurn, right: SessionTurn): number {
  return left.createdAt.localeCompare(right.createdAt)
    || left.updatedAt.localeCompare(right.updatedAt)
    || left.turnId.localeCompare(right.turnId);
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
