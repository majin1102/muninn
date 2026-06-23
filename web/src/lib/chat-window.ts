export const DEFAULT_CHAT_INITIAL_TURN_COUNT = 16;
export const INITIAL_CHAT_CONTEXT_RADIUS = 20;
export const CHAT_CONTEXT_STEP = 16;

export type ChatTurnWindow<T> = {
  turns: T[];
  beforeCount: number;
  afterCount: number;
};

export function chatTurnWindow<T extends { memoryId?: string }>(
  turns: T[],
  activeMemoryId: string | null,
  beforeLimit = INITIAL_CHAT_CONTEXT_RADIUS,
  afterLimit?: number,
): ChatTurnWindow<T> {
  if (turns.length === 0) {
    return {
      turns,
      beforeCount: 0,
      afterCount: 0,
    };
  }

  if (!activeMemoryId) {
    const end = Math.min(turns.length, afterLimit ?? DEFAULT_CHAT_INITIAL_TURN_COUNT);
    return {
      turns: turns.slice(0, end),
      beforeCount: 0,
      afterCount: turns.length - end,
    };
  }

  const matchedIndex = activeMemoryId
    ? turns.findIndex((turn) => turn.memoryId === activeMemoryId)
    : -1;
  const activeIndex = matchedIndex >= 0 ? matchedIndex : 0;
  const start = Math.max(0, activeIndex - beforeLimit);
  const end = Math.min(turns.length, activeIndex + (afterLimit ?? INITIAL_CHAT_CONTEXT_RADIUS) + 1);
  return {
    turns: turns.slice(start, end),
    beforeCount: start,
    afterCount: turns.length - end,
  };
}
