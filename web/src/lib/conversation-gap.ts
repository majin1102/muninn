export function turnsBeforeGap<T extends { contextId?: string }>(turns: T[], beforeContextId: string): T[] {
  const index = turns.findIndex((turn) => turn.contextId === beforeContextId);
  return index >= 0 ? turns.slice(0, index) : turns;
}
