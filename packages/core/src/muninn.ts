import type { CheckpointContributor } from './checkpoint.js';
import type { NativeTables } from './native.js';
import type { ObserverWatermark, RecallHit, SessionTurn, TurnContent } from './client.js';
import { Memories } from './memories/memories.js';
import { Observer } from './observer/observer.js';
import { SessionRegistry } from './session/registry.js';
import { toSessionTurn } from './session/types.js';

export class Muninn {
  readonly memories: Memories;
  private observer: Observer | null = null;
  private sessionRegistry: SessionRegistry | null = null;

  constructor(private readonly client: NativeTables) {
    this.memories = new Memories(client);
  }

  async accept(turnContent: TurnContent): Promise<SessionTurn> {
    const observer = await this.ensureObserver();
    const registry = this.ensureSessionRegistry(observer.name);
    return toSessionTurn(await observer.accept(turnContent, registry));
  }

  async observerWatermark(): Promise<ObserverWatermark> {
    return (await this.ensureObserver()).watermark();
  }

  async recallMemories(query: string, limit?: number): Promise<RecallHit[]> {
    return this.memories.recall(query, limit);
  }

  getCheckpointContributors(): CheckpointContributor[] {
    return [() => this.observer?.exportCheckpointFragment() ?? null];
  }

  async shutdown(): Promise<void> {
    if (this.observer) {
      // Fast stop only: use flushPending() beforehand when the caller needs a barrier-drain.
      await this.observer.shutdown();
    }
    this.observer = null;
    this.sessionRegistry = null;
  }

  private async ensureObserver(): Promise<Observer> {
    if (!this.observer) {
      this.observer = new Observer(this.client);
    }
    await this.observer.ensureBootstrapped();
    return this.observer;
  }

  private ensureSessionRegistry(observerName: string): SessionRegistry {
    if (!this.sessionRegistry || this.sessionRegistry.observerName !== observerName) {
      this.sessionRegistry = new SessionRegistry(
        this.client,
        observerName,
        (sessionId, agent) => this.observer?.checkpointOpenTurnId(sessionId, agent),
      );
    }
    return this.sessionRegistry;
  }
}
