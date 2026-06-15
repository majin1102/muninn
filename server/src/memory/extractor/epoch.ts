import type { Turn, TurnContent } from '../backend.js';
import type { SessionRegistry } from '../turn/registry.js';
import path from 'node:path';

export type SealedEpoch = {
  epoch: number;
  turns: Turn[];
};

export class EpochSealedError extends Error {
  constructor(epoch: number) {
    super(`epoch ${epoch} is sealed`);
    this.name = 'EpochSealedError';
  }
}

export class OpenEpoch {
  private acceptChain: Promise<void> = Promise.resolve();
  private stagedExtractableTurns: Turn[];
  private sealed = false;

  constructor(
    readonly epoch: number,
    stagedExtractableTurns: Turn[] = [],
  ) {
    this.stagedExtractableTurns = [...stagedExtractableTurns];
  }

  accept(
    turnContent: TurnContent,
    sessionRegistry: SessionRegistry,
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

  hasStagedTurns(): boolean {
    return this.stagedExtractableTurns.length > 0;
  }

  stagedTurnCount(): number {
    return this.stagedExtractableTurns.length;
  }

  stagedTurns(): Turn[] {
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

export class EpochQueue {
  private readonly items: SealedEpoch[] = [];
  private readonly waiters: Array<(epoch: SealedEpoch | null) => void> = [];
  private closed = false;

  publishEpoch(sealedEpoch: SealedEpoch): void {
    if (this.closed || sealedEpoch.turns.length === 0) {
      return;
    }
    const normalized = {
      epoch: sealedEpoch.epoch,
      turns: [...sealedEpoch.turns],
    };
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

  pendingTurns(): Turn[] {
    return this.items.flatMap((sealedEpoch) => sealedEpoch.turns);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.(null);
    }
  }
}

function isExtractable(turn: Turn): boolean {
  return Boolean(turn.response?.trim() && turn.summary?.trim());
}
