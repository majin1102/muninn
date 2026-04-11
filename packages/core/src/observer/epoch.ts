import type { SessionTurn, TurnContent } from '../client.js';
import type { SessionRegistry } from '../session/registry.js';
import { cloneTurn } from '../session/types.js';

export type SealedEpoch = {
  epoch: number;
  turns: SessionTurn[];
};

export class EpochSealedError extends Error {
  constructor(epoch: number) {
    super(`epoch ${epoch} is sealed`);
    this.name = 'EpochSealedError';
  }
}

export class OpenEpoch {
  private acceptChain: Promise<void> = Promise.resolve();
  private stagedObservableTurns: SessionTurn[];
  private sealed = false;

  constructor(
    readonly epoch: number,
    stagedObservableTurns: SessionTurn[] = [],
  ) {
    this.stagedObservableTurns = stagedObservableTurns.map(cloneTurn);
  }

  accept(
    turnContent: TurnContent,
    sessionRegistry: SessionRegistry,
  ): Promise<SessionTurn> {
    if (this.sealed) {
      throw new EpochSealedError(this.epoch);
    }

    let resolveTurn: (turn: SessionTurn) => void;
    let rejectTurn: (error: unknown) => void;
    const turnResult = new Promise<SessionTurn>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });

    // Writes entering the same open epoch are serialized so seal() can close over a complete epoch.
    const task = this.acceptChain.then(async () => {
      try {
        const session = await sessionRegistry.load(turnContent.sessionId, turnContent.agent);
        const turn = await session.accept(turnContent, this.epoch);
        if (isObservable(turn)) {
          this.stagedObservableTurns.push(cloneTurn(turn));
        }
        resolveTurn!(turn);
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
    return this.stagedObservableTurns.length > 0;
  }

  stagedTurns(): SessionTurn[] {
    return this.stagedObservableTurns.map(cloneTurn);
  }

  async seal(): Promise<SealedEpoch> {
    this.sealed = true;
    await this.acceptChain;
    return {
      epoch: this.epoch,
      turns: this.stagedObservableTurns.map(cloneTurn),
    };
  }
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
      turns: sealedEpoch.turns.map(cloneTurn),
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

  pendingTurns(): SessionTurn[] {
    return this.items.flatMap((sealedEpoch) => sealedEpoch.turns.map(cloneTurn));
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.(null);
    }
  }
}

function isObservable(turn: SessionTurn): boolean {
  return Boolean(turn.response?.trim() && turn.summary?.trim());
}
