export type SessionContentMode = 'split' | 'conversation';

export const OBSERVATION_MIN_WIDTH = 320;
export const CONVERSATION_MIN_WIDTH = 520;
export const DEFAULT_OBSERVATION_WIDTH = 420;
const OBSERVATION_MAX_RATIO = 0.55;

export function clampObservationWidth(width: number, containerWidth: number): number {
  const maxWidth = maxObservationWidth(containerWidth);
  const minWidth = Math.min(OBSERVATION_MIN_WIDTH, maxWidth);
  return Math.min(Math.max(width, minWidth), maxWidth);
}

export function gridTemplateForMode(
  mode: SessionContentMode,
  observationWidth: number,
  containerWidth?: number,
): string {
  if (mode === 'conversation') {
    return '0 0 minmax(0, 1fr)';
  }
  if (containerWidth && Number.isFinite(containerWidth)) {
    return `${clampObservationWidth(observationWidth, containerWidth)}px 1px minmax(0, 1fr)`;
  }
  return `minmax(0, min(${observationWidth}px, 55%)) 1px minmax(0, 1fr)`;
}

function maxObservationWidth(containerWidth: number): number {
  return Math.max(
    0,
    Math.max(
      containerWidth - CONVERSATION_MIN_WIDTH,
      Math.floor(containerWidth * OBSERVATION_MAX_RATIO),
    ),
  );
}

export function sessionTreeCanExpand(mode: SessionContentMode): boolean {
  return mode === 'conversation';
}

export function toggleSessionTreeLayoutMode(mode: SessionContentMode): SessionContentMode {
  return mode === 'conversation' ? 'split' : 'conversation';
}

export function hasSessionContext(session: unknown, document: unknown): boolean {
  return Boolean(session || document);
}

type ObservationRef = {
  memoryId: string;
  refs: string[];
};

export function locateConversationEnabled(
  observation: ObservationRef | null | undefined,
  conversationTurnIds: string[],
): boolean {
  if (!observation) {
    return false;
  }
  return !observation.refs.some((ref) => conversationTurnIds.includes(ref));
}

export function observationForConversationWindow<T extends ObservationRef>(
  observations: T[],
  conversationTurnIds: string[],
  orderedTurnIds: string[] = [],
): T | null {
  const anchorIndex = firstKnownTurnIndex(conversationTurnIds, orderedTurnIds);
  if (anchorIndex >= 0) {
    let best: T | null = null;
    let bestIndex = -1;
    for (const observation of observations) {
      const startIndex = firstKnownTurnIndex(observation.refs, orderedTurnIds);
      if (startIndex >= 0 && startIndex <= anchorIndex && startIndex > bestIndex) {
        best = observation;
        bestIndex = startIndex;
      }
    }
    if (best) {
      return best;
    }
  }

  for (const turnId of conversationTurnIds) {
    const observation = observations.find((item) => item.refs.includes(turnId));
    if (observation) {
      return observation;
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

export function locateObservationEnabled(
  conversationObservation: ObservationRef | null | undefined,
  activeObservationId: string | null,
  conversationTurnIds: string[] = [],
  activeObservation?: ObservationRef | null,
): boolean {
  if (!conversationObservation) {
    return false;
  }
  void conversationTurnIds;
  void activeObservation;
  return conversationObservation.memoryId !== activeObservationId;
}

export function selectedSessionKey(session: {
  agent: string;
  projectKey: string;
  sessionKey: string;
}): string {
  return `${session.agent}:${session.projectKey}:${session.sessionKey}`;
}
