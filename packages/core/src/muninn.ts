import type { NativeTables } from './native.js';
import type { ObserverWatermark, RecallHit, SessionTurn, TurnContent } from './client.js';
import { Memories } from './memories/memories.js';
import { Observer } from './observer/observer.js';
import { SessionRegistry } from './session/registry.js';
import { toSessionTurn } from './session/types.js';

export class Muninn {
  readonly memories: Memories;
  private observerRuntime: Observer | null = null;
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

  async shutdown(): Promise<void> {
    if (this.observerRuntime) {
      // Fast stop only: use flushPending() beforehand when the caller needs a barrier-drain.
      await this.observerRuntime.shutdown();
    }
    this.observerRuntime = null;
    this.sessionRegistry = null;
  }

  private async ensureObserver(): Promise<Observer> {
    if (!this.observerRuntime) {
      this.observerRuntime = new Observer(this.client);
    }
    await this.observerRuntime.ensureBootstrapped();
    return this.observerRuntime;
  }

  private ensureSessionRegistry(observerName: string): SessionRegistry {
    if (!this.sessionRegistry || this.sessionRegistry.observerName !== observerName) {
      this.sessionRegistry = new SessionRegistry(this.client, observerName);
    }
    return this.sessionRegistry;
  }
}
