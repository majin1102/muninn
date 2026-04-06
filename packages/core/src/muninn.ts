import type { CoreBinding } from './native.js';
import type { ObserverWatermark, RecallHit, SessionMessageInput, SessionTurn } from './client.js';
import { Memories } from './memories/memories.js';
import { Observer } from './observer/observer.js';
import { SessionRegistry } from './session/registry.js';
import { toSessionTurn } from './session/types.js';

export class Muninn {
  readonly memories: Memories;
  private observerRuntime: Observer | null = null;
  private sessionRegistry: SessionRegistry | null = null;

  constructor(private readonly client: CoreBinding) {
    this.memories = new Memories(client);
  }

  async accept(content: SessionMessageInput): Promise<SessionTurn> {
    const observer = await this.ensureObserver();
    const registry = this.ensureSessionRegistry(observer.name);
    const window = await observer.window();
    try {
      const session = await registry.load(content.sessionId, content.agent);
      const turn = await session.accept(content, window);
      await window.include(turn);
      return toSessionTurn(turn);
    } finally {
      window.complete();
    }
  }

  async observerWatermark(): Promise<ObserverWatermark> {
    return (await this.ensureObserver()).watermark();
  }

  async recallMemories(query: string, limit?: number): Promise<RecallHit[]> {
    await (await this.ensureObserver()).flushPending();
    return this.memories.recall(query, limit);
  }

  async shutdown(): Promise<void> {
    if (this.observerRuntime) {
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
