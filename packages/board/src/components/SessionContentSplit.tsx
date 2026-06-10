import type { CSSProperties, PointerEvent } from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Artifact, MemoryDocument } from '@muninn/types';
import { FileText } from 'lucide-react';
import type { ProjectSessionNode, ProjectTurnNode } from '../lib/api.js';
import { chatTurnWindow } from '../lib/chat_window.js';
import {
  clampObservationWidth,
  conversationLocatorTurnIds,
  DEFAULT_OBSERVATION_WIDTH,
  gridTemplateForMode,
  hasSessionContext,
  locateConversationEnabled,
  locateObservationEnabled,
  observationForConversationWindow,
  selectedSessionKey,
  toggleSessionTreeLayoutMode,
  type SessionContentMode,
} from '../lib/session_content_state.js';
import { cn } from '../lib/utils.js';
import { ArtifactList } from './ArtifactList.js';
import { ChatView } from './ChatView.js';
import { LocateIcon } from './icons.js';
import { ObservationPane } from './ObservationPane.js';
import { ScrollArea } from './ui/scroll-area.js';

type SessionContentSplitProps = {
  session: ProjectSessionNode | null | undefined;
  document: MemoryDocument | null;
  mode: SessionContentMode;
  activeObservationId: string | null;
  openObservationId: string | null;
  openObservationRequestId: number;
  focusMemoryId: string | null;
  focusRequestId: number;
  sessionTurns: ProjectTurnNode[];
  onActiveObservationChange: (memoryId: string | null) => void;
  onOpenObservation: (memoryId: string) => void;
  onLocateConversationTurn: (memoryId: string) => void;
  canLoadMoreAfter: boolean;
  loadingMoreAfter: boolean;
  onLoadMoreAfter: () => void;
  loading: boolean;
  error: string | null;
  onModeChange: (mode: SessionContentMode) => void;
};

export function SessionContentSplit({
  session,
  document,
  mode,
  activeObservationId,
  openObservationId,
  openObservationRequestId,
  focusMemoryId,
  focusRequestId,
  sessionTurns,
  onActiveObservationChange,
  onOpenObservation,
  onLocateConversationTurn,
  canLoadMoreAfter,
  loadingMoreAfter,
  onLoadMoreAfter,
  loading,
  error,
  onModeChange,
}: SessionContentSplitProps) {
  const [contentTab, setContentTab] = useState<'conversation' | 'artifacts'>('conversation');
  const [observationWidth, setObservationWidth] = useState(DEFAULT_OBSERVATION_WIDTH);
  const [containerWidth, setContainerWidth] = useState<number | undefined>(undefined);
  const [visibleConversationTurnIds, setVisibleConversationTurnIds] = useState<string[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const hasContext = hasSessionContext(session, document);
  const title = session?.displaySessionId ?? document?.title ?? 'Session';
  const sessionKey = session ? selectedSessionKey(session) : null;
  const activeObservation = activeObservationId
    ? session?.observations.find((observation) => observation.memoryId === activeObservationId)
    : undefined;
  const activeConversationMemoryId = activeObservation?.refs[0] ?? activeObservationId;
  const inferredConversationTurnIds = useMemo(() => (
    chatTurnWindow(sessionTurns, focusMemoryId).turns
      .map((turn) => turn.memoryId)
      .filter((memoryId): memoryId is string => Boolean(memoryId))
  ), [focusMemoryId, sessionTurns]);
  const conversationWindowTurnIds = useMemo(() => conversationLocatorTurnIds(
    visibleConversationTurnIds,
    inferredConversationTurnIds,
  ), [inferredConversationTurnIds, visibleConversationTurnIds]);
  const orderedConversationTurnIds = useMemo(() => (
    sessionTurns
      .map((turn) => turn.memoryId)
      .filter((memoryId): memoryId is string => Boolean(memoryId))
  ), [sessionTurns]);
  const sessionArtifacts = useMemo(() => collectSessionArtifacts(document, sessionTurns), [document, sessionTurns]);
  const conversationObservation = useMemo(() => observationForConversationWindow(
    session?.observations ?? [],
    conversationWindowTurnIds,
    orderedConversationTurnIds,
  ), [conversationWindowTurnIds, orderedConversationTurnIds, session?.observations]);
  const canLocateObservation = locateObservationEnabled(
    conversationObservation,
    activeObservationId,
    conversationWindowTurnIds,
    activeObservation,
  );
  const canLocateConversation = locateConversationEnabled(activeObservation, conversationWindowTurnIds);
  const style = useMemo(() => ({
    '--session-content-grid': gridTemplateForMode(mode, observationWidth, containerWidth),
  }) as CSSProperties, [containerWidth, mode, observationWidth]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return undefined;
    }
    const updateWidth = () => setContainerWidth(root.getBoundingClientRect().width);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setVisibleConversationTurnIds([]);
  }, [sessionKey]);

  if (!hasContext) {
    return (
      <div className="session-context-empty">
        <FileText />
        <p>Choose a session to get the context</p>
      </div>
    );
  }

  const locateObservationButton = (
    <button
      className="session-locate-button"
      type="button"
      title={canLocateObservation ? 'Locate observation from conversation' : 'Observation already matches conversation'}
      aria-label="Locate observation from conversation"
      disabled={!canLocateObservation}
      onClick={() => {
        if (!canLocateObservation || !conversationObservation) {
          return;
        }
        onOpenObservation(conversationObservation.memoryId);
      }}
    >
      <LocateIcon />
    </button>
  );
  const locateConversationButton = (
    <button
      className="session-locate-button"
      type="button"
      title={canLocateConversation ? 'Locate conversation from observation' : 'Conversation already matches observation'}
      aria-label="Locate conversation from observation"
      disabled={!canLocateConversation}
      onClick={() => {
        if (!canLocateConversation || !activeConversationMemoryId) {
          return;
        }
        onLocateConversationTurn(activeConversationMemoryId);
      }}
    >
      <LocateIcon />
    </button>
  );
  const modeButton = (
    <button
      className="session-locate-button session-mode-button"
      type="button"
      title={modeTitle(mode)}
      aria-label={modeTitle(mode)}
      onClick={() => onModeChange(toggleSessionTreeLayoutMode(mode))}
    >
      <SessionContentModeIcon mode={mode} />
    </button>
  );
  function startResize(event: PointerEvent<HTMLButtonElement>) {
    const root = rootRef.current;
    if (!root || mode !== 'split') {
      return;
    }
    event.preventDefault();

    const resize = (clientX: number) => {
      const rect = root.getBoundingClientRect();
      setObservationWidth(clampObservationWidth(clientX - rect.left, rect.width));
    };

    const onPointerMove = (moveEvent: globalThis.PointerEvent) => resize(moveEvent.clientX);
    const cleanup = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', cleanup);
      window.removeEventListener('pointercancel', cleanup);
      root.classList.remove('session-content-resizing');
    };

    root.classList.add('session-content-resizing');
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', cleanup, { once: true });
    window.addEventListener('pointercancel', cleanup, { once: true });
  }

  return (
    <div
      ref={rootRef}
      className={cn('session-content-split', `session-content-mode-${mode}`)}
      style={style}
    >
      <section className="extraction-pane" aria-label="Session observations">
        <div className="session-pane-toolbar extraction-toolbar">
          <div className="session-pane-title-group">
            <div className="session-pane-title" title={title}>{title}</div>
          </div>
          <div className="extraction-toolbar-actions">
            {locateObservationButton}
          </div>
        </div>
        <ObservationPane
          observations={session?.observations ?? []}
          sessionSummary={session?.sessionSummary}
          activeObservationId={activeObservationId}
          openObservationId={openObservationId}
          openObservationRequestId={openObservationRequestId}
          sessionKey={session ? selectedSessionKey(session) : null}
          sessionTurns={sessionTurns}
          onActiveObservationChange={onActiveObservationChange}
          onLocateTurn={onLocateConversationTurn}
        />
      </section>
      <button
        className="session-content-divider"
        type="button"
        aria-label="Resize observation and conversation panes"
        onPointerDown={startResize}
      />
      <section className="session-conversation-pane" aria-label="Conversation">
        <div className="session-pane-toolbar session-conversation-toolbar">
          <div className="session-conversation-toolbar-main">
            <div className="session-content-tabs" role="tablist" aria-label="Session content">
              <button
                type="button"
                role="tab"
                aria-selected={contentTab === 'conversation'}
                className={cn('session-content-tab', contentTab === 'conversation' && 'session-content-tab-active')}
                onClick={() => setContentTab('conversation')}
              >
                Conversation
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={contentTab === 'artifacts'}
                className={cn('session-content-tab', contentTab === 'artifacts' && 'session-content-tab-active')}
                onClick={() => setContentTab('artifacts')}
              >
                Artifacts
              </button>
            </div>
            <div className="session-conversation-toolbar-actions">
              {locateConversationButton}
              {modeButton}
            </div>
          </div>
        </div>
        {contentTab === 'conversation' ? (
          <ChatView
            document={document}
            activeMemoryId={activeConversationMemoryId}
            focusMemoryId={focusMemoryId}
            focusRequestId={focusRequestId}
            sessionTurns={sessionTurns}
            onVisibleTurnIdsChange={setVisibleConversationTurnIds}
            canLoadMoreAfter={canLoadMoreAfter}
            loadingMoreAfter={loadingMoreAfter}
            onLoadMoreAfter={onLoadMoreAfter}
            loading={loading}
            error={error}
          />
        ) : (
          <SessionArtifacts artifacts={sessionArtifacts} agent={session?.agent ?? document?.agent ?? document?.observer} />
        )}
      </section>
    </div>
  );
}

function collectSessionArtifacts(document: MemoryDocument | null, sessionTurns: ProjectTurnNode[]): Artifact[] {
  const artifacts: Artifact[] = [];
  const seen = new Set<string>();
  for (const artifact of [
    ...(document?.artifacts ?? []),
    ...sessionTurns.flatMap((turn) => turn.artifacts ?? []),
  ]) {
    if (artifact.kind === 'metadata') {
      continue;
    }
    const key = artifact.uri ?? artifact.key;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    artifacts.push(artifact);
  }
  return artifacts;
}

function SessionArtifacts({ artifacts, agent }: { artifacts: Artifact[]; agent?: string }) {
  if (artifacts.length === 0) {
    return <div className="session-artifacts-empty">No artifacts yet.</div>;
  }
  return (
    <ScrollArea className="session-artifacts-scroll">
      <ArtifactList artifacts={artifacts} agent={agent} variant="session" />
    </ScrollArea>
  );
}

function modeTitle(mode: SessionContentMode): string {
  if (mode === 'split') {
    return 'Session tree, observations, and conversation';
  }
  if (mode === 'conversation') {
    return 'Session tree and conversation';
  }
  return 'Observations and conversation';
}

function SessionContentModeIcon({ mode }: { mode: SessionContentMode }) {
  return (
    <svg className="session-mode-icon" viewBox="0 0 18 18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round">
      {mode === 'split' ? (
        <>
          <path d="M4.5 4.25v9.5" />
          <path d="M9 4.25v9.5" />
          <path d="M13.5 4.25v9.5" />
        </>
      ) : mode === 'conversation' ? (
        <>
          <path d="M4.5 4.25v9.5" />
          <path d="M13.5 4.25v9.5" />
        </>
      ) : (
        <>
          <path d="M9 4.25v9.5" />
          <path d="M13.5 4.25v9.5" />
        </>
      )}
    </svg>
  );
}
