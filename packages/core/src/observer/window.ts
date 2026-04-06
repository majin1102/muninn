import type { SessionTurnRow } from '../session/types.js';
import type { Observer } from './observer.js';

export class Window {
  private completed = false;

  constructor(
    private readonly observer: Observer,
    readonly epoch: number,
  ) {}

  async include(turn: SessionTurnRow): Promise<void> {
    await this.observer.include(turn);
  }

  complete(): void {
    if (this.completed) {
      return;
    }
    this.completed = true;
    this.observer.completeWindow();
  }
}
