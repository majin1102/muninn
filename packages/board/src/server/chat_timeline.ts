import type { Artifact, ToolCall, TurnEvent } from '@muninn/types';

export type ChatRole = 'user' | 'agent';

export type ChatMessage = {
  role: ChatRole;
  label: string;
  body: string;
  memoryId?: string;
  agent?: string;
  timestamp?: string;
  startedAt?: string;
  completedAt?: string;
  artifacts?: Artifact[];
};

export type ChatToolGroup = {
  memoryId?: string;
  agent?: string;
  timestamp?: string;
  startedAt?: string;
  completedAt?: string;
  toolCalls: ChatToolCall[];
};

export type ChatToolCall = ToolCall & {
  startedAt?: string;
  completedAt?: string;
};

export type ChatTotalTime = {
  memoryId?: string;
  startedAt?: string;
  completedAt?: string;
};

export type ChatTimelineEntry =
  | { type: 'message'; message: ChatMessage }
  | { type: 'toolGroup'; group: ChatToolGroup }
  | { type: 'totalTime'; totalTime: ChatTotalTime };

type TimelineContext = {
  memoryId: string;
  agent?: string;
  startedAt?: string;
  completedAt?: string;
};

export function entriesFromEvents(events: TurnEvent[], context: TimelineContext): ChatTimelineEntry[] {
  const entries: ChatTimelineEntry[] = [];
  let pendingToolCalls: ChatToolCall[] = [];
  let pendingToolTimestamp: string | undefined;
  let toolCallIndexById = new Map<string, number>();
  let previousTimestamp: string | undefined;

  const rememberTimestamp = (timestamp: string | undefined) => {
    if (timestamp) {
      previousTimestamp = timestamp;
    }
  };

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
        startedAt: firstToolTimestamp(pendingToolCalls),
        completedAt: lastToolTimestamp(pendingToolCalls),
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
      rememberTimestamp(event.timestamp);
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
          startedAt: previousTimestamp,
          completedAt: event.timestamp,
          artifacts: event.artifacts,
        },
      });
      rememberTimestamp(event.timestamp);
      continue;
    }

    if (event.type === 'toolCall') {
      pendingToolTimestamp ??= event.timestamp;
      const index = pendingToolCalls.length;
      pendingToolCalls.push({
        id: event.id,
        name: event.name,
        input: event.input,
        startedAt: event.timestamp,
      });
      if (event.id) {
        toolCallIndexById.set(event.id, index);
      }
      rememberTimestamp(event.timestamp);
      continue;
    }

    if (event.type === 'toolOutput') {
      pendingToolTimestamp ??= event.timestamp;
      const index = event.id ? toolCallIndexById.get(event.id) : undefined;
      if (index !== undefined) {
        pendingToolCalls[index] = {
          ...pendingToolCalls[index],
          output: event.output,
          completedAt: event.timestamp,
        };
      } else if (event.output) {
        pendingToolCalls.push({
          id: event.id,
          name: 'tool_output',
          output: event.output,
          completedAt: event.timestamp,
        });
      }
      rememberTimestamp(event.timestamp);
    }
  }

  flushToolGroup();
  appendTotalTime(entries, context);
  return entries;
}

export function entriesFromFallback(
  turn: {
    memoryId: string;
    agent?: string;
    createdAt?: string;
    updatedAt?: string;
    title?: string;
    summary?: string;
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
        startedAt: turn.createdAt,
        completedAt: turn.updatedAt,
        artifacts: turn.artifacts?.filter((artifact) => artifact.source === 'response'),
      },
    });
  }
  if (entries.length === 0) {
    const split = splitSummaryFallback(turn.summary);
    if (split) {
      entries.push({
        type: 'message',
        message: {
          role: 'user',
          label: 'User',
          body: split.prompt,
          memoryId: turn.memoryId,
          agent: turn.agent,
          timestamp: turn.createdAt,
        },
      });
      entries.push({
        type: 'message',
        message: {
          role: 'agent',
          label: 'Agent',
          body: split.response,
          memoryId: turn.memoryId,
          agent: turn.agent,
          timestamp: turn.updatedAt,
          startedAt: turn.createdAt,
          completedAt: turn.updatedAt,
        },
      });
    } else {
      const body = turn.summary ?? turn.title;
      if (body) {
        entries.push({
          type: 'message',
          message: {
            role: 'agent',
            label: 'Agent',
            body,
            memoryId: turn.memoryId,
            agent: turn.agent,
            timestamp: turn.updatedAt ?? turn.createdAt,
            startedAt: turn.createdAt,
            completedAt: turn.updatedAt,
          },
        });
      }
    }
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
  appendTotalTime(entries, {
    memoryId: turn.memoryId,
    startedAt: turn.createdAt,
    completedAt: turn.updatedAt,
  });
  return entries;
}

function appendTotalTime(entries: ChatTimelineEntry[], context: TimelineContext) {
  if (!context.startedAt || !context.completedAt) {
    return;
  }
  entries.push({
    type: 'totalTime',
    totalTime: {
      memoryId: context.memoryId,
      startedAt: context.startedAt,
      completedAt: context.completedAt,
    },
  });
}

function firstToolTimestamp(toolCalls: ChatToolCall[]): string | undefined {
  return toolCalls
    .flatMap((toolCall) => [toolCall.startedAt, toolCall.completedAt])
    .find((timestamp): timestamp is string => Boolean(timestamp));
}

function lastToolTimestamp(toolCalls: ChatToolCall[]): string | undefined {
  const timestamps = toolCalls
    .flatMap((toolCall) => [toolCall.startedAt, toolCall.completedAt])
    .filter((timestamp): timestamp is string => Boolean(timestamp));
  return timestamps.length >= 2 ? timestamps.at(-1) : undefined;
}

function splitSummaryFallback(summary: string | undefined): { prompt: string; response: string } | null {
  if (!summary) {
    return null;
  }
  const parts = summary
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) {
    return null;
  }
  return {
    prompt: parts[0]!,
    response: parts.slice(1).join('\n\n'),
  };
}

export const __testing = {
  entriesFromEvents,
  entriesFromFallback,
};
