import type { TurnContent } from '@muninn/common';
import type { TurnRow } from '../native.js';
import type { IngestSessionRegistry } from './ingest.js';
import path from 'node:path';

export type SealedEpoch = {
  epoch: number;
  commitEpoch?: number | null;
  turns: TurnRow[];
};

export class EpochSealedError extends Error {
  constructor(epoch: number) {
    super(`epoch ${epoch} is sealed`);
    this.name = 'EpochSealedError';
  }
}

export class OpenEpoch {
  private acceptChain: Promise<void> = Promise.resolve();
  private stagedExtractableTurns: TurnRow[];
  private sealed = false;

  constructor(
    readonly epoch: number,
    stagedExtractableTurns: TurnRow[] = [],
  ) {
    this.stagedExtractableTurns = [...stagedExtractableTurns];
  }

  accept(
    turnContent: TurnContent,
    sessionRegistry: IngestSessionRegistry,
  ): Promise<void> {
    if (this.sealed) {
      throw new EpochSealedError(this.epoch);
    }

    let resolveTurn: () => void;
    let rejectTurn: (error: unknown) => void;
    const turnResult = new Promise<void>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });

    // Writes entering the same open epoch are serialized so seal() can close over a complete epoch.
    const task = this.acceptChain.then(async () => {
      try {
        validateLoadableTurn(turnContent);
        const session = await sessionRegistry.load(
          turnContent.sessionId,
          turnContent.agent,
          turnOwnership(turnContent),
        );
        const accepted = await session.accept(turnContent, this.epoch);
        if (accepted.turn && !accepted.deduped && isExtractable(accepted.turn)) {
          this.stagedExtractableTurns.push(accepted.turn);
        }
        resolveTurn!();
      } catch (error) {
        rejectTurn!(error);
      }
    });

    this.acceptChain = task.then(
      () => undefined,
      () => undefined,
    );

    return turnResult;
  }

  acceptBatch(
    turnContents: TurnContent[],
    sessionRegistry: IngestSessionRegistry,
  ): Promise<TurnRow[]> {
    if (this.sealed) {
      throw new EpochSealedError(this.epoch);
    }
    if (turnContents.length === 0) {
      return Promise.resolve([]);
    }

    let resolveTurns: (turns: TurnRow[]) => void;
    let rejectTurns: (error: unknown) => void;
    const turnsResult = new Promise<TurnRow[]>((resolve, reject) => {
      resolveTurns = resolve;
      rejectTurns = reject;
    });

    // Writes entering the same open epoch are serialized so seal() can close over a complete epoch.
    const task = this.acceptChain.then(async () => {
      try {
        const acceptedTurns: TurnRow[] = [];
        for (const group of groupBySession(turnContents)) {
          const first = group[0];
          if (!first) {
            continue;
          }
          validateLoadableTurn(first);
          const session = await sessionRegistry.load(
            first.sessionId,
            first.agent,
            turnOwnership(first),
          );
          const accepted = await session.acceptBatch(group, this.epoch);
          for (const acceptedTurn of accepted) {
            if (acceptedTurn.turn && !acceptedTurn.deduped) {
              acceptedTurns.push(acceptedTurn.turn);
              if (isExtractable(acceptedTurn.turn)) {
                this.stagedExtractableTurns.push(acceptedTurn.turn);
              }
            }
          }
        }
        resolveTurns!(acceptedTurns);
      } catch (error) {
        rejectTurns!(error);
      }
    });

    this.acceptChain = task.then(
      () => undefined,
      () => undefined,
    );

    return turnsResult;
  }

  hasStagedTurns(): boolean {
    return this.stagedExtractableTurns.length > 0;
  }

  stagedTurnCount(): number {
    return this.stagedExtractableTurns.length;
  }

  stagedTurns(): TurnRow[] {
    return [...this.stagedExtractableTurns];
  }

  async seal(): Promise<SealedEpoch> {
    this.sealed = true;
    await this.acceptChain;
    return {
      epoch: this.epoch,
      turns: [...this.stagedExtractableTurns],
    };
  }
}

function turnOwnership(turn: TurnContent): { project: string; cwd: string } {
  const cwd = turn.cwd?.trim() || process.cwd();
  return {
    project: turn.project?.trim() || path.basename(cwd) || 'default',
    cwd,
  };
}

function validateLoadableTurn(turn: TurnContent): void {
  if (!hasText(turn.sessionId)) {
    throw new Error('turn must include sessionId');
  }
  if (!hasText(turn.agent)) {
    throw new Error('turn must include agent');
  }
}

function hasText(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function groupBySession(turns: TurnContent[]): TurnContent[][] {
  const groups = new Map<string, TurnContent[]>();
  const order: string[] = [];
  for (const turn of turns) {
    const ownership = turnOwnership(turn);
    const key = `${turn.sessionId}\0${turn.agent}\0${ownership.project}\0${ownership.cwd}`;
    const existing = groups.get(key);
    if (existing) {
      existing.push(turn);
      continue;
    }
    groups.set(key, [turn]);
    order.push(key);
  }
  return order.map((key) => groups.get(key)!);
}

export class EpochQueue {
  private readonly items: SealedEpoch[] = [];
  private readonly waiters: Array<(epoch: SealedEpoch | null) => void> = [];
  private closed = false;

  publishEpoch(sealedEpoch: SealedEpoch): void {
    if (this.closed || sealedEpoch.turns.length === 0) {
      return;
    }
    const normalized: SealedEpoch = {
      epoch: sealedEpoch.epoch,
      turns: [...sealedEpoch.turns],
    };
    if ('commitEpoch' in sealedEpoch) {
      normalized.commitEpoch = sealedEpoch.commitEpoch;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(normalized);
      return;
    }
    this.items.push(normalized);
  }

  async take(): Promise<SealedEpoch | null> {
    if (this.items.length > 0) {
      return this.items.shift() ?? null;
    }
    if (this.closed) {
      return null;
    }
    return new Promise<SealedEpoch | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  shift(): SealedEpoch | null {
    return this.items.shift() ?? null;
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  pendingTurns(): TurnRow[] {
    return this.items.flatMap((sealedEpoch) => sealedEpoch.turns);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.(null);
    }
  }
}

function isExtractable(turn: TurnRow): boolean {
  return Boolean(turn.response?.trim());
}
