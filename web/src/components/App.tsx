import type { MemoryDocument, ProjectDreamView } from '@muninn/common';
import { BookOpen, ChevronLeft, ChevronRight, FileText, Search, Settings } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent } from 'react';
import logo from '../assets/muninn-raven-logo.png';
import {
  createAppClient,
  DEFAULT_BACKEND_VERSION,
  isProjectDreamingSession,
  resolveApiBase,
  resolveUsesDemoData,
  type PrimaryView,
  type ProjectNode,
  type ProjectSessionNode,
  type ProjectTurnNode,
} from '../lib/api.js';
import {
  selectedSessionKey,
  sessionTreeCanExpand,
  type SessionContentMode,
} from '../lib/session-content-state.js';
import { asErrorMessage } from '../lib/utils.js';
import { PipelinesPage } from './PipelinesPage.js';
import { RecallPage } from './SearchPage.js';
import { SessionContentSplit } from './SessionContentSplit.js';
import { SessionTree } from './SessionTree.js';
import { SettingsPage } from './SettingsPage.js';
import { EmptyState } from './ui/empty-state.js';
import { DreamingContent } from './DreamingContent.js';

type RouteState = {
  view: PrimaryView;
  memoryId: string | null;
  sessionSelectionId: string | null;
};

const navItems: Array<{ view: PrimaryView; label: string; icon: ComponentType }> = [
  { view: 'recall', label: 'Recall', icon: Search },
  { view: 'session', label: 'Session', icon: FileText },
  { view: 'wiki', label: 'LLM Wiki', icon: BookOpen },
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
  const [activeTimelineId, setActiveTimelineId] = useState<string | null>(() => parseRoute(window.location.hash).memoryId);
  const [openTimelineId, setOpenTimelineId] = useState<string | null>(() => parseRoute(window.location.hash).memoryId);
  const [openTimelineRequestId, setOpenTimelineRequestId] = useState(0);
  const [focusMemoryId, setFocusMemoryId] = useState<string | null>(() => parseRoute(window.location.hash).memoryId);
  const [focusRequestId, setFocusRequestId] = useState(0);
  const [document, setDocument] = useState<MemoryDocument | null>(null);
  const [documentLoading, setDocumentLoading] = useState(false);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [projectDreams, setProjectDreams] = useState<Record<string, {
    dream: ProjectDreamView | null;
    loading: boolean;
  }>>({});
  const contentShellRef = useRef<HTMLDivElement>(null);
  const client = useMemo(() => createAppClient(apiBase, usesDemoData), [apiBase, usesDemoData]);
  const routeTurnMemoryId = route.memoryId ? turnMemoryIdFromTimelineMemoryId(route.memoryId) : null;
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
    if (route.view !== 'session' || !selectedSession) {
      return;
    }
    if (isProjectDreamingSession(selectedSession)) {
      if (!projectDreams[selectedSession.projectKey]?.loading && !projectDreams[selectedSession.projectKey]?.dream) {
        void openProjectDream(selectedSession);
      }
      return;
    }
    if (selectedSession.loaded || selectedSession.loading) {
      return;
    }

    void openSession(selectedSession);
  }, [projectDreams, route.view, selectedSession]);

  useEffect(() => {
    if (route.memoryId) {
      setSelectedSessionId(null);
      setActiveTimelineId(route.memoryId);
      setOpenTimelineId(route.memoryId);
      setOpenTimelineRequestId((current) => current + 1);
      setFocusMemoryId(turnMemoryIdFromTimelineMemoryId(route.memoryId));
      setFocusRequestId((current) => current + 1);
      return;
    }
    if (route.view === 'session' && route.sessionSelectionId) {
      setSelectedSessionId(route.sessionSelectionId);
      setActiveTimelineId(null);
      setOpenTimelineId(null);
      setOpenTimelineRequestId((current) => current + 1);
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
    if (
      route.view !== 'session'
      || !route.memoryId
      || activeTurnSession
      || selectedSessionId
      || documentLoading
      || documentSession
    ) {
      return;
    }

    const session = findNextSessionToSearch(projects);
    if (!session) {
      return;
    }

    void openSession(session);
  }, [activeTurnSession, documentLoading, documentSession, projects, route.memoryId, route.view, selectedSessionId]);

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
    if (isProjectDreamingSession(session)) {
      await openProjectDream(session);
      return;
    }
    const timelinePromise = loadSessionTimeline(session);
    updateSession(session, { loading: true });
    try {
      const response = await client.loadSessionTurns(session);
      updateSession(session, {
        turns: response.turns,
        nextOffset: response.nextOffset,
        loading: false,
        loaded: true,
      });
      void timelinePromise;
    } catch (error) {
      setProjectError(asErrorMessage(error));
      updateSession(session, { loading: false });
    }
  }

  async function loadSessionTimeline(session: ProjectSessionNode) {
    if (session.timelineLoading || session.timelineLoaded) {
      return;
    }
    updateSession(session, { timelineLoading: true });
    try {
      const response = await client.loadSessionTimeline(session);
      updateSession(session, {
        segments: response.segments,
        timeline: response.timeline,
        timelineLoading: false,
        timelineLoaded: true,
      });
    } catch (error) {
      setProjectError(asErrorMessage(error));
      updateSession(session, { timelineLoading: false });
    }
  }

  async function openProjectDream(session: ProjectSessionNode) {
    setProjectDreams((current) => ({
      ...current,
      [session.projectKey]: {
        dream: current[session.projectKey]?.dream ?? null,
        loading: true,
      },
    }));
    try {
      const dream = await client.getProjectDream(session.projectKey);
      setProjectDreams((current) => ({
        ...current,
        [session.projectKey]: {
          dream,
          loading: false,
        },
      }));
    } catch (error) {
      setProjectError(asErrorMessage(error));
      setProjectDreams((current) => ({
        ...current,
        [session.projectKey]: {
          dream: current[session.projectKey]?.dream ?? null,
          loading: false,
        },
      }));
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
        turns: mergeSessionTurns(session.turns, response.turns),
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
    if (hasTurn(session, memoryId)) {
      return;
    }

    updateSession(session, { loading: true });
    try {
      const offset = await client.locateSessionTurn(session, memoryId);
      const response = await client.loadSessionTurns(session, offset);
      updateSession(session, {
        turns: mergeSessionTurns(session.turns, response.turns),
        nextOffset: response.nextOffset,
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
    setActiveTimelineId(null);
    setOpenTimelineId(null);
    setOpenTimelineRequestId((current) => current + 1);
    setFocusMemoryId(null);
    setFocusRequestId((current) => current + 1);
    setDocument(null);
    setDocumentError(null);
    window.location.hash = `#/session/s/${encodeURIComponent(selectionId)}`;
    if (isProjectDreamingSession(session)) {
      const currentDream = projectDreams[session.projectKey];
      if (!currentDream?.loading && !currentDream?.dream) {
        void openProjectDream(session);
      }
      return;
    }
    if (!session.loaded && !session.loading) {
      void openSession(session);
    } else if (!session.timelineLoaded && !session.timelineLoading) {
      void loadSessionTimeline(session);
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

  function openTimelineFromTree(memoryId: string, session: ProjectSessionNode) {
    setSelectedSessionId(selectedSessionKey(session));
    setActiveTimelineId(memoryId);
    setOpenTimelineId(memoryId);
    setOpenTimelineRequestId((current) => current + 1);
    setFocusMemoryId(turnMemoryIdFromTimelineMemoryId(memoryId));
    setFocusRequestId((current) => current + 1);
    window.location.hash = `#/session/${encodeURIComponent(memoryId)}`;
  }

  function openTimelineInPane(memoryId: string) {
    setActiveTimelineId(memoryId);
    setOpenTimelineId(memoryId);
    setOpenTimelineRequestId((current) => current + 1);
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
                  activeMemoryId={activeTimelineId}
                  canExpandSessions={sessionTreeCanExpand(sessionContentMode)}
                  loading={projectLoading}
                  error={projectError}
                  onOpenSession={selectSession}
                  onLoadSession={(session) => {
                    if (!session.loaded && !session.loading) {
                      void openSession(session);
                    } else if (!session.timelineLoaded && !session.timelineLoading) {
                      void loadSessionTimeline(session);
                    }
                  }}
                  onOpenTurn={openTimelineFromTree}
                  onLoadMore={loadMore}
                  onImportSessions={() => {
                    window.location.hash = '#/settings?mode=import&pipeline=extractor';
                  }}
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
                {activeSession && isProjectDreamingSession(activeSession) ? (
                  <DreamingContent
                    projectLabel={projectLabelForSession(projects, activeSession)}
                    dream={projectDreams[activeSession.projectKey]?.dream ?? null}
                    loading={projectDreams[activeSession.projectKey]?.loading ?? false}
                  />
                ) : (
                  <SessionContentSplit
                  session={activeSession}
                  document={document}
                  activeTimelineId={activeTimelineId}
                  openTimelineId={openTimelineId}
                  openTimelineRequestId={openTimelineRequestId}
                  focusMemoryId={focusMemoryId}
                  focusRequestId={focusRequestId}
                  sessionTurns={activeSessionTurns}
                  mode={sessionContentMode}
                  onModeChange={setSessionContentMode}
                  onActiveTimelineChange={setActiveTimelineId}
                  onOpenTimeline={openTimelineInPane}
                  onLocateConversationTurn={locateConversationTurn}
                  onLoadTurnDetail={(memoryId) => {
                    if (!activeSession) {
                      return Promise.reject(new Error('No active session'));
                    }
                    return client.loadTurnDetail(activeSession, memoryId);
                  }}
                  canLoadMoreAfter={Boolean(activeSession && activeSession.nextOffset !== null)}
                  loadingMoreAfter={activeSession?.loading ?? false}
                  onLoadMoreAfter={() => {
                    if (activeSession) {
                      void loadMore(activeSession);
                    }
                  }}
                  loading={documentLoading || locatingActiveTurn || Boolean(activeSession?.loading && !activeSession.loaded)}
                  timelineLoading={Boolean(activeSession?.timelineLoading && !activeSession.timelineLoaded)}
                  error={documentError}
                />
                )}
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
        && (!document.project || session.projectKey === document.project)
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
      if (isProjectDreamingSession(session)) {
        continue;
      }
      if (!session.loaded && !session.loading) {
        return session;
      }
    }
  }
  return null;
}

function projectLabelForSession(projects: ProjectNode[], session: ProjectSessionNode): string {
  return projects.find((project) => project.projectKey === session.projectKey)?.label ?? session.projectKey;
}

function sameSession(left: ProjectSessionNode, right: ProjectSessionNode): boolean {
  return left.agent === right.agent
    && left.projectKey === right.projectKey
    && left.sessionKey === right.sessionKey;
}

function hasTurn(session: ProjectSessionNode, memoryId: string): boolean {
  return session.turns.some((turn) => turn.memoryId === memoryId);
}

function mergeSessionTurns(existing: ProjectTurnNode[], incoming: ProjectTurnNode[]): ProjectTurnNode[] {
  const byId = new Map<string, ProjectTurnNode>();
  for (const turn of [...existing, ...incoming]) {
    byId.set(turn.memoryId, turn);
  }
  return [...byId.values()].sort((left, right) => {
    const created = left.createdAt.localeCompare(right.createdAt);
    if (created !== 0) {
      return created;
    }
    const updated = left.updatedAt.localeCompare(right.updatedAt);
    if (updated !== 0) {
      return updated;
    }
    return left.memoryId.localeCompare(right.memoryId);
  });
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
      <EmptyState className="content-empty-panel" icon={Search} title="Recall is ready." variant="passive" />
    );
  }

  return (
    <EmptyState className="content-empty-panel" icon={BookOpen} title="LLM Wiki is empty for now." variant="passive" />
  );
}

function parseRoute(hash: string): RouteState {
  const value = hash.replace(/^#\/?/, '');
  const [path] = value.split('?');
  const parts = path.split('/').filter(Boolean);
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

function turnMemoryIdFromTimelineMemoryId(memoryId: string): string {
  const timelineIndex = memoryId.indexOf('~timeline');
  return timelineIndex >= 0 ? memoryId.slice(0, timelineIndex) : memoryId;
}
