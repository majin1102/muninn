import type { NativeTables } from '../native.js';
import type { ListModeInput, SessionSnapshot, RecallHit, RenderedMemory, Turn } from '../client.js';
import { getSessionSnapshot, listSessionSnapshots, timelineSessionSnapshots } from './sessions.js';
import { getExtraction } from './extractions.js';
import { getGlobalObservation } from './global-observations.js';
import { recallMemories } from './recall.js';
import type { RecallMode } from './recall.js';
import { renderExtraction, renderGlobalObservation, renderSessionSnapshot, renderTurn } from './rendered.js';
import { getTurn, listTurns, timelineTurns } from './turns.js';

export class Memories {
  constructor(private readonly client: NativeTables) {}

  async getTurn(memoryId: string): Promise<Turn | null> {
    return getTurn(this.client, memoryId);
  }

  async listTurns(params: {
    mode: ListModeInput;
    agent?: string;
    sessionId?: string;
  }): Promise<Turn[]> {
    return listTurns(this.client, params);
  }

  async getSession(memoryId: string): Promise<SessionSnapshot | null> {
    return getSessionSnapshot(this.client, memoryId);
  }

  async listSessions(params: {
    mode: ListModeInput;
    observer?: string;
  }): Promise<SessionSnapshot[]> {
    return listSessionSnapshots(this.client, params);
  }

  async get(memoryId: string): Promise<RenderedMemory | null> {
    if (memoryId.startsWith('extraction:')) {
      const observation = await getExtraction(this.client, memoryId);
      return observation ? renderExtraction(observation) : null;
    }
    if (memoryId.startsWith('global_observation:')) {
      const observation = await getGlobalObservation(this.client, memoryId);
      return observation ? renderGlobalObservation(observation) : null;
    }
    if (memoryId.startsWith('session:')) {
      const snapshot = await getSessionSnapshot(this.client, memoryId);
      return snapshot ? renderSessionSnapshot(snapshot) : null;
    }
    const session = await getTurn(this.client, memoryId);
    return session ? renderTurn(session) : null;
  }

  async list(params: { mode: ListModeInput }): Promise<RenderedMemory[]> {
    const sourceMode = params.mode.type === 'page'
      ? { type: 'recency', limit: params.mode.offset + params.mode.limit } as const
      : params.mode;
    const [turns, sessions] = await Promise.all([
      listTurns(this.client, { mode: sourceMode }),
      listSessionSnapshots(this.client, { mode: sourceMode }),
    ]);
    const combined = turns
      .map(renderTurn)
      .concat(sessions.map(renderSessionSnapshot))
      .filter((memory): memory is RenderedMemory => Boolean(memory));
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
  }): Promise<RenderedMemory[]> {
    if (params.memoryId.startsWith('session:')) {
      return (await timelineSessionSnapshots(this.client, params))
        .map(renderSessionSnapshot)
        .filter((memory): memory is RenderedMemory => Boolean(memory));
    }
    return (await timelineTurns(this.client, params))
      .map(renderTurn)
      .filter((memory): memory is RenderedMemory => Boolean(memory));
  }

  async recall(
    query: string,
    limit?: number,
    options?: { mode?: RecallMode; budget?: number; queryLimit?: number; includeGlobalObservations?: boolean },
  ): Promise<RecallHit[]> {
    return recallMemories(this.client, query, limit, options);
  }
}
