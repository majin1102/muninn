import type { CoreBinding } from '../native.js';
import type { ListModeInput, ObservingRecord, RecallHitRecord, RenderedMemoryRecord, SessionTurnRecord } from '../client.js';
import { getObservingSnapshot, listObservingSnapshots, timelineObservingSnapshots } from './observings.js';
import { recallMemories } from './recall.js';
import { renderObservingSnapshot, renderSessionTurn } from './rendered.js';
import { getSessionTurn, listSessionTurns, timelineSessionTurns } from './sessions.js';
import { fromWireTurn } from '../session/types.js';

export class Memories {
  constructor(private readonly client: CoreBinding) {}

  async getSession(memoryId: string): Promise<SessionTurnRecord | null> {
    return getSessionTurn(this.client, memoryId);
  }

  async listSessions(params: {
    mode: ListModeInput;
    agent?: string;
    sessionId?: string;
  }): Promise<SessionTurnRecord[]> {
    return listSessionTurns(this.client, params);
  }

  async getObserving(memoryId: string): Promise<ObservingRecord | null> {
    return getObservingSnapshot(this.client, memoryId);
  }

  async listObservings(params: {
    mode: ListModeInput;
    observer?: string;
  }): Promise<ObservingRecord[]> {
    return listObservingSnapshots(this.client, params);
  }

  async get(memoryId: string): Promise<RenderedMemoryRecord | null> {
    if (memoryId.startsWith('observing:')) {
      const observing = await getObservingSnapshot(this.client, memoryId);
      return observing ? renderObservingSnapshot(observing) : null;
    }
    const session = await getSessionTurn(this.client, memoryId);
    return session ? renderSessionTurn(fromWireTurn(session)) : null;
  }

  async list(params: { mode: ListModeInput }): Promise<RenderedMemoryRecord[]> {
    const [turns, observings] = await Promise.all([
      listSessionTurns(this.client, { mode: params.mode }),
      listObservingSnapshots(this.client, { mode: params.mode }),
    ]);
    const combined = turns
      .map((turn) => renderSessionTurn(fromWireTurn(turn)))
      .concat(observings.map(renderObservingSnapshot))
      .filter((memory): memory is RenderedMemoryRecord => Boolean(memory));
    combined.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    if (params.mode.type === 'recency') {
      const selected = combined.slice(0, params.mode.limit);
      return selected.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    }
    return combined.slice(params.mode.offset, params.mode.offset + params.mode.limit);
  }

  async timeline(params: {
    memoryId: string;
    beforeLimit?: number;
    afterLimit?: number;
  }): Promise<RenderedMemoryRecord[]> {
    if (params.memoryId.startsWith('observing:')) {
      return (await timelineObservingSnapshots(this.client, params))
        .map(renderObservingSnapshot)
        .filter((memory): memory is RenderedMemoryRecord => Boolean(memory));
    }
    return (await timelineSessionTurns(this.client, params))
      .map(renderSessionTurn)
      .filter((memory): memory is RenderedMemoryRecord => Boolean(memory));
  }

  async recall(query: string, limit?: number): Promise<RecallHitRecord[]> {
    return recallMemories(this.client, query, limit);
  }
}
