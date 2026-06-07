import type { MemoryDocument } from '@muninn/types';
import { BookOpen, ChevronLeft, ChevronRight, FileText, Search, Settings } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent } from 'react';
import logo from '../assets/muninn-raven-logo.png';
import {
  createBoardClient,
  DEFAULT_BACKEND_VERSION,
  resolveApiBase,
  resolveUsesDemoData,
  type PrimaryView,
  type ProjectNode,
  type ProjectSessionNode,
} from '../lib/api.js';
import {
  selectedSessionKey,
  sessionTreeCanExpand,
  type SessionContentMode,
} from '../lib/session_content_state.js';
import { asErrorMessage } from '../lib/utils.js';
import { PipelinesPage } from './PipelinesPage.js';
import { RecallPage } from './SearchPage.js';
import { SessionContentSplit } from './SessionContentSplit.js';
import { SessionTree } from './SessionTree.js';
import { SettingsPage } from './SettingsDialog.js';

type RouteState = {
  view: PrimaryView;
  memoryId: string | null;
  sessionSelectionId: string | null;
};

const navItems: Array<{ view: PrimaryView; label: string; icon: ComponentType }> = [
  { view: 'recall', label: 'Recall', icon: Search },
  { view: 'wiki', label: 'LLM Wiki', icon: BookOpen },
  { view: 'session', label: 'Session', icon: FileText },
  { view: 'pipelines', label: 'Pipelines', icon: PipelineIcon },
  { view: 'settings', label: 'Settings', icon: Settings },
];

const REPOSITORY_URL = 'https://github.com/majin1102/muninn';
const SESSION_PANE_MIN_WIDTH = 340;
const SESSION_PANE_DEFAULT_WIDTH = SESSION_PANE_MIN_WIDTH;

export function App() {
  const [apiBase] = useState(resolveApiBase);
  const [usesDemoData] = useState(resolveUsesDemoData);
  const [route, setRoute] = useState<RouteState>(() => parseRoute(window.location.hash));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sessionPaneWidth, setSessionPaneWidth] = useState(SESSION_PANE_DEFAULT_WIDTH);
  const [sessionContentMode, setSessionContentMode] = useState<SessionContentMode>('split');
  const [version, setVersion] = useState(DEFAULT_BACKEND_VERSION);
  const [projects, setProjects] = useState<ProjectNode[]>([]);
  const [projectLoading, setProjectLoading] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(() => parseRoute(window.location.hash).sessionSelectionId);
  const [activeObservationId, setActiveObservationId] = useState<string | null>(() => parseRoute(window.location.hash).memoryId);
  const [openObservationId, setOpenObservationId] = useState<string | null>(() => parseRoute(window.location.hash).memoryId);
  const [openObservationRequestId, setOpenObservationRequestId] = useState(0);
  const [focusMemoryId, setFocusMemoryId] = useState<string | null>(() => parseRoute(window.location.hash).memoryId);
  const [focusRequestId, setFocusRequestId] = useState(0);
  const [document, setDocument] = useState<MemoryDocument | null>(null);
  const [documentLoading, setDocumentLoading] = useState(false);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const contentShellRef = useRef<HTMLDivElement>(null);
  const client = useMemo(() => createBoardClient(apiBase, usesDemoData), [apiBase, usesDemoData]);
  const routeTurnMemoryId = route.memoryId ? turnMemoryIdFromObservationMemoryId(route.memoryId) : null;
  const activeTurnSession = useMemo(() => (
    routeTurnMemoryId ? findSessionForTurn(projects, routeTurnMemoryId) : null
  ), [projects, routeTurnMemoryId]);
  const documentSession = useMemo(() => (
    document ? findSessionForDocument(projects, document) : null
  ), [document, projects]);
  const selectedSession = useMemo(() => (
    selectedSessionId ? findSessionBySelection(projects, selectedSessionId) : null
  ), [projects, selectedSessionId]);
  const activeSession = activeTurnSession ?? documentSession ?? selectedSession;
  const activeSessionTurns = activeSession?.turns ?? [];
  const activeSessionSelectionId = activeSession ? selectedSessionKey(activeSession) : selectedSessionId;
  const pendingActiveSessionSearch = Boolean(
    route.memoryId
    && !activeTurnSession
    && findNextSessionToSearch(projects),
  );
  const locatingActiveTurn = Boolean(
    route.memoryId
    && !activeTurnSession
    && (pendingActiveSessionSearch || (documentSession && documentSession.nextOffset !== null)),
  );

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    void client.getVersion().then(setVersion);
  }, [client]);

  const loadProjects = useCallback(() => {
    setProjectLoading(true);
    setProjectError(null);
    client.getProjects()
      .then((nextProjects) => setProjects(nextProjects))
      .catch((error: unknown) => setProjectError(asErrorMessage(error)))
      .finally(() => setProjectLoading(false));
  }, [client]);

  useEffect(() => {
    if (route.view !== 'session') {
      return;
    }

    loadProjects();
  }, [loadProjects, route.view]);

  useEffect(() => {
    if (!routeTurnMemoryId) {
      setDocument(null);
      setDocumentError(null);
      return;
    }

    setDocumentLoading(true);
    setDocumentError(null);
    client.getDocument(routeTurnMemoryId)
      .then(setDocument)
      .catch((error: unknown) => {
        setDocument(null);
        setDocumentError(asErrorMessage(error));
      })
      .finally(() => setDocumentLoading(false));
  }, [client, routeTurnMemoryId]);

  useEffect(() => {
    if (route.view !== 'session' || !documentSession || documentSession.loaded || documentSession.loading) {
      return;
    }

    void openSession(documentSession);
  }, [documentSession, route.view]);

  useEffect(() => {
    if (route.view !== 'session' || !selectedSession || selectedSession.loaded || selectedSession.loading) {
      return;
    }

    void openSession(selectedSession);
  }, [route.view, selectedSession]);

  useEffect(() => {
    if (route.memoryId) {
      setSelectedSessionId(null);
      setActiveObservationId(route.memoryId);
      setOpenObservationId(route.memoryId);
      setOpenObservationRequestId((current) => current + 1);
      setFocusMemoryId(turnMemoryIdFromObservationMemoryId(route.memoryId));
      setFocusRequestId((current) => current + 1);
      return;
    }
    if (route.view === 'session' && route.sessionSelectionId) {
      setSelectedSessionId(route.sessionSelectionId);
      setActiveObservationId(null);
      setOpenObservationId(null);
      setOpenObservationRequestId((current) => current + 1);
      setFocusMemoryId(null);
      setFocusRequestId((current) => current + 1);
      setDocument(null);
      setDocumentError(null);
    }
  }, [route.memoryId, route.sessionSelectionId, route.view]);

  useEffect(() => {
    if (!route.memoryId || !activeTurnSession) {
      return;
    }
    setSelectedSessionId(selectedSessionKey(activeTurnSession));
  }, [activeTurnSession, route.memoryId]);

  useEffect(() => {
    if (route.view !== 'session' || !route.memoryId || activeTurnSession) {
      return;
    }

    const session = findNextSessionToSearch(projects);
    if (!session) {
      return;
    }

    void openSession(session);
  }, [activeTurnSession, projects, route.memoryId, route.view]);

  useEffect(() => {
    if (
      route.view !== 'session'
      || !documentSession
      || activeTurnSession
      || !documentSession.loaded
      || documentSession.loading
      || documentSession.nextOffset === null
    ) {
      return;
    }

    void loadMore(documentSession);
  }, [activeTurnSession, documentSession, route.view]);

  async function openSession(session: ProjectSessionNode) {
    updateSession(session, { loading: true });
    try {
      const response = await client.loadSessionTurns(session);
      updateSession(session, {
        turns: response.turns,
        segments: response.segments,
        observations: response.observations,
        sessionSummary: response.sessionSummary,
        nextOffset: response.nextOffset,
        loading: false,
        loaded: true,
      });
    } catch (error) {
      setProjectError(asErrorMessage(error));
      updateSession(session, { loading: false });
    }
  }

  async function loadMore(session: ProjectSessionNode) {
    if (session.loading || session.nextOffset === null) {
      return;
    }
    updateSession(session, { loading: true });
    try {
      const response = await client.loadSessionTurns(session, session.nextOffset);
      updateSession(session, {
        turns: [...session.turns, ...response.turns],
        segments: response.segments.length > 0 ? response.segments : session.segments,
        observations: response.observations.length > 0 ? response.observations : session.observations,
        sessionSummary: response.sessionSummary ?? session.sessionSummary,
        nextOffset: response.nextOffset,
        loading: false,
        loaded: true,
      });
    } catch (error) {
      setProjectError(asErrorMessage(error));
      updateSession(session, { loading: false });
    }
  }

  async function loadUntilTurn(session: ProjectSessionNode, memoryId: string) {
    if (hasTurn(session, memoryId) || session.nextOffset === null) {
      return;
    }

    let turns = session.turns;
    let segments = session.segments;
    let observations = session.observations;
    let sessionSummary = session.sessionSummary;
    let nextOffset: number | null = session.nextOffset;

    updateSession(session, { loading: true });
    try {
      while (!turns.some((turn) => turn.memoryId === memoryId) && nextOffset !== null) {
        const response = await client.loadSessionTurns({
          ...session,
          turns,
          segments,
          observations,
          sessionSummary,
          nextOffset,
          loaded: true,
          loading: true,
        }, nextOffset);
        turns = [...turns, ...response.turns];
        segments = response.segments.length > 0 ? response.segments : segments;
        observations = response.observations.length > 0 ? response.observations : observations;
        sessionSummary = response.sessionSummary ?? sessionSummary;
        nextOffset = response.nextOffset;
      }
      updateSession(session, {
        turns,
        segments,
        observations,
        sessionSummary,
        nextOffset,
        loading: false,
        loaded: true,
      });
    } catch (error) {
      setProjectError(asErrorMessage(error));
      updateSession(session, { loading: false });
    }
  }

  function selectSession(session: ProjectSessionNode) {
    const selectionId = selectedSessionKey(session);
    setSelectedSessionId(selectionId);
    setActiveObservationId(null);
    setOpenObservationId(null);
    setOpenObservationRequestId((current) => current + 1);
    setFocusMemoryId(null);
    setFocusRequestId((current) => current + 1);
    setDocument(null);
    setDocumentError(null);
    window.location.hash = `#/session/s/${encodeURIComponent(selectionId)}`;
    if (!session.loaded && !session.loading) {
      void openSession(session);
    }
  }

  function updateSession(session: ProjectSessionNode, patch: Partial<ProjectSessionNode>) {
    setProjects((current) => current.map((project) => ({
      ...project,
      sessions: project.sessions.map((item) => (
        sameSession(item, session)
          ? { ...item, ...patch }
          : item
      )),
    })));
  }

  function openObservationFromTree(memoryId: string, session: ProjectSessionNode) {
    setSelectedSessionId(selectedSessionKey(session));
    setActiveObservationId(memoryId);
    setOpenObservationId(memoryId);
    setOpenObservationRequestId((current) => current + 1);
    setFocusMemoryId(turnMemoryIdFromObservationMemoryId(memoryId));
    setFocusRequestId((current) => current + 1);
    window.location.hash = `#/session/${encodeURIComponent(memoryId)}`;
  }

  function openObservationInPane(memoryId: string) {
    setActiveObservationId(memoryId);
    setOpenObservationId(memoryId);
    setOpenObservationRequestId((current) => current + 1);
  }

  function locateConversationTurn(memoryId: string) {
    const session = activeSession;
    if (!session || hasTurn(session, memoryId)) {
      setFocusMemoryId(memoryId);
      setFocusRequestId((current) => current + 1);
      return;
    }

    void loadUntilTurn(session, memoryId).finally(() => {
      setFocusMemoryId(memoryId);
      setFocusRequestId((current) => current + 1);
    });
  }

  function openView(view: PrimaryView) {
    window.location.hash = `#/${view}`;
  }

  function startSessionPaneResize(event: PointerEvent<HTMLButtonElement>) {
    const shell = contentShellRef.current;
    if (!shell) {
      return;
    }

    event.preventDefault();

    const resize = (clientX: number) => {
      const rect = shell.getBoundingClientRect();
      const maxWidth = Math.max(SESSION_PANE_MIN_WIDTH, rect.width - 40);
      const nextWidth = Math.min(Math.max(clientX - rect.left, SESSION_PANE_MIN_WIDTH), maxWidth);
      setSessionPaneWidth(nextWidth);
    };

    const onPointerMove = (moveEvent: globalThis.PointerEvent) => resize(moveEvent.clientX);
    const cleanup = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', cleanup);
      window.removeEventListener('pointercancel', cleanup);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', cleanup, { once: true });
    window.addEventListener('pointercancel', cleanup, { once: true });
  }

  function startSessionPaneMouseResize(event: ReactMouseEvent<HTMLButtonElement>) {
    const shell = contentShellRef.current;
    if (!shell) {
      return;
    }

    event.preventDefault();

    const resize = (clientX: number) => {
      const rect = shell.getBoundingClientRect();
      const maxWidth = Math.max(SESSION_PANE_MIN_WIDTH, rect.width - 40);
      const nextWidth = Math.min(Math.max(clientX - rect.left, SESSION_PANE_MIN_WIDTH), maxWidth);
      setSessionPaneWidth(nextWidth);
    };

    const onMouseMove = (moveEvent: MouseEvent) => resize(moveEvent.clientX);
    const cleanup = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', cleanup);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', cleanup, { once: true });
  }

  return (
    <div className="app-shell">
      <aside className={sidebarCollapsed ? 'app-sidebar app-sidebar-collapsed' : 'app-sidebar'}>
        <div className="sidebar-header">
          <img className="brand-logo" src={logo} alt="" aria-hidden="true" />
          <span className="brand-name">Muninn</span>
        </div>
        <nav className="sidebar-nav" aria-label="Main navigation">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = route.view === item.view;
            return (
              <button
                key={item.view}
                className={active ? 'sidebar-nav-item sidebar-nav-item-active' : 'sidebar-nav-item'}
                type="button"
                onClick={() => openView(item.view)}
                title={item.label}
              >
                <Icon />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <button
          className="sidebar-collapse-button"
          type="button"
          aria-label="Toggle sidebar"
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
        >
          {sidebarCollapsed ? <ChevronRight /> : <ChevronLeft />}
        </button>
        <div className="sidebar-footer">
          <a className="sidebar-footer-link sidebar-footer-icon-link" href={REPOSITORY_URL} target="_blank" rel="noreferrer" aria-label="Open GitHub repository">
            <GitHubMark />
          </a>
          <a className="sidebar-footer-link sidebar-version-link" href={releaseUrl(version)} target="_blank" rel="noreferrer" aria-label={`Open release ${releaseTag(version)}`}>
            v{version}
          </a>
        </div>
      </aside>

      <main className="app-main">
        <div
          ref={contentShellRef}
          className={sessionContentMode === 'collapsed' ? 'content-shell content-shell-session-tree-collapsed' : 'content-shell'}
          style={{ '--session-pane-width': `${sessionPaneWidth}px` } as CSSProperties}
        >
          {route.view === 'session' ? (
            <>
              {sessionContentMode !== 'collapsed' ? (
                <aside className="project-pane">
                <SessionTree
                  projects={projects}
                  selectedSessionId={activeSessionSelectionId}
                  activeMemoryId={activeObservationId}
                  canExpandSessions={sessionTreeCanExpand(sessionContentMode)}
                  loading={projectLoading}
                  error={projectError}
                  onOpenSession={selectSession}
                  onLoadSession={(session) => {
                    if (!session.loaded && !session.loading) {
                      void openSession(session);
                    }
                  }}
                  onOpenTurn={openObservationFromTree}
                  onLoadMore={loadMore}
                />
                  <button
                    className="session-pane-resizer"
                    type="button"
                    aria-label="Resize session pane"
                    onPointerDown={startSessionPaneResize}
                    onMouseDown={startSessionPaneMouseResize}
                  />
                </aside>
              ) : null}
              <section className="conversation-pane">
                <SessionContentSplit
                  session={activeSession}
                  document={document}
                  activeObservationId={activeObservationId}
                  openObservationId={openObservationId}
                  openObservationRequestId={openObservationRequestId}
                  focusMemoryId={focusMemoryId}
                  focusRequestId={focusRequestId}
                  sessionTurns={activeSessionTurns}
                  mode={sessionContentMode}
                  onModeChange={setSessionContentMode}
                  onActiveObservationChange={setActiveObservationId}
                  onOpenObservation={openObservationInPane}
                  onLocateConversationTurn={locateConversationTurn}
                  canLoadMoreAfter={Boolean(activeSession && activeSession.nextOffset !== null)}
                  loadingMoreAfter={activeSession?.loading ?? false}
                  onLoadMoreAfter={() => {
                    if (activeSession) {
                      void loadMore(activeSession);
                    }
                  }}
                  loading={documentLoading || locatingActiveTurn}
                  error={documentError}
                />
              </section>
            </>
          ) : (
            <section className={route.view === 'settings' ? 'single-pane settings-pane' : 'single-pane'}>
              {route.view === 'settings' ? (
                <SettingsPage client={client} />
              ) : route.view === 'pipelines' ? (
                <PipelinesPage client={client} />
              ) : route.view === 'recall' ? (
                <RecallPage
                  client={client}
                  projects={projects}
                  projectsLoading={projectLoading}
                  projectError={projectError}
                  onLoadProjects={loadProjects}
                />
              ) : (
                <EmptyView view={route.view} />
              )}
            </section>
          )}
        </div>
      </main>
    </div>
  );
}

function findSessionForTurn(projects: ProjectNode[], memoryId: string): ProjectNode['sessions'][number] | null {
  for (const project of projects) {
    for (const session of project.sessions) {
      if (session.turns.some((turn) => turn.memoryId === memoryId)) {
        return session;
      }
    }
  }
  return null;
}

function findSessionForDocument(projects: ProjectNode[], document: MemoryDocument): ProjectNode['sessions'][number] | null {
  if (!document.sessionId) {
    return null;
  }

  for (const project of projects) {
    for (const session of project.sessions) {
      if (
        session.sessionKey === document.sessionId
        && session.agent === document.agent
        && (!document.cwd || session.cwd === document.cwd)
      ) {
        return session;
      }
    }
  }
  return null;
}

function findSessionBySelection(projects: ProjectNode[], selection: string): ProjectNode['sessions'][number] | null {
  for (const project of projects) {
    for (const session of project.sessions) {
      if (selectedSessionKey(session) === selection) {
        return session;
      }
    }
  }
  return null;
}

function findNextSessionToSearch(projects: ProjectNode[]): ProjectNode['sessions'][number] | null {
  for (const project of projects) {
    for (const session of project.sessions) {
      if (!session.loaded && !session.loading) {
        return session;
      }
    }
  }
  return null;
}

function sameSession(left: ProjectSessionNode, right: ProjectSessionNode): boolean {
  return left.agent === right.agent
    && (left.cwd ?? '') === (right.cwd ?? '')
    && left.sessionKey === right.sessionKey;
}

function hasTurn(session: ProjectSessionNode, memoryId: string): boolean {
  return session.turns.some((turn) => turn.memoryId === memoryId);
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.67 0 8.2c0 3.63 2.29 6.71 5.47 7.8.4.08.55-.18.55-.4 0-.2-.01-.87-.01-1.58-2.01.38-2.53-.5-2.69-.95-.09-.24-.48-.99-.82-1.19-.28-.16-.68-.56-.01-.57.63-.01 1.08.59 1.23.84.72 1.25 1.87.9 2.33.68.07-.54.28-.9.5-1.11-1.78-.21-3.64-.92-3.64-4.07 0-.9.31-1.64.82-2.22-.08-.21-.36-1.05.08-2.18 0 0 .67-.22 2.2.85.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.07 2.2-.85 2.2-.85.44 1.13.16 1.97.08 2.18.51.58.82 1.31.82 2.22 0 3.16-1.87 3.86-3.65 4.07.29.26.54.75.54 1.52 0 1.1-.01 1.98-.01 2.25 0 .22.15.49.55.4A8.176 8.176 0 0 0 16 8.2C16 3.67 12.42 0 8 0Z" />
    </svg>
  );
}

function PipelineIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2">
      <path d="M7 6v12" />
      <path d="M13 6v12" />
      <path d="m18 9 3 3-3 3" />
    </svg>
  );
}

function releaseUrl(version: string): string {
  return `${REPOSITORY_URL}/releases/tag/${encodeURIComponent(releaseTag(version))}`;
}

function releaseTag(version: string): string {
  return version.startsWith('v') ? version : `v${version}`;
}

function EmptyView({ view }: { view: PrimaryView }) {
  if (view === 'recall') {
    return (
      <div className="empty-panel">
        <Search />
        <p>Recall is ready.</p>
      </div>
    );
  }

  return (
    <div className="empty-panel">
      <BookOpen />
      <p>LLM Wiki is empty for now.</p>
    </div>
  );
}

function parseRoute(hash: string): RouteState {
  const value = hash.replace(/^#\/?/, '');
  const parts = value.split('/').filter(Boolean);
  const view = parts[0] as PrimaryView | undefined;

  if (view === 'recall' || view === 'wiki' || view === 'pipelines' || view === 'settings') {
    return { view, memoryId: null, sessionSelectionId: null };
  }

  if (parts[1] === 's') {
    return {
      view: 'session',
      memoryId: null,
      sessionSelectionId: parts[2] ? decodeURIComponent(parts.slice(2).join('/')) : null,
    };
  }

  return {
    view: 'session',
    memoryId: parts[1] ? decodeURIComponent(parts.slice(1).join('/')) : null,
    sessionSelectionId: null,
  };
}

function turnMemoryIdFromObservationMemoryId(memoryId: string): string {
  return memoryId.split('~observation:')[0] ?? memoryId;
}
