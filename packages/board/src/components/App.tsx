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
import { asErrorMessage } from '../lib/utils.js';
import { ChatView } from './ChatView.js';
import { PipelinesPage } from './PipelinesPage.js';
import { SessionTree } from './SessionTree.js';
import { SettingsPage } from './SettingsDialog.js';

type RouteState = {
  view: PrimaryView;
  memoryId: string | null;
};

const navItems: Array<{ view: PrimaryView; label: string; icon: ComponentType }> = [
  { view: 'search', label: 'Search', icon: Search },
  { view: 'wiki', label: 'LLM Wiki', icon: BookOpen },
  { view: 'session', label: 'Session', icon: FileText },
  { view: 'pipelines', label: 'Pipelines', icon: PipelineIcon },
  { view: 'settings', label: 'Settings', icon: Settings },
];

const REPOSITORY_URL = 'https://github.com/majin1102/muninn';
const SESSION_PANE_MIN_WIDTH = 400;

export function App() {
  const [apiBase] = useState(resolveApiBase);
  const [usesDemoData] = useState(resolveUsesDemoData);
  const [route, setRoute] = useState<RouteState>(() => parseRoute(window.location.hash));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sessionPaneWidth, setSessionPaneWidth] = useState(SESSION_PANE_MIN_WIDTH);
  const [version, setVersion] = useState(DEFAULT_BACKEND_VERSION);
  const [projects, setProjects] = useState<ProjectNode[]>([]);
  const [projectLoading, setProjectLoading] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [document, setDocument] = useState<MemoryDocument | null>(null);
  const [documentLoading, setDocumentLoading] = useState(false);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const contentShellRef = useRef<HTMLDivElement>(null);
  const client = useMemo(() => createBoardClient(apiBase, usesDemoData), [apiBase, usesDemoData]);
  const activeTurnSession = useMemo(() => (
    route.memoryId ? findSessionForTurn(projects, route.memoryId) : null
  ), [projects, route.memoryId]);
  const documentSession = useMemo(() => (
    document ? findSessionForDocument(projects, document) : null
  ), [document, projects]);
  const activeSession = activeTurnSession ?? documentSession;
  const activeSessionTurns = activeSession?.turns ?? [];
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
    if (!route.memoryId) {
      setDocument(null);
      setDocumentError(null);
      return;
    }

    setDocumentLoading(true);
    setDocumentError(null);
    client.getDocument(route.memoryId)
      .then(setDocument)
      .catch((error: unknown) => {
        setDocument(null);
        setDocumentError(asErrorMessage(error));
      })
      .finally(() => setDocumentLoading(false));
  }, [client, route.memoryId]);

  useEffect(() => {
    if (route.view !== 'session' || !documentSession || documentSession.loaded || documentSession.loading) {
      return;
    }

    void openSession(documentSession);
  }, [documentSession, route.view]);

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
        nextOffset: response.nextOffset,
        loading: false,
        loaded: true,
      });
    } catch (error) {
      setProjectError(asErrorMessage(error));
      updateSession(session, { loading: false });
    }
  }

  function updateSession(session: ProjectSessionNode, patch: Partial<ProjectSessionNode>) {
    setProjects((current) => current.map((project) => ({
      ...project,
      sessions: project.sessions.map((item) => (
        item.agent === session.agent && item.sessionKey === session.sessionKey
          ? { ...item, ...patch }
          : item
      )),
    })));
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
          className="content-shell"
          style={{ '--session-pane-width': `${sessionPaneWidth}px` } as CSSProperties}
        >
          {route.view === 'session' ? (
            <>
              <aside className="project-pane">
                <SessionTree
                  projects={projects}
                  activeMemoryId={route.memoryId}
                  loading={projectLoading}
                  error={projectError}
                  onOpenSession={openSession}
                  onOpenTurn={(memoryId) => {
                    window.location.hash = `#/session/${encodeURIComponent(memoryId)}`;
                  }}
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
              <section className="conversation-pane">
                <ChatView
                  document={document}
                  activeMemoryId={route.memoryId}
                  sessionTurns={activeSessionTurns}
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
      if (session.sessionKey === document.sessionId && session.agent === document.agent) {
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
  if (view === 'search') {
    return (
      <div className="empty-panel">
        <Search />
        <p>Search is ready for recall results.</p>
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

  if (view === 'search' || view === 'wiki' || view === 'pipelines' || view === 'settings') {
    return { view, memoryId: null };
  }

  return {
    view: 'session',
    memoryId: parts[1] ? decodeURIComponent(parts.slice(1).join('/')) : null,
  };
}
