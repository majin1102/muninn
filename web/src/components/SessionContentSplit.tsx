import type { CSSProperties, PointerEvent } from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Artifact, MemoryDocument } from '@muninn/common';
import { FileText } from 'lucide-react';
import type { ProjectSessionNode, ProjectTurnNode } from '../lib/api.js';
import { chatTurnWindow } from '../lib/chat-window.js';
import {
  clampTimelineWidth,
  conversationLocatorTurnIds,
  DEFAULT_TIMELINE_WIDTH,
  gridTemplateForMode,
  hasSessionContext,
  locateConversationEnabled,
  locateTimelineEnabled,
  selectedSessionKey,
  timelineItemForConversationWindow,
  toggleSessionTreeLayoutMode,
  type SessionContentMode,
} from '../lib/session-content-state.js';
import { cn } from '../lib/utils.js';
import { ArtifactList } from './ArtifactList.js';
import { ChatView } from './ChatView.js';
import { LocateIcon } from './icons.js';
import { TimelinePane } from './TimelinePane.js';
import { EmptyState } from './ui/empty-state.js';
import { ScrollArea } from './ui/scroll-area.js';

type SessionContentSplitProps = {
  session: ProjectSessionNode | null | undefined;
  document: MemoryDocument | null;
  mode: SessionContentMode;
  activeTimelineId: string | null;
  openTimelineId: string | null;
  openTimelineRequestId: number;
  focusMemoryId: string | null;
  focusRequestId: number;
  sessionTurns: ProjectTurnNode[];
  onActiveTimelineChange: (memoryId: string | null) => void;
  onOpenTimeline: (memoryId: string) => void;
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
  activeTimelineId,
  openTimelineId,
  openTimelineRequestId,
  focusMemoryId,
  focusRequestId,
  sessionTurns,
  onActiveTimelineChange,
  onOpenTimeline,
  onLocateConversationTurn,
  canLoadMoreAfter,
  loadingMoreAfter,
  onLoadMoreAfter,
  loading,
  error,
  onModeChange,
}: SessionContentSplitProps) {
  const [contentTab, setContentTab] = useState<'conversation' | 'artifacts'>('conversation');
  const [timelineWidth, setTimelineWidth] = useState(DEFAULT_TIMELINE_WIDTH);
  const [containerWidth, setContainerWidth] = useState<number | undefined>(undefined);
  const [visibleConversationTurnIds, setVisibleConversationTurnIds] = useState<string[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const hasContext = hasSessionContext(session, document);
  const title = session?.displaySessionId ?? document?.title ?? 'Session';
  const sessionKey = session ? selectedSessionKey(session) : null;
  const activeTimelineItem = activeTimelineId
    ? session?.timeline.find((item) => item.memoryId === activeTimelineId)
    : undefined;
  const activeConversationMemoryId = activeTimelineItem?.refs[0] ?? turnIdFromTimelineId(activeTimelineId);
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
  const conversationTimelineItem = useMemo(() => timelineItemForConversationWindow(
    session?.timeline ?? [],
    conversationWindowTurnIds,
    orderedConversationTurnIds,
  ), [conversationWindowTurnIds, orderedConversationTurnIds, session?.timeline]);
  const canLocateTimeline = locateTimelineEnabled(
    conversationTimelineItem,
    activeTimelineId,
    conversationWindowTurnIds,
    activeTimelineItem,
  );
  const canLocateConversation = Boolean(activeConversationMemoryId)
    && locateConversationEnabled(activeTimelineItem, conversationWindowTurnIds);
  const style = useMemo(() => ({
    '--session-content-grid': gridTemplateForMode(mode, timelineWidth, containerWidth),
  }) as CSSProperties, [containerWidth, mode, timelineWidth]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return undefined;
    }
    const updateWidth = () => setContainerWidth(root.getBoundingClientRect().width);
    updateWidth();
    const resizeWatcher = new ResizeObserver(updateWidth);
    resizeWatcher.observe(root);
    return () => resizeWatcher.disconnect();
  }, []);

  useEffect(() => {
    setVisibleConversationTurnIds([]);
  }, [sessionKey]);

  if (!hasContext) {
    return (
      <EmptyState className="content-empty-panel" icon={FileText} title="Choose a session to view its context." variant="passive" />
    );
  }

  const locateTimelineButton = (
    <button
      className="session-locate-button"
      type="button"
      title={canLocateTimeline ? 'Locate timeline from conversation' : 'Timeline already matches conversation'}
      aria-label="Locate timeline from conversation"
      disabled={!canLocateTimeline}
      onClick={() => {
        if (!canLocateTimeline || !conversationTimelineItem) {
          return;
        }
        onOpenTimeline(conversationTimelineItem.memoryId);
      }}
    >
      <LocateIcon />
    </button>
  );
  const locateConversationButton = (
    <button
      className="session-locate-button"
      type="button"
      title={canLocateConversation ? 'Locate conversation from timeline' : 'Conversation already matches timeline'}
      aria-label="Locate conversation from timeline"
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
      setTimelineWidth(clampTimelineWidth(clientX - rect.left, rect.width));
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
      <section className="timeline-pane" aria-label="Session timeline">
        <div className="session-pane-toolbar timeline-toolbar">
          <div className="session-pane-title-group">
            <div className="session-pane-title" title={title}>{title}</div>
          </div>
          <div className="timeline-toolbar-actions">
            {locateTimelineButton}
          </div>
        </div>
        <TimelinePane
          timeline={session?.timeline ?? []}
          activeTimelineId={activeTimelineId}
          openTimelineId={openTimelineId}
          openTimelineRequestId={openTimelineRequestId}
          sessionKey={session ? selectedSessionKey(session) : null}
          sessionTurns={sessionTurns}
          onActiveTimelineChange={onActiveTimelineChange}
          onLocateTurn={onLocateConversationTurn}
        />
      </section>
      <button
        className="session-content-divider"
        type="button"
        aria-label="Resize timeline and conversation panes"
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
          <SessionArtifacts artifacts={sessionArtifacts} agent={session?.agent ?? document?.agent ?? document?.extractor} />
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

function turnIdFromTimelineId(memoryId: string | null): string | null {
  if (!memoryId?.startsWith('turn:')) {
    return null;
  }
  const timelineIndex = memoryId.indexOf('~timeline');
  return timelineIndex >= 0 ? memoryId.slice(0, timelineIndex) : memoryId;
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
    return 'Session tree, timeline, and conversation';
  }
  if (mode === 'conversation') {
    return 'Session tree and conversation';
  }
  return 'Timeline and conversation';
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
