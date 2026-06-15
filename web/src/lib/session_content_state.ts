import * as SessionIdentity from '@muninn/common/session-identity';

export type SessionContentMode = 'split' | 'conversation' | 'collapsed';

export const TIMELINE_MIN_WIDTH = 320;
export const CONVERSATION_MIN_WIDTH = 520;
export const DEFAULT_TIMELINE_WIDTH = 420;
const TIMELINE_MAX_RATIO = 0.55;

export function clampTimelineWidth(width: number, containerWidth: number): number {
  const maxWidth = maxTimelineWidth(containerWidth);
  const minWidth = Math.min(TIMELINE_MIN_WIDTH, maxWidth);
  return Math.min(Math.max(width, minWidth), maxWidth);
}

export function gridTemplateForMode(
  mode: SessionContentMode,
  timelineWidth: number,
  containerWidth?: number,
): string {
  if (mode === 'conversation') {
    return '0 0 minmax(0, 1fr)';
  }
  if (containerWidth && Number.isFinite(containerWidth)) {
    return `${clampTimelineWidth(timelineWidth, containerWidth)}px 1px minmax(0, 1fr)`;
  }
  return `minmax(0, min(${timelineWidth}px, 55%)) 1px minmax(0, 1fr)`;
}

function maxTimelineWidth(containerWidth: number): number {
  return Math.max(
    0,
    Math.max(
      containerWidth - CONVERSATION_MIN_WIDTH,
      Math.floor(containerWidth * TIMELINE_MAX_RATIO),
    ),
  );
}

export function sessionTreeCanExpand(mode: SessionContentMode): boolean {
  return mode === 'conversation';
}

export function toggleSessionTreeLayoutMode(mode: SessionContentMode): SessionContentMode {
  if (mode === 'split') {
    return 'conversation';
  }
  if (mode === 'conversation') {
    return 'collapsed';
  }
  return 'split';
}

export function hasSessionContext(session: unknown, document: unknown): boolean {
  return Boolean(session || document);
}

type TimelineRef = {
  memoryId: string;
  refs: string[];
};

export function locateConversationEnabled(
  item: TimelineRef | null | undefined,
  conversationTurnIds: string[],
): boolean {
  if (!item) {
    return false;
  }
  return !item.refs.some((ref) => conversationTurnIds.includes(ref));
}

export function timelineItemForConversationWindow<T extends TimelineRef>(
  timeline: T[],
  conversationTurnIds: string[],
  orderedTurnIds: string[] = [],
): T | null {
  const anchorIndex = firstKnownTurnIndex(conversationTurnIds, orderedTurnIds);
  if (anchorIndex >= 0) {
    let best: T | null = null;
    let bestIndex = -1;
    for (const item of timeline) {
      const startIndex = firstKnownTurnIndex(item.refs, orderedTurnIds);
      if (startIndex >= 0 && startIndex <= anchorIndex && startIndex > bestIndex) {
        best = item;
        bestIndex = startIndex;
      }
    }
    if (best) {
      return best;
    }
  }

  for (const turnId of conversationTurnIds) {
    const item = timeline.find((timelineItem) => timelineItem.refs.includes(turnId));
    if (item) {
      return item;
    }
  }
  return null;
}

function firstKnownTurnIndex(turnIds: string[], orderedTurnIds: string[]): number {
  for (const turnId of turnIds) {
    const index = orderedTurnIds.indexOf(turnId);
    if (index >= 0) {
      return index;
    }
  }
  return -1;
}

export function conversationLocatorTurnIds(
  visibleTurnIds: string[],
  fallbackTurnIds: string[],
): string[] {
  return visibleTurnIds.length > 0 ? visibleTurnIds : fallbackTurnIds;
}

export function locateTimelineEnabled(
  conversationItem: TimelineRef | null | undefined,
  activeTimelineId: string | null,
  conversationTurnIds: string[] = [],
  activeItem?: TimelineRef | null,
): boolean {
  if (!conversationItem) {
    return false;
  }
  void conversationTurnIds;
  void activeItem;
  return conversationItem.memoryId !== activeTimelineId;
}

export function selectedSessionKey(session: {
  projectKey: string;
  agent: string;
  cwd?: string;
  sessionKey: string;
}): string {
  return SessionIdentity.sessionIdentityKey({
    project: session.projectKey,
    agent: session.agent,
    sessionId: session.sessionKey,
  });
}
