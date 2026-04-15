import { access, appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type CheckpointContent,
  type CheckpointFile,
  readCheckpointFile,
  resolveCheckpointPath,
  serializeCheckpointFile,
} from './checkpoint.js';
import { resolveMuninnHome, type WatchdogConfig } from './config.js';
import type { CheckpointLock, MuninnBackend } from './backend.js';
import type { NativeTables, TableStats } from './native.js';

type DatasetName = 'turn' | 'observing' | 'semanticIndex';
type WatchdogLevel = 'info' | 'error';
type WatchdogEvent =
  | 'failed'
  | 'index_created'
  | 'compacted'
  | 'cleaned'
  | 'optimized';

type WatchdogLogRecord = {
  ts: string;
  level: WatchdogLevel;
  dataset: DatasetName;
  event: WatchdogEvent;
  version: number | null;
  details: Record<string, unknown>;
};

type DatasetState = {
  lastSeenVersion: number | null;
  lastMaintainedVersion: number | null;
  lastFragmentCount: number | null;
  checkpointFloorVersion: number | null;
  lastCleanedFloorVersion: number | null;
};

const WATCHDOG_LOG_FILE_NAME = 'watchdog.jsonl';
const DATASETS: DatasetName[] = ['turn', 'observing', 'semanticIndex'];
const noopCheckpointLock: CheckpointLock = {
  shared: async (operation) => operation(),
  exclusive: async (operation) => operation(),
};

export class Watchdog {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private inFlight: Promise<void> | null = null;
  private lastCheckpointJson: string | null = null;
  private checkpointStateLoaded = false;
  private readonly state = new Map<DatasetName, DatasetState>(
    DATASETS.map((dataset) => [dataset, {
      lastSeenVersion: null,
      lastMaintainedVersion: null,
      lastFragmentCount: null,
      checkpointFloorVersion: null,
      lastCleanedFloorVersion: null,
    }]),
  );

  constructor(
    private readonly binding: NativeTables,
    private readonly config: WatchdogConfig,
    private readonly backend: Pick<MuninnBackend, 'exportCheckpoint'> = {
      exportCheckpoint: async () => null,
    },
    lastCheckpointJson: string | null = null,
    private readonly checkpointLock: CheckpointLock = noopCheckpointLock,
  ) {
    this.lastCheckpointJson = lastCheckpointJson;
  }

  start(): void {
    this.stopped = false;
    if (this.timer || this.inFlight) {
      return;
    }
    this.schedule();
  }

  async stop(options: { flushCheckpoint?: boolean } = {}): Promise<void> {
    if (this.stopped) {
      await this.inFlight;
      return;
    }
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.inFlight;
    if (options.flushCheckpoint) {
      await this.flushCheckpoint();
    }
  }

  private schedule(): void {
    if (this.stopped || this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runCycle().finally(() => {
        this.schedule();
      });
    }, this.config.intervalMs);
  }

  private async runCycle(): Promise<void> {
    if (this.stopped) {
      return;
    }
    await this.ensureCheckpointStateLoaded();
    if (this.inFlight) {
      await this.inFlight;
      return;
    }
    this.inFlight = (async () => {
      await this.maintainTurns();
      await this.maintainObservings();
      await this.maintainSemanticIndex();
      await this.flushCheckpoint();
    })()
      .finally(() => {
        this.inFlight = null;
      });
    await this.inFlight;
  }

  private async flushCheckpoint(): Promise<void> {
    try {
      await this.ensureCheckpointStateLoaded();
      const exported = await this.backend.exportCheckpoint();
      if (!exported) {
        return;
      }
      const checkpointJson = JSON.stringify(exported);
      if (checkpointJson === this.lastCheckpointJson) {
        try {
          await access(this.checkpointPath());
          await this.cleanupCheckpointFloors();
          return;
        } catch (error) {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
            throw error;
          }
        }
      }
      const checkpoint: CheckpointFile = {
        ...exported,
        writtenAt: new Date().toISOString(),
        writerPid: process.pid,
      };
      await this.writeCheckpointAtomically(serializeCheckpointFile(checkpoint));
      this.lastCheckpointJson = checkpointJson;
      this.updateCheckpointFloors(exported);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[muninn:watchdog] checkpoint flush failed: ${message}`);
      return;
    }
    await this.cleanupCheckpointFloors();
  }

  private checkpointPath(): string {
    return resolveCheckpointPath();
  }

  private async writeCheckpointAtomically(content: string): Promise<void> {
    const targetPath = this.checkpointPath();
    const directory = path.dirname(targetPath);
    const tmpPath = `${targetPath}.tmp`;
    await mkdir(directory, { recursive: true });
    await writeFile(tmpPath, content, 'utf8');
    await rename(tmpPath, targetPath);
  }

  private async maintainTurns(): Promise<void> {
    await this.checkpointLock.shared(() => this.runDatasetMaintenance('turn', async (setVersion) => {
      const stats = await this.binding.sessionTable.stats();
      if (!stats) {
        this.resetState('turn');
        return;
      }

      setVersion(stats.version);
      const unchanged = this.versionUnchanged('turn', stats);
      this.updateSeenState('turn', stats);

      if (unchanged) {
        return;
      }

      if (stats.fragmentCount < this.config.compactMinFragments) {
        return;
      }

      const result = await this.binding.sessionTable.compact();
      const finalStats = await this.binding.sessionTable.stats() ?? stats;
      this.updateMaintainedState('turn', finalStats);
      await this.logInfo('turn', 'compacted', finalStats.version, {
        changed: result.changed,
        fragmentCount: finalStats.fragmentCount,
        rowCount: finalStats.rowCount,
      });
    }));
  }

  private async maintainObservings(): Promise<void> {
    await this.checkpointLock.shared(() => this.runDatasetMaintenance('observing', async (setVersion) => {
      const stats = await this.binding.observingTable.stats();
      if (!stats) {
        this.resetState('observing');
        return;
      }

      setVersion(stats.version);
      const unchanged = this.versionUnchanged('observing', stats);
      this.updateSeenState('observing', stats);

      if (unchanged) {
        return;
      }

      if (stats.fragmentCount < this.config.compactMinFragments) {
        return;
      }

      const result = await this.binding.observingTable.compact();
      const finalStats = await this.binding.observingTable.stats() ?? stats;
      this.updateMaintainedState('observing', finalStats);
      await this.logInfo('observing', 'compacted', finalStats.version, {
        changed: result.changed,
        fragmentCount: finalStats.fragmentCount,
        rowCount: finalStats.rowCount,
      });
    }));
  }

  private async maintainSemanticIndex(): Promise<void> {
    await this.checkpointLock.shared(() => this.runDatasetMaintenance('semanticIndex', async (setVersion) => {
      const ensured = await this.binding.semanticIndexTable.ensureVectorIndex({
        targetPartitionSize: this.config.semanticIndex.targetPartitionSize,
      });
      const stats = await this.binding.semanticIndexTable.stats();
      if (!stats) {
        this.resetState('semanticIndex');
        return;
      }

      setVersion(stats.version);
      const unchanged = this.versionUnchanged('semanticIndex', stats);
      this.updateSeenState('semanticIndex', stats);

      if (!ensured.created && unchanged) {
        return;
      }

      let compactResult: { changed: boolean } | null = null;
      if (stats.fragmentCount >= this.config.compactMinFragments) {
        compactResult = await this.binding.semanticIndexTable.compact();
      }
      const optimizeResult = await this.binding.semanticIndexTable.optimize({
        mergeCount: this.config.semanticIndex.optimizeMergeCount,
      });
      const finalStats = await this.binding.semanticIndexTable.stats() ?? stats;
      this.updateMaintainedState('semanticIndex', finalStats);

      if (ensured.created) {
        await this.logInfo('semanticIndex', 'index_created', finalStats.version, {
          targetPartitionSize: this.config.semanticIndex.targetPartitionSize,
          fragmentCount: finalStats.fragmentCount,
          rowCount: finalStats.rowCount,
        });
      }
      if (compactResult) {
        await this.logInfo('semanticIndex', 'compacted', finalStats.version, {
          changed: compactResult.changed,
          fragmentCount: finalStats.fragmentCount,
          rowCount: finalStats.rowCount,
        });
      }
      await this.logInfo('semanticIndex', 'optimized', finalStats.version, {
        changed: optimizeResult.changed,
        mergeCount: this.config.semanticIndex.optimizeMergeCount,
        fragmentCount: finalStats.fragmentCount,
        rowCount: finalStats.rowCount,
        indexCreated: ensured.created,
      });
    }));
  }

  private async runDatasetMaintenance(
    dataset: DatasetName,
    work: (setVersion: (version: number) => void) => Promise<void>,
  ): Promise<void> {
    let version: number | null = null;
    try {
      await work((nextVersion) => {
        version = nextVersion;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.logError(dataset, 'failed', version, {
        errorMessage: message,
      });
      console.error(`[muninn:watchdog] ${dataset} maintenance failed: ${message}`);
    }
  }

  private versionUnchanged(dataset: DatasetName, stats: TableStats): boolean {
    return this.state.get(dataset)?.lastSeenVersion === stats.version;
  }

  private resetState(dataset: DatasetName): void {
    const current = this.state.get(dataset);
    this.state.set(dataset, {
      lastSeenVersion: null,
      lastMaintainedVersion: null,
      lastFragmentCount: null,
      checkpointFloorVersion: current?.checkpointFloorVersion ?? null,
      lastCleanedFloorVersion: current?.lastCleanedFloorVersion ?? null,
    });
  }

  private updateSeenState(dataset: DatasetName, stats: TableStats): void {
    const current = this.state.get(dataset);
    this.state.set(dataset, {
      lastSeenVersion: stats.version,
      lastMaintainedVersion: current?.lastMaintainedVersion ?? null,
      lastFragmentCount: stats.fragmentCount,
      checkpointFloorVersion: current?.checkpointFloorVersion ?? null,
      lastCleanedFloorVersion: current?.lastCleanedFloorVersion ?? null,
    });
  }

  private updateMaintainedState(dataset: DatasetName, stats: TableStats): void {
    const current = this.state.get(dataset);
    this.state.set(dataset, {
      lastSeenVersion: stats.version,
      lastMaintainedVersion: stats.version,
      lastFragmentCount: stats.fragmentCount,
      checkpointFloorVersion: current?.checkpointFloorVersion ?? null,
      lastCleanedFloorVersion: current?.lastCleanedFloorVersion ?? null,
    });
  }

  private async ensureCheckpointStateLoaded(): Promise<void> {
    if (this.checkpointStateLoaded) {
      return;
    }
    this.checkpointStateLoaded = true;
    const checkpoint = await readCheckpointFile();
    if (!checkpoint) {
      return;
    }
    this.lastCheckpointJson ??= JSON.stringify({
      schemaVersion: checkpoint.schemaVersion,
      observer: checkpoint.observer,
    });
    this.updateCheckpointFloors(checkpoint);
  }

  private updateCheckpointFloors(checkpoint: CheckpointContent | CheckpointFile): void {
    const floors = checkpointFloors(checkpoint);
    for (const dataset of DATASETS) {
      const current = this.state.get(dataset);
      this.state.set(dataset, {
        lastSeenVersion: current?.lastSeenVersion ?? null,
        lastMaintainedVersion: current?.lastMaintainedVersion ?? null,
        lastFragmentCount: current?.lastFragmentCount ?? null,
        checkpointFloorVersion: floors[dataset],
        lastCleanedFloorVersion: current?.lastCleanedFloorVersion ?? null,
      });
    }
  }

  private async cleanupCheckpointFloors(): Promise<void> {
    await Promise.all(DATASETS.map(async (dataset) => {
      const state = this.state.get(dataset);
      const floorVersion = state?.checkpointFloorVersion ?? null;
      if (floorVersion == null || state?.lastCleanedFloorVersion === floorVersion) {
        return;
      }
      try {
        const result = await this.cleanupDataset(dataset, floorVersion);
        const current = this.state.get(dataset);
        this.state.set(dataset, {
          lastSeenVersion: current?.lastSeenVersion ?? null,
          lastMaintainedVersion: current?.lastMaintainedVersion ?? null,
          lastFragmentCount: current?.lastFragmentCount ?? null,
          checkpointFloorVersion: current?.checkpointFloorVersion ?? null,
          lastCleanedFloorVersion: floorVersion,
        });
        if (result.changed) {
          await this.logInfo(dataset, 'cleaned', floorVersion, { floorVersion });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.logError(dataset, 'failed', floorVersion, {
          errorMessage: message,
          phase: 'cleanup',
          floorVersion,
        });
        console.error(`[muninn:watchdog] ${dataset} cleanup failed: ${message}`);
      }
    }));
  }

  private cleanupDataset(dataset: DatasetName, floorVersion: number): Promise<{ changed: boolean }> {
    switch (dataset) {
      case 'turn':
        return this.binding.sessionTable.cleanup?.({ floorVersion }) ?? Promise.resolve({ changed: false });
      case 'observing':
        return this.binding.observingTable.cleanup?.({ floorVersion }) ?? Promise.resolve({ changed: false });
      case 'semanticIndex':
        return this.binding.semanticIndexTable.cleanup?.({ floorVersion }) ?? Promise.resolve({ changed: false });
    }
  }

  private async logInfo(
    dataset: DatasetName,
    event: WatchdogEvent,
    version: number | null,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.appendLog({
      ts: new Date().toISOString(),
      level: 'info',
      dataset,
      event,
      version,
      details,
    });
  }

  private async logError(
    dataset: DatasetName,
    event: WatchdogEvent,
    version: number | null,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.appendLog({
      ts: new Date().toISOString(),
      level: 'error',
      dataset,
      event,
      version,
      details,
    });
  }

  private async appendLog(record: WatchdogLogRecord): Promise<void> {
    const logPath = path.join(resolveMuninnHome(), WATCHDOG_LOG_FILE_NAME);
    try {
      await mkdir(path.dirname(logPath), { recursive: true });
      await appendFile(logPath, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[muninn:watchdog] failed to write ${WATCHDOG_LOG_FILE_NAME}: ${message}`);
    }
  }
}

function checkpointFloors(checkpoint: CheckpointContent | CheckpointFile): Record<DatasetName, number | null> {
  return {
    turn: checkpoint.observer.baseline.turn,
    observing: checkpoint.observer.baseline.observing,
    semanticIndex: checkpoint.observer.baseline.semanticIndex,
  };
}
