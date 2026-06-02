import type { Artifact, ToolCall, TurnEvent } from '@muninn/types';

export type ChatRole = 'user' | 'agent';

export type ChatMessage = {
  role: ChatRole;
  label: string;
  body: string;
  memoryId?: string;
  agent?: string;
  timestamp?: string;
  artifacts?: Artifact[];
};

export type ChatToolGroup = {
  memoryId?: string;
  agent?: string;
  timestamp?: string;
  toolCalls: ToolCall[];
};

export type ChatCost = {
  memoryId?: string;
  startedAt?: string;
  completedAt?: string;
};

export type ChatTimelineEntry =
  | { type: 'message'; message: ChatMessage }
  | { type: 'toolGroup'; group: ChatToolGroup }
  | { type: 'cost'; cost: ChatCost };

type TimelineContext = {
  memoryId: string;
  agent?: string;
  startedAt?: string;
  completedAt?: string;
};

export function entriesFromEvents(events: TurnEvent[], context: TimelineContext): ChatTimelineEntry[] {
  const entries: ChatTimelineEntry[] = [];
  let pendingToolCalls: ToolCall[] = [];
  let pendingToolTimestamp: string | undefined;
  let toolCallIndexById = new Map<string, number>();

  const flushToolGroup = () => {
    if (pendingToolCalls.length === 0) {
      return;
    }
    entries.push({
      type: 'toolGroup',
      group: {
        memoryId: context.memoryId,
        agent: context.agent,
        timestamp: pendingToolTimestamp,
        toolCalls: pendingToolCalls,
      },
    });
    pendingToolCalls = [];
    pendingToolTimestamp = undefined;
    toolCallIndexById = new Map();
  };

  for (const event of events) {
    if (event.type === 'userMessage') {
      flushToolGroup();
      entries.push({
        type: 'message',
        message: {
          role: 'user',
          label: 'User',
          body: event.text,
          memoryId: context.memoryId,
          agent: context.agent,
          timestamp: event.timestamp,
          artifacts: event.artifacts,
        },
      });
      continue;
    }

    if (event.type === 'assistantMessage') {
      flushToolGroup();
      entries.push({
        type: 'message',
        message: {
          role: 'agent',
          label: 'Agent',
          body: event.text,
          memoryId: context.memoryId,
          agent: context.agent,
          timestamp: event.timestamp,
          artifacts: event.artifacts,
        },
      });
      continue;
    }

    if (event.type === 'toolCall') {
      pendingToolTimestamp ??= event.timestamp;
      const index = pendingToolCalls.length;
      pendingToolCalls.push({
        id: event.id,
        name: event.name,
        input: event.input,
      });
      if (event.id) {
        toolCallIndexById.set(event.id, index);
      }
      continue;
    }

    if (event.type === 'toolOutput') {
      pendingToolTimestamp ??= event.timestamp;
      const index = event.id ? toolCallIndexById.get(event.id) : undefined;
      if (index !== undefined) {
        pendingToolCalls[index] = {
          ...pendingToolCalls[index],
          output: event.output,
        };
      } else if (event.output) {
        pendingToolCalls.push({
          id: event.id,
          name: 'tool_output',
          output: event.output,
        });
      }
    }
  }

  flushToolGroup();
  appendCost(entries, context);
  return entries;
}

export function entriesFromFallback(
  turn: {
    memoryId: string;
    agent?: string;
    createdAt?: string;
    updatedAt?: string;
    prompt?: string;
    response?: string;
    artifacts?: Artifact[];
    toolCalls?: ToolCall[];
  },
): ChatTimelineEntry[] {
  const entries: ChatTimelineEntry[] = [];
  if (turn.prompt) {
    entries.push({
      type: 'message',
      message: {
        role: 'user',
        label: 'User',
        body: turn.prompt,
        memoryId: turn.memoryId,
        agent: turn.agent,
        timestamp: turn.createdAt,
        artifacts: turn.artifacts?.filter((artifact) => artifact.source === 'prompt'),
      },
    });
  }
  if (turn.response) {
    entries.push({
      type: 'message',
      message: {
        role: 'agent',
        label: 'Agent',
        body: turn.response,
        memoryId: turn.memoryId,
        agent: turn.agent,
        timestamp: turn.updatedAt,
        artifacts: turn.artifacts?.filter((artifact) => artifact.source === 'response'),
      },
    });
  }
  if (turn.toolCalls && turn.toolCalls.length > 0) {
    entries.push({
      type: 'toolGroup',
      group: {
        memoryId: turn.memoryId,
        agent: turn.agent,
        timestamp: turn.updatedAt,
        toolCalls: turn.toolCalls,
      },
    });
  }
  appendCost(entries, {
    memoryId: turn.memoryId,
    startedAt: turn.createdAt,
    completedAt: turn.updatedAt,
  });
  return entries;
}

function appendCost(entries: ChatTimelineEntry[], context: TimelineContext) {
  if (!context.startedAt || !context.completedAt) {
    return;
  }
  entries.push({
    type: 'cost',
    cost: {
      memoryId: context.memoryId,
      startedAt: context.startedAt,
      completedAt: context.completedAt,
    },
  });
}

export const __testing = {
  entriesFromEvents,
  entriesFromFallback,
};

export default {
  __testing,
};
