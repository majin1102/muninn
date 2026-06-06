import {
  type ExtractorCheckpoint,
  type ExtractorRun,
  type QueuedExtractionChange,
  type ThreadRef,
} from '../checkpoint.js';
import type { CheckpointLock } from '../backend.js';
import type { NativeTables } from '../native.js';
import type { MemoryWatermark, Turn, TurnContent } from '../client.js';
import { getExtractorLlmConfig } from '../config.js';
import type { SessionRegistry } from '../turn/registry.js';
import { readTurn } from '../turn/types.js';
import { EpochQueue, EpochSealedError, OpenEpoch, type SealedEpoch } from './epoch.js';
import {
  cloneSessionMemoryThreads,
  getPendingIndex,
  getPendingIndexUpTo,
  isActiveThread,
  loadThreads,
  replaySnapshots,
  threadFromSnapshots,
} from './thread.js';
import type { SessionMemoryThread } from './types.js';
import { buildExtraction, buildTouchedIndex, extractEpoch } from './update.js';
import { resolveDatabaseName } from '../config.js';
import { writeMuninnLog } from '../logging.js';

const BASE_RETRY_DELAY_MS = 100;
const MAX_RETRY_DELAY_MS = 2_000;
const INDEX_RETRY_DELAY_MS = 5_000;

export type ExtractorCheckpointState = {
  committedEpoch?: number;
  nextEpoch: number;
  threads: ThreadRef[];
  runs: ExtractorRun[];
  pendingExtractionChanges: QueuedExtractionChange[];
};

const noopCheckpointLock: CheckpointLock = {
  shared: async (operation) => operation(),
  exclusive: async (operation) => operation(),
};

export class Extractor {
  name: string;
  private readonly activeWindowDays: number;
  private readonly epochTurns: number;
  private readonly epochWindowMs: number;
  private committedEpoch?: number;
  private openEpoch!: OpenEpoch;
  private currentEpoch: SealedEpoch | null = null;
  private publishingEpochs: OpenEpoch[] = [];
  private threads: SessionMemoryThread[] = [];
  private nextIndexRetryAt?: number;
  private pendingExtractionChanges: QueuedExtractionChange[] = [];
  private shuttingDown = false;
  private bootstrapped = false;
  private bootstrapPromise: Promise<void> | null = null;
  private checkpointCommittedEpoch?: number;
  private checkpointNextEpoch = 0;
  private checkpointThreads: ThreadRef[] = [];
  private checkpointRuns: ExtractorRun[] = [];
  // Serializes sealed epoch publish order so epoch N never lands after epoch N+1.
  private publishChain: Promise<void> = Promise.resolve();
  private loopPromise: Promise<void> | null = null;
  private changeVersion = 0;
  private readonly changeWaiters = new Set<() => void>();
  private readonly shutdownController = new AbortController();
  private readonly epochQueue = new EpochQueue();
  private sealTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly client: NativeTables,
    private readonly checkpoint: ExtractorCheckpoint | null = null,
    private readonly checkpointLock: CheckpointLock = noopCheckpointLock,
    private readonly onExtractionCommitted: ((changes: QueuedExtractionChange[]) => void) | null = null,
    database: string = 'main',
  ) {
    this.database = resolveDatabaseName(database);
    const config = getExtractorLlmConfig();
    if (!config) {
      throw new Error('extractor is required.');
    }
    this.name = config.name;
    this.activeWindowDays = config.activeWindowDays;
    this.epochTurns = config.epochTurns;
    this.epochWindowMs = config.epochWindowMs;
    this.pendingExtractionChanges = checkpoint?.pendingExtractionChanges.map(cloneQueuedExtractionChange) ?? [];
    this.checkpointRuns = checkpoint?.runs.filter((run) => run.status === 'running').map(cloneExtractorRun) ?? [];
  }

  private readonly database: string;

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
  ): Promise<void> {
    if (this.shuttingDown) {
      throw new Error('extractor is shutting down');
    }
    await this.ensureBootstrapped();
    if (this.shuttingDown) {
      throw new Error('extractor is shutting down');
    }
    while (true) {
      const openEpoch = this.openEpoch;
      try {
        await openEpoch.accept(turnContent, sessionRegistry);
        this.scheduleOpenEpochSeal(openEpoch);
        return;
      } catch (error) {
        if (error instanceof EpochSealedError && openEpoch !== this.openEpoch) {
          continue;
        }
        throw error;
      }
    }
  }

  async watermark(): Promise<MemoryWatermark> {
    await this.ensureBootstrapped();
    const pendingById = new Map<string, Turn>();
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
    const phase = this.currentEpoch || this.hasPendingExtraction()
      ? 'running'
      : pendingTurnIds.length > 0
        ? 'pending'
        : 'idle';
    return {
      pending: {
        turns: pendingTurnIds,
        extractions: [],
      },
      phases: {
        extractor: phase,
        observer: 'idle',
      },
    };
  }

  async shutdown(): Promise<void> {
    // Fast stop: abort in-flight network work and exit without draining extractor backlog.
    this.shuttingDown = true;
    this.clearSealTimer();
    this.shutdownController.abort(abortError('extractor shutdown'));
    this.epochQueue.close();
    this.notifyChange();
    if (this.loopPromise) {
      await this.loopPromise.catch(() => undefined);
    }
  }

  exportCheckpoint(): ExtractorCheckpointState | null {
    if (!this.bootstrapped) {
      return null;
    }
    return {
      committedEpoch: this.checkpointCommittedEpoch,
      nextEpoch: this.checkpointNextEpoch,
      threads: this.checkpointThreads.map((thread) => ({ ...thread })),
      runs: this.checkpointRuns.map(cloneExtractorRun),
      pendingExtractionChanges: this.pendingExtractionChanges.map(cloneQueuedExtractionChange),
    };
  }

  async flushPending(): Promise<void> {
    // Explicit barrier-drain: only work that has entered the extractor before this call is guaranteed to drain.
    await this.ensureBootstrapped();
    const barrier = this.sealOpenEpoch(this.openEpoch, true);
    if (!barrier) {
      return;
    }
    const sealedEpoch = await barrier.sealed;
    const barrierRequiresObserve = sealedEpoch.turns.length > 0;
    const barrierComplete = () => {
      const observed = !barrierRequiresObserve || (this.committedEpoch ?? -1) >= barrier.epoch;
      return observed && !this.hasPendingExtractionUpTo(barrier.epoch);
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

  async finalize(): Promise<MemoryWatermark> {
    await this.ensureBootstrapped();
    this.sealOpenEpoch(this.openEpoch, true);
    this.notifyChange();
    return this.watermark();
  }

  private async bootstrapInternal(): Promise<void> {
    let pendingTurns: Turn[] = [];
    const restored = await this.restoreCheckpointState();
    if (restored) {
      this.threads = restored.threads;
      this.committedEpoch = restored.committedEpoch;
      pendingTurns = restored.pendingTurns;
    } else {
      const snapshots = await this.client.sessionTable.listSnapshots({
        observer: this.name,
      });
      const turns = (await this.client.turnTable.loadTurnsAfterEpoch({
        observer: this.name,
        committedEpoch: null,
      })).map(readTurn);
      const fallback = await this.restoreThreadsFromCheckpoint({
        baseline: {
          turn: 0,
          session: 0,
          extraction: 0,
          global_observation: 0,
        },
        nextEpoch: 0,
        recentSessions: [],
        threads: [],
        runs: [],
        pendingExtractionChanges: [],
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
      const turnsByEpoch = new Map<number, Turn[]>();
      for (const turn of pendingTurns) {
        if (turn.observingEpoch == null) {
          throw new Error(`pending observable turn ${turn.turnId} is missing extractionEpoch`);
        }
        const turns = turnsByEpoch.get(turn.observingEpoch) ?? [];
        turns.push(turn);
        turnsByEpoch.set(turn.observingEpoch, turns);
      }
      const epochs = [...turnsByEpoch.keys()].sort((left, right) => left - right);
      for (const epoch of epochs) {
        this.epochQueue.publishEpoch({
          epoch,
          turns: turnsByEpoch.get(epoch) ?? [],
        });
      }
      nextEpoch = (epochs[epochs.length - 1] ?? nextEpoch) + 1;
    }

    this.openEpoch = new OpenEpoch(nextEpoch);
    this.clearSealTimer();
    if (this.openEpoch.hasStagedTurns()) {
      this.scheduleOpenEpochSeal(this.openEpoch);
    }
    this.refreshCheckpointSnapshot();
    this.bootstrapped = true;
    this.handoffPendingExtractionChanges();
    this.refreshCheckpointSnapshot();
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

        if (this.shouldRetryExtraction()) {
          await this.retryExtraction();
          retryDelayMs = BASE_RETRY_DELAY_MS;
          continue;
        }

        const sealedEpoch = this.epochQueue.shift();
        if (sealedEpoch) {
          this.currentEpoch = sealedEpoch;
          retryDelayMs = BASE_RETRY_DELAY_MS;
          continue;
        }

        if (this.hasPendingExtraction()) {
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
        const message = String(error);
        console.error(`[muninn:extractor] epoch processing failed: ${message}`);
        await writeMuninnLog(this.database, 'error', 'extractor', 'epoch_processing_failed', { message });
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
      const threads = cloneSessionMemoryThreads(this.threads);
      const result = await extractEpoch({
        client: this.client,
        extractorName: this.name,
        activeWindowDays: this.activeWindowDays,
        threads,
        sealedEpoch: this.currentEpoch!,
        signal: this.shutdownController.signal,
        database: this.database,
      });
      this.threads = result.threads;
      try {
        const extractionChanges = await this.buildCurrentEpochIndex(result.touchedIds);
        this.mergePendingExtractionChanges(extractionChanges);
        this.handoffPendingExtractionChanges();
        if (!this.hasPendingExtraction()) {
          this.nextIndexRetryAt = undefined;
        }
      } catch (error) {
        if (this.shuttingDown || isAbortError(error)) {
          throw error;
        }
        const message = String(error);
        console.error(`[muninn:extractor] extraction index build failed: ${message}`);
        await writeMuninnLog(this.database, 'error', 'extractor', 'index_build_failed', { message });
        this.nextIndexRetryAt = Date.now() + INDEX_RETRY_DELAY_MS;
      }
      this.committedEpoch = this.currentEpoch?.epoch;
      this.currentEpoch = null;
      this.refreshCheckpointSnapshot();
      this.notifyChange();
    });
  }

  private buildCurrentEpochIndex(touchedIds: Set<string>): Promise<QueuedExtractionChange[]> {
    return buildTouchedIndex(
      this.client,
      this.threads,
      touchedIds,
      this.shutdownController.signal,
    );
  }

  private scheduleOpenEpochSeal(openEpoch: OpenEpoch): void {
    if (this.shuttingDown || this.openEpoch !== openEpoch || !openEpoch.hasStagedTurns()) {
      return;
    }
    if (openEpoch.stagedTurnCount() >= this.epochTurns) {
      this.sealOpenEpoch(openEpoch);
      return;
    }
    if (openEpoch.stagedTurnCount() !== 1 || this.sealTimer) {
      return;
    }
    this.sealTimer = setTimeout(() => {
      this.sealTimer = null;
      this.sealOpenEpoch(openEpoch);
    }, this.epochWindowMs);
    (this.sealTimer as { unref?: () => void }).unref?.();
  }

  private clearSealTimer(): void {
    if (!this.sealTimer) {
      return;
    }
    clearTimeout(this.sealTimer);
    this.sealTimer = null;
  }

  private sealOpenEpoch(
    openEpoch: OpenEpoch,
    force = false,
  ): { epoch: number; sealed: Promise<SealedEpoch> } | null {
    if (this.shuttingDown || this.openEpoch !== openEpoch || (!force && !openEpoch.hasStagedTurns())) {
      return null;
    }
    this.clearSealTimer();
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
          const message = String(error);
          console.error(`[muninn:extractor] failed to publish epoch ${openEpoch.epoch}: ${message}`);
          void writeMuninnLog(this.database, 'error', 'extractor', 'publish_epoch_failed', {
            epoch: openEpoch.epoch,
            message,
          });
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

  private hasPendingExtraction(): boolean {
    return this.threads.some((thread) => getPendingIndex(thread) !== null);
  }

  private hasPendingExtractionUpTo(maxEpoch: number): boolean {
    return this.threads.some((thread) => getPendingIndexUpTo(thread, maxEpoch) !== null);
  }

  private shouldRetryExtraction(): boolean {
    return this.hasPendingExtraction()
      && (this.nextIndexRetryAt == null || Date.now() >= this.nextIndexRetryAt);
  }

  private async retryExtraction(): Promise<void> {
    try {
      await this.checkpointLock.shared(async () => {
        const extractionChanges = await buildExtraction(this.client, this.threads, this.shutdownController.signal);
        this.mergePendingExtractionChanges(extractionChanges);
        this.handoffPendingExtractionChanges();
        this.refreshCheckpointSnapshot();
        this.nextIndexRetryAt = undefined;
      });
    } catch (error) {
      if (this.shuttingDown || isAbortError(error)) {
        throw error;
      }
      const message = String(error);
      console.error(`[muninn:extractor] extraction index retry failed: ${message}`);
      await writeMuninnLog(this.database, 'error', 'extractor', 'index_retry_failed', { message });
      this.nextIndexRetryAt = Date.now() + INDEX_RETRY_DELAY_MS;
    } finally {
      if (!this.hasPendingExtraction()) {
        this.nextIndexRetryAt = undefined;
      }
      this.notifyChange();
    }
  }

  private mergePendingExtractionChanges(changes: QueuedExtractionChange[] | undefined): void {
    for (const change of changes ?? []) {
      const index = this.pendingExtractionChanges
        .findIndex((pending) => pending.extraction.id === change.extraction.id);
      if (index < 0) {
        this.pendingExtractionChanges.push(cloneQueuedExtractionChange(change));
      } else {
        this.pendingExtractionChanges[index] = cloneQueuedExtractionChange(change);
      }
    }
  }

  private handoffPendingExtractionChanges(): void {
    if (this.pendingExtractionChanges.length === 0) {
      return;
    }
    const changes = this.pendingExtractionChanges.map(cloneQueuedExtractionChange);
    this.onExtractionCommitted?.(changes);
    this.pendingExtractionChanges = [];
  }

  private exportCheckpointThreads(): ThreadRef[] {
    return this.threads
      .filter((thread) => isActiveThread(thread.updatedAt, this.activeWindowDays))
      .map((thread) => ({
        sessionId: thread.sessionId ?? thread.threadId,
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
    this.checkpointRuns = this.checkpointRuns.filter((run) => run.status === 'running');
  }

  private async restoreCheckpointState(): Promise<{
    threads: SessionMemoryThread[];
    committedEpoch?: number;
    pendingTurns: Turn[];
  } | null> {
    const section = this.checkpoint;
    if (!section) {
      return null;
    }
    const sessionDelta = await this.client.sessionTable.delta({
      observer: this.name,
      baselineVersion: section.baseline.session,
    });
    const turns = (await this.client.turnTable.loadTurnsAfterEpoch({
      observer: this.name,
      committedEpoch: section.committedEpoch ?? null,
    })).map(readTurn);
    const turnById = new Map(turns.map((turn) => [turn.turnId, turn]));
    const restored = await this.restoreThreadsFromCheckpoint(
      section,
      sessionDelta,
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
    section: ExtractorCheckpoint,
    deltaRows: Array<import('./types.js').SessionSnapshot>,
    turnById: Map<string, Turn>,
  ): Promise<{
    threads: SessionMemoryThread[];
    observedTurnIds: Set<string>;
    committedEpoch?: number;
  } | null> {
    const rowsById = new Map<string, Array<import('./types.js').SessionSnapshot>>();
    for (const row of deltaRows) {
      const rows = rowsById.get(row.sessionId) ?? [];
      rows.push(row);
      rowsById.set(row.sessionId, rows);
    }
    const restored: SessionMemoryThread[] = [];
    const observedTurnIds = new Set<string>();
    let committedEpoch = section.committedEpoch;
    const turnCache = new Map(turnById);
    for (const threadRef of section.threads) {
      if (!isActiveThread(threadRef.updatedAt, this.activeWindowDays)) {
        continue;
      }
      const rows = await this.client.sessionTable.threadSnapshots(threadRef.sessionId);
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
      const appendedRows = (rowsById.get(threadRef.sessionId) ?? [])
        .filter((row) => row.snapshotSequence > threadRef.latestSnapshotSequence)
        .sort((left, right) => left.snapshotSequence - right.snapshotSequence);
      for (const row of appendedRows) {
        const newRefs = row.references.filter((reference) => !previousRefs.has(reference));
        if (newRefs.length === 0) {
          return null;
        }
        let rowEpoch: number | undefined;
        for (const reference of newRefs) {
          let turn = turnCache.get(reference);
          if (!turn) {
            turn = await this.client.turnTable.getTurn?.(reference) ?? undefined;
            if (turn) {
              turnCache.set(reference, turn);
            }
          }
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
          return null;
        }
        replaySnapshots(thread, [row], rowEpoch);
        committedEpoch = committedEpoch == null || rowEpoch > committedEpoch
          ? rowEpoch
          : committedEpoch;
        previousRefs = new Set(row.references);
      }
      rowsById.delete(threadRef.sessionId);
      restored.push(thread);
    }
    for (const rows of rowsById.values()) {
      const ordered = [...rows].sort((left, right) => left.snapshotSequence - right.snapshotSequence);
      const first = ordered[0];
      if (!first) {
        continue;
      }
      const fullRows = (await this.client.sessionTable.threadSnapshots(first.sessionId))
        .sort((left, right) => left.snapshotSequence - right.snapshotSequence);
      const firstIndex = fullRows.findIndex((row) => row.snapshotId === first.snapshotId);
      if (firstIndex < 0) {
        return null;
      }
      const prefixRows = fullRows.slice(0, firstIndex + 1);
      if (prefixRows.length === 0 || prefixRows[0]?.snapshotSequence !== 0) {
        return null;
      }
      for (const [index, row] of prefixRows.entries()) {
        if (row.snapshotSequence !== index) {
          return null;
        }
      }
      let previousRefs = new Set<string>();
      let thread: SessionMemoryThread | null = null;
      for (const row of prefixRows) {
        const newRefs = row.references.filter((reference) => !previousRefs.has(reference));
        if (newRefs.length === 0) {
          return null;
        }
        let rowEpoch: number | undefined;
        for (const reference of newRefs) {
          let turn = turnCache.get(reference);
          if (!turn) {
            turn = await this.client.turnTable.getTurn?.(reference) ?? undefined;
            if (turn) {
              turnCache.set(reference, turn);
            }
          }
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
      for (const row of ordered.slice(1)) {
        const newRefs = row.references.filter((reference) => !previousRefs.has(reference));
        if (newRefs.length === 0) {
          return null;
        }
        let rowEpoch: number | undefined;
        for (const reference of newRefs) {
          let turn = turnCache.get(reference);
          if (!turn) {
            turn = await this.client.turnTable.getTurn?.(reference) ?? undefined;
            if (turn) {
              turnCache.set(reference, turn);
            }
          }
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
          return null;
        }
        replaySnapshots(thread, [row], rowEpoch);
        committedEpoch = committedEpoch == null || rowEpoch > committedEpoch
          ? rowEpoch
          : committedEpoch;
        previousRefs = new Set(row.references);
      }
      if (!thread) {
        continue;
      }
      if (!isActiveThread(thread.updatedAt, this.activeWindowDays)) {
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

function cloneExtractorRun(run: ExtractorRun): ExtractorRun {
  return {
    ...run,
    inputTurnIds: [...run.inputTurnIds],
    pending: run.pending ? { ...run.pending } : undefined,
    committed: {
      extractionIds: [...run.committed.extractionIds],
      snapshotIds: [...run.committed.snapshotIds],
    },
    traceRefs: [...run.traceRefs],
    errors: run.errors.map((error) => ({ ...error })),
  };
}

function cloneQueuedExtractionChange(change: QueuedExtractionChange): QueuedExtractionChange {
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

function isObservable(turn: Turn): boolean {
  return Boolean(turn.response?.trim() && turn.summary?.trim());
}

function keepNewestTurn(byId: Map<string, Turn>, turn: Turn): void {
  const existing = byId.get(turn.turnId);
  if (!existing || existing.updatedAt < turn.updatedAt) {
    byId.set(turn.turnId, turn);
  }
}

function pendingObservableTurns(
  turns: Turn[],
  committedEpoch?: number,
): Turn[] {
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
    ));
}

function compareTurns(left: Turn, right: Turn): number {
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
