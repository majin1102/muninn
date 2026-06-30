import { access, appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type CheckpointContent,
  type CheckpointFile,
  readCheckpointFile,
  resolveCheckpointPath,
  serializeCheckpointFile,
} from './checkpoint.js';
import { resolveDatabaseLogPath, resolveDatabaseName, type WatchdogConfig } from './config.js';
import { writeMuninnLog } from './logging.js';
import type { MuninnBackend } from './backend.js';
import type { NativeTables, TableStats } from './native.js';

type DatasetName = 'turn' | 'session' | 'extraction';
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
  database: string;
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
const DATASETS: DatasetName[] = ['turn', 'session', 'extraction'];

export class Watchdog {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private inFlight: Promise<void> | null = null;
  private checkpointFlush: Promise<void> | null = null;
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
    database: string = 'main',
  ) {
    this.lastCheckpointJson = lastCheckpointJson;
    this.database = resolveDatabaseName(database);
  }

  private readonly database: string;

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
      await Promise.all([
        this.maintainTurns(),
        this.maintainSessions(),
        this.maintainExtraction(),
      ]);
      await this.flushCheckpoint();
    })()
      .finally(() => {
        this.inFlight = null;
      });
    await this.inFlight;
  }

  async flushCheckpoint(): Promise<void> {
    if (this.checkpointFlush) {
      await this.checkpointFlush;
      return;
    }
    this.checkpointFlush = this.flushCheckpointNow()
      .finally(() => {
        this.checkpointFlush = null;
      });
    await this.checkpointFlush;
  }

  private async flushCheckpointNow(): Promise<void> {
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
      await this.updateCheckpointFloors(exported);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[muninn:watchdog] checkpoint flush failed: ${message}`);
      await writeMuninnLog(this.database, 'error', 'watchdog', 'checkpoint_flush_failed', {
        message,
      });
      return;
    }
  }

  private checkpointPath(): string {
    return resolveCheckpointPath(this.database);
  }

  private async writeCheckpointAtomically(content: string): Promise<void> {
    const targetPath = this.checkpointPath();
    const directory = path.dirname(targetPath);
    const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await mkdir(directory, { recursive: true });
    await writeFile(tmpPath, content, 'utf8');
    await rename(tmpPath, targetPath);
  }

  private async maintainTurns(): Promise<void> {
    await this.runDatasetMaintenance('turn', async (setVersion) => {
      const stats = await this.binding.turnTable.stats();
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

      const result = await this.binding.turnTable.compact();
      const finalStats = await this.binding.turnTable.stats() ?? stats;
      this.updateMaintainedState('turn', finalStats);
      await this.logInfo('turn', 'compacted', finalStats.version, {
        changed: result.changed,
        fragmentCount: finalStats.fragmentCount,
        rowCount: finalStats.rowCount,
      });
    });
  }

  private async maintainSessions(): Promise<void> {
    await this.runDatasetMaintenance('session', async (setVersion) => {
      const stats = await this.binding.sessionTable.stats();
      if (!stats) {
        this.resetState('session');
        return;
      }

      setVersion(stats.version);
      const unchanged = this.versionUnchanged('session', stats);
      this.updateSeenState('session', stats);

      if (unchanged) {
        return;
      }

      if (stats.fragmentCount < this.config.compactMinFragments) {
        return;
      }

      const result = await this.binding.sessionTable.compact();
      const finalStats = await this.binding.sessionTable.stats() ?? stats;
      this.updateMaintainedState('session', finalStats);
      await this.logInfo('session', 'compacted', finalStats.version, {
        changed: result.changed,
        fragmentCount: finalStats.fragmentCount,
        rowCount: finalStats.rowCount,
      });
    });
  }

  private async maintainExtraction(): Promise<void> {
    await this.runDatasetMaintenance('extraction', async (setVersion) => {
      const ensured = await this.binding.extractionTable.ensureVectorIndex({
        targetPartitionSize: this.config.extraction.targetPartitionSize,
      });
      const stats = await this.binding.extractionTable.stats();
      if (!stats) {
        this.resetState('extraction');
        return;
      }

      setVersion(stats.version);
      const unchanged = this.versionUnchanged('extraction', stats);
      this.updateSeenState('extraction', stats);

      if (!ensured.created && unchanged) {
        return;
      }

      let compactResult: { changed: boolean } | null = null;
      if (stats.fragmentCount >= this.config.compactMinFragments) {
        compactResult = await this.binding.extractionTable.compact();
      }
      const optimizeResult = await this.binding.extractionTable.optimize({
        mergeCount: this.config.extraction.optimizeMergeCount,
      });
      const finalStats = await this.binding.extractionTable.stats() ?? stats;
      this.updateMaintainedState('extraction', finalStats);

      if (ensured.created) {
        await this.logInfo('extraction', 'index_created', finalStats.version, {
          targetPartitionSize: this.config.extraction.targetPartitionSize,
          fragmentCount: finalStats.fragmentCount,
          rowCount: finalStats.rowCount,
        });
      }
      if (compactResult) {
        await this.logInfo('extraction', 'compacted', finalStats.version, {
          changed: compactResult.changed,
          fragmentCount: finalStats.fragmentCount,
          rowCount: finalStats.rowCount,
        });
      }
      await this.logInfo('extraction', 'optimized', finalStats.version, {
        changed: optimizeResult.changed,
        mergeCount: this.config.extraction.optimizeMergeCount,
        fragmentCount: finalStats.fragmentCount,
        rowCount: finalStats.rowCount,
        indexCreated: ensured.created,
      });
    });
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
      await this.cleanupDatasetFloor(dataset);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.logError(dataset, 'failed', version, {
        errorMessage: message,
      });
      console.error(`[muninn:watchdog] ${dataset} maintenance failed: ${message}`);
      await writeMuninnLog(this.database, 'error', 'watchdog', 'maintenance_failed', {
        dataset,
        message,
      });
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
    const checkpoint = await readCheckpointFile(this.database);
    if (!checkpoint) {
      return;
    }
    this.lastCheckpointJson ??= JSON.stringify({
      schemaVersion: checkpoint.schemaVersion,
      extractor: checkpoint.extractor,
      sessionIndex: checkpoint.sessionIndex,
    });
    await this.updateCheckpointFloors(checkpoint);
  }

  private async updateCheckpointFloors(checkpoint: CheckpointContent | CheckpointFile): Promise<void> {
    const floors = await checkpointFloors(checkpoint, this.binding);
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

  private async cleanupDatasetFloor(dataset: DatasetName): Promise<void> {
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
      await writeMuninnLog(this.database, 'error', 'watchdog', 'cleanup_failed', {
        dataset,
        message,
      });
    }
  }

  private cleanupDataset(dataset: DatasetName, floorVersion: number): Promise<{ changed: boolean }> {
    switch (dataset) {
      case 'turn':
        return this.binding.turnTable.cleanup?.({ floorVersion }) ?? Promise.resolve({ changed: false });
      case 'session':
        return this.binding.sessionTable.cleanup?.({ floorVersion }) ?? Promise.resolve({ changed: false });
      case 'extraction':
        return this.binding.extractionTable.cleanup?.({ floorVersion }) ?? Promise.resolve({ changed: false });
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
      database: this.database,
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
      database: this.database,
      dataset,
      event,
      version,
      details,
    });
  }

  private async appendLog(record: WatchdogLogRecord): Promise<void> {
    const logPath = resolveDatabaseLogPath(this.database, WATCHDOG_LOG_FILE_NAME);
    try {
      await mkdir(path.dirname(logPath), { recursive: true });
      await appendFile(logPath, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[muninn:watchdog] failed to write ${WATCHDOG_LOG_FILE_NAME}: ${message}`);
    }
  }
}

async function checkpointFloors(
  checkpoint: CheckpointContent | CheckpointFile,
  binding: Partial<Pick<NativeTables, 'dreamingProjectTable'>>,
): Promise<Record<DatasetName, number | null>> {
  const dreamingProjects = await binding.dreamingProjectTable?.list() ?? [];
  const dreamingSessionFloor = minNumber(dreamingProjects.map((entry) => entry.sessionSnapshotVersion));
  const sessionFloor = minNumber([
    checkpoint.extractor.baseline.session,
    checkpoint.sessionIndex.baseline.session,
    dreamingSessionFloor,
  ]);

  return {
    turn: checkpoint.extractor.baseline.turn,
    session: sessionFloor,
    extraction: checkpoint.extractor.baseline.extraction,
  };
}

function minNumber(values: Array<number | null | undefined>): number | null {
  const present = values.filter((value): value is number => (
    typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
  ));
  return present.length === 0 ? null : Math.min(...present);
}

export const __testing = { checkpointFloors };
