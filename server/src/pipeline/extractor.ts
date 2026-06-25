import {
  type ExtractorCheckpoint,
  type ExtractorRun,
  type ThreadRef,
} from '../checkpoint.js';
import type { CheckpointLock } from '../backend.js';
import type { NativeTables } from '../native.js';
import type { MemoryWatermark } from '../backend.js';
import type { TurnContent } from '@muninn/common';
import type { TurnRow } from '../native.js';
import { getExtractorLlmConfig } from '../config.js';
import type { IngestSessionRegistry } from './ingest.js';
import { readTurnRow } from './ingest.js';
import { EpochQueue, EpochSealedError, OpenEpoch, type SealedEpoch } from './epoch.js';
import {
  cloneSessionThreads,
  getPendingIndex,
  getPendingIndexUpTo,
  isActiveThread,
  loadThreads,
  replaySnapshots,
  threadFromSnapshots,
} from './session.js';
import type { SessionThread } from './session.js';
import { extractEpoch } from './session.js';
import { indexPendingExtractions, indexTouchedExtractions } from './extraction.js';
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
};

const noopCheckpointLock: CheckpointLock = {
  shared: async (operation) => operation(),
  exclusive: async (operation) => operation(),
};

export class Extractor {
  name: string;
  private readonly activeWindowDays: number;
  private readonly minEpochTurns: number;
  private readonly maxEpochTurns: number;
  private readonly maxInputChars: number;
  private readonly previewChars: number;
  private readonly epochWindowMs: number;
  private readonly maxAttempts: number;
  private committedEpoch?: number;
  private openEpoch!: OpenEpoch;
  private currentEpoch: SealedEpoch | null = null;
  private currentEpochAttempts = 0;
  private failedEpoch: SealedEpoch | null = null;
  private publishingEpochs: OpenEpoch[] = [];
  private threads: SessionThread[] = [];
  private nextIndexRetryAt?: number;
  private lastIndexError?: string;
  private lastEpochError?: string;
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
    database: string = 'main',
  ) {
    this.database = resolveDatabaseName(database);
    const config = getExtractorLlmConfig();
    if (!config) {
      throw new Error('extractor is required.');
    }
    this.name = config.name;
    this.activeWindowDays = config.activeWindowDays;
    this.minEpochTurns = config.minEpochTurns;
    this.maxEpochTurns = config.maxEpochTurns;
    this.maxInputChars = config.maxInputChars;
    this.previewChars = config.previewChars;
    this.epochWindowMs = config.epochWindowMs;
    this.maxAttempts = config.maxAttempts;
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
    sessionRegistry: IngestSessionRegistry,
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

  async acceptBatch(
    turnContents: TurnContent[],
    sessionRegistry: IngestSessionRegistry,
  ): Promise<number> {
    if (this.shuttingDown) {
      throw new Error('extractor is shutting down');
    }
    if (turnContents.length === 0) {
      return 0;
    }
    await this.ensureBootstrapped();
    if (this.shuttingDown) {
      throw new Error('extractor is shutting down');
    }
    while (true) {
      const openEpoch = this.openEpoch;
      try {
        const acceptedTurns = await openEpoch.acceptBatch(turnContents, sessionRegistry);
        this.scheduleOpenEpochSeal(openEpoch);
        return acceptedTurns.length;
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
    const pendingById = new Map<string, TurnRow>();
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
    for (const turn of this.failedEpoch?.turns ?? []) {
      keepNewestTurn(pendingById, turn);
    }
    const pendingTurnIds = [...pendingById.values()]
      .sort(compareTurns)
      .map((turn) => turn.turnId);
    const hasAnyUnindexedSnapshots = this.hasAnyUnindexedSnapshots();
    const phase = this.lastEpochError && this.failedEpoch
      ? 'error'
      : this.lastIndexError && hasAnyUnindexedSnapshots
      ? 'error'
      : this.currentEpoch || hasAnyUnindexedSnapshots
        ? 'running'
      : pendingTurnIds.length > 0
        ? 'pending'
        : 'idle';
    const watermark: MemoryWatermark = {
      pending: {
        turns: pendingTurnIds,
      },
      phases: {
        extractor: phase,
      },
    };
    if (this.lastEpochError && this.failedEpoch) {
      watermark.error = {
        phase: 'extractor',
        message: this.lastEpochError,
      };
    } else if (this.lastIndexError && hasAnyUnindexedSnapshots) {
      watermark.error = {
        phase: 'extractor',
        message: this.lastIndexError,
      };
    }
    return watermark;
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
    };
  }

  async flushPending(): Promise<void> {
    // Explicit barrier-drain: only work that has entered the extractor before this call is guaranteed to drain.
    await this.ensureBootstrapped();
    this.throwIfFailedEpoch();
    const barrier = this.sealOpenEpoch(this.openEpoch, true);
    if (!barrier) {
      return;
    }
    const sealedEpoch = await barrier.sealed;
    const barrierRequiresExtract = sealedEpoch.turns.length > 0;
    const barrierComplete = () => {
      const extracted = !barrierRequiresExtract || (this.committedEpoch ?? -1) >= barrier.epoch;
      return extracted && !this.hasUnindexedSnapshotsAtOrBefore(barrier.epoch);
    };

    while (true) {
      if (this.shuttingDown) {
        return;
      }
      this.throwIfFailedEpoch();
      if (barrierComplete()) {
        return;
      }
      const version = this.changeVersion;
      this.throwIfFailedEpoch();
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
    let pendingTurns: TurnRow[] = [];
    const restored = await this.restore();
    if (restored) {
      this.threads = restored.threads;
      this.committedEpoch = restored.committedEpoch;
      pendingTurns = restored.pendingTurns;
    } else {
      const snapshots = await this.client.sessionTable.listSnapshots({
        extractor: this.name,
      });
      const turns = (await this.client.turnTable.loadTurnsAfterEpoch({
        extractor: this.name,
        committedEpoch: null,
      })).map(readTurnRow);
      const fallback = await this.replayCheckpoint({
        baseline: {
          turn: 0,
          session: 0,
          extraction: 0,
        },
        nextEpoch: 0,
        recentSessions: [],
        threads: [],
        runs: [],
      }, snapshots, new Map(turns.map((turn) => [turn.turnId, turn])));
      if (fallback) {
        this.threads = fallback.threads;
        this.committedEpoch = fallback.committedEpoch;
        pendingTurns = pendingExtractableTurns(
          turns.filter((turn) => !fallback.indexedTurnIds.has(turn.turnId)),
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
        pendingTurns = pendingExtractableTurns(turns, undefined);
      }
    }

    let nextEpoch = this.committedEpoch == null ? 0 : this.committedEpoch + 1;
    if (pendingTurns.length > 0) {
      const turnsByEpoch = new Map<number, TurnRow[]>();
      for (const turn of pendingTurns) {
        if (turn.extractionEpoch == null) {
          throw new Error(`pending extractable turn ${turn.turnId} is missing extractionEpoch`);
        }
        const turns = turnsByEpoch.get(turn.extractionEpoch) ?? [];
        turns.push(turn);
        turnsByEpoch.set(turn.extractionEpoch, turns);
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
        if (this.shuttingDown) {
          break;
        }

        if (this.currentEpoch) {
          await this.extractCurrentEpoch();
          retryDelayMs = BASE_RETRY_DELAY_MS;
          continue;
        }

        if (this.shouldRetrySnapshotIndexing()) {
          await this.retrySnapshotIndexing();
          retryDelayMs = BASE_RETRY_DELAY_MS;
          continue;
        }

        if (this.failedEpoch) {
          const version = this.changeVersion;
          if (this.failedEpoch) {
            await this.waitForChange(version);
          }
          retryDelayMs = BASE_RETRY_DELAY_MS;
          continue;
        }

        const sealedEpoch = this.epochQueue.shift();
        if (sealedEpoch) {
          this.currentEpoch = sealedEpoch;
          retryDelayMs = BASE_RETRY_DELAY_MS;
          continue;
        }

        if (this.hasAnyUnindexedSnapshots()) {
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
        const failedEpoch = this.currentEpoch;
        const attempt = failedEpoch ? this.currentEpochAttempts + 1 : undefined;
        console.error(`[muninn:extractor] epoch processing failed: ${message}`);
        await writeMuninnLog(this.database, 'error', 'extractor', 'epoch_processing_failed', {
          message,
          ...(failedEpoch ? {
            epoch: failedEpoch.epoch,
            attempt,
            maxAttempts: this.maxAttempts,
          } : {}),
        });
        if (failedEpoch && attempt != null) {
          this.currentEpochAttempts = attempt;
          if (attempt >= this.maxAttempts) {
            this.failedEpoch = failedEpoch;
            this.currentEpoch = null;
            this.currentEpochAttempts = 0;
            this.lastEpochError = message;
            await writeMuninnLog(this.database, 'error', 'extractor', 'epoch_processing_abandoned', {
              message,
              maxAttempts: this.maxAttempts,
              turns: this.failedEpoch.turns.map((turn) => turn.turnId),
            });
            this.refreshCheckpointSnapshot();
            this.notifyChange();
            continue;
          }
        }
        await sleep(retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
      }
    }
  }

  private async extractCurrentEpoch(): Promise<void> {
    if (!this.currentEpoch) {
      return;
    }

    await this.checkpointLock.shared(async () => {
      const threads = cloneSessionThreads(this.threads);
      const result = await extractEpoch({
        client: this.client,
        extractorName: this.name,
        activeWindowDays: this.activeWindowDays,
        threads,
        sealedEpoch: this.currentEpoch!,
        maxEpochTurns: this.maxEpochTurns,
        maxInputChars: this.maxInputChars,
        previewChars: this.previewChars,
        signal: this.shutdownController.signal,
        database: this.database,
      });
      this.threads = result.threads;
      this.currentEpochAttempts = 0;
      this.lastEpochError = undefined;
      try {
        await this.indexCurrentEpochSnapshots(result.touchedIds);
        this.lastIndexError = undefined;
        if (!this.hasAnyUnindexedSnapshots()) {
          this.nextIndexRetryAt = undefined;
        }
      } catch (error) {
        if (this.shuttingDown || isAbortError(error)) {
          throw error;
        }
        const message = String(error);
        this.lastIndexError = message;
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

  private throwIfFailedEpoch(): void {
    if (!this.failedEpoch || !this.lastEpochError) {
      return;
    }
    throw new Error(
      `extractor epoch ${this.failedEpoch.epoch} failed after ${this.maxAttempts} attempts: ${this.lastEpochError}`,
    );
  }

  private indexCurrentEpochSnapshots(touchedIds: Set<string>): Promise<void> {
    return indexTouchedExtractions(
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
    if (openEpoch.stagedTurnCount() >= this.minEpochTurns) {
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

  private hasAnyUnindexedSnapshots(): boolean {
    return this.threads.some((thread) => getPendingIndex(thread) !== null);
  }

  private hasUnindexedSnapshotsAtOrBefore(maxEpoch: number): boolean {
    return this.threads.some((thread) => getPendingIndexUpTo(thread, maxEpoch) !== null);
  }

  private shouldRetrySnapshotIndexing(): boolean {
    return this.hasAnyUnindexedSnapshots()
      && (this.nextIndexRetryAt == null || Date.now() >= this.nextIndexRetryAt);
  }

  private async retrySnapshotIndexing(): Promise<void> {
    try {
      await this.checkpointLock.shared(async () => {
        await indexPendingExtractions(this.client, this.threads, this.shutdownController.signal);
        this.lastIndexError = undefined;
        this.refreshCheckpointSnapshot();
        this.nextIndexRetryAt = undefined;
      });
    } catch (error) {
      if (this.shuttingDown || isAbortError(error)) {
        throw error;
      }
      const message = String(error);
      this.lastIndexError = message;
      console.error(`[muninn:extractor] extraction index retry failed: ${message}`);
      await writeMuninnLog(this.database, 'error', 'extractor', 'index_retry_failed', { message });
      this.nextIndexRetryAt = Date.now() + INDEX_RETRY_DELAY_MS;
    } finally {
      if (!this.hasAnyUnindexedSnapshots()) {
        this.nextIndexRetryAt = undefined;
        this.lastIndexError = undefined;
      }
      this.notifyChange();
    }
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

  private async restore(): Promise<{
    threads: SessionThread[];
    committedEpoch?: number;
    pendingTurns: TurnRow[];
  } | null> {
    const section = this.checkpoint;
    if (!section) {
      return null;
    }
    const sessionDelta = await this.client.sessionTable.delta({
      extractor: this.name,
      baselineVersion: section.baseline.session,
    });
    const turns = (await this.client.turnTable.loadTurnsAfterEpoch({
      extractor: this.name,
      committedEpoch: section.committedEpoch ?? null,
    })).map(readTurnRow);
    const turnById = new Map(turns.map((turn) => [turn.turnId, turn]));
    const restored = await this.replayCheckpoint(
      section,
      sessionDelta.rows,
      turnById,
    );
    if (!restored) {
      return null;
    }
    return {
      threads: restored.threads,
      committedEpoch: restored.committedEpoch,
      pendingTurns: pendingExtractableTurns(
        turns.filter((turn) => !restored.indexedTurnIds.has(turn.turnId)),
        restored.committedEpoch,
      ),
    };
  }

  private async replayCheckpoint(
    section: ExtractorCheckpoint,
    deltaRows: Array<import('./session.js').SessionSnapshot>,
    turnById: Map<string, TurnRow>,
  ): Promise<{
    threads: SessionThread[];
    indexedTurnIds: Set<string>;
    committedEpoch?: number;
  } | null> {
    const rowsById = new Map<string, Array<import('./session.js').SessionSnapshot>>();
    for (const row of deltaRows) {
      const rows = rowsById.get(row.sessionId) ?? [];
      rows.push(row);
      rowsById.set(row.sessionId, rows);
    }
    const restored: SessionThread[] = [];
    const indexedTurnIds = new Set<string>();
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
          if (turn?.extractionEpoch == null) {
            return null;
          }
          indexedTurnIds.add(reference);
          rowEpoch = rowEpoch == null || turn.extractionEpoch > rowEpoch
            ? turn.extractionEpoch
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
      let thread: SessionThread | null = null;
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
          if (turn?.extractionEpoch == null) {
            return null;
          }
          indexedTurnIds.add(reference);
          rowEpoch = rowEpoch == null || turn.extractionEpoch > rowEpoch
            ? turn.extractionEpoch
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
          if (turn?.extractionEpoch == null) {
            return null;
          }
          indexedTurnIds.add(reference);
          rowEpoch = rowEpoch == null || turn.extractionEpoch > rowEpoch
            ? turn.extractionEpoch
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
      indexedTurnIds,
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

function isExtractable(turn: TurnRow): boolean {
  return Boolean(turn.response?.trim());
}

function keepNewestTurn(byId: Map<string, TurnRow>, turn: TurnRow): void {
  const existing = byId.get(turn.turnId);
  if (!existing || existing.updatedAt < turn.updatedAt) {
    byId.set(turn.turnId, turn);
  }
}

function pendingExtractableTurns(
  turns: TurnRow[],
  committedEpoch?: number,
): TurnRow[] {
  const recoveredEpoch = committedEpoch == null ? 0 : committedEpoch + 1;
  return turns
    .filter(isExtractable)
    .filter((turn) => (
      turn.extractionEpoch == null
      || committedEpoch == null
      || turn.extractionEpoch > committedEpoch
    ))
    .sort((left, right) => (
      (left.extractionEpoch ?? recoveredEpoch) - (right.extractionEpoch ?? recoveredEpoch)
      || left.createdAt.localeCompare(right.createdAt)
      || left.updatedAt.localeCompare(right.updatedAt)
    ));
}

function compareTurns(left: TurnRow, right: TurnRow): number {
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
