import {
  demoAgents,
  demoDocuments,
  demoObservings,
  demoSessionGroups,
  demoSessionTurns,
  type DemoMemoryDocument,
  type DemoObservingListItem,
  type DemoSessionAgentItem,
  type DemoSessionGroupItem,
  type DemoSessionTimelineItem,
} from './data.js';

export async function getDemoSessionAgents(): Promise<DemoSessionAgentItem[]> {
  return demoAgents;
}

export async function getDemoSessionGroups(agent: string): Promise<DemoSessionGroupItem[]> {
  return demoSessionGroups[agent] ?? [];
}

export async function getDemoSessionTurns(
  agent: string,
  sessionKey: string,
  offset: number,
  limit: number,
): Promise<{ turns: DemoSessionTimelineItem[]; nextOffset: number | null }> {
  const turns = demoSessionTurns[`${agent}::${sessionKey}`] ?? [];
  const page = turns.slice(offset, offset + limit);
  return {
    turns: page,
    nextOffset: offset + limit < turns.length ? offset + limit : null,
  };
}

export async function getDemoObservings(): Promise<DemoObservingListItem[]> {
  return demoObservings;
}

export async function getDemoDocument(memoryId: string): Promise<DemoMemoryDocument> {
  const document = demoDocuments[memoryId];
  if (!document) {
    throw new Error(`demo memory not found: ${memoryId}`);
  }
  return document;
}
