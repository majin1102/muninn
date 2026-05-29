import type { MemoryDocument } from '@muninn/types';
import { BookOpen, Github, Library, PanelLeft, Search, Settings, SlidersHorizontal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import logo from '../assets/muninn-logo.png';
import {
  createBoardClient,
  DEFAULT_BACKEND_VERSION,
  resolveApiBase,
  resolveDataMode,
  type DataMode,
  type PrimaryView,
  type ProjectNode,
  type ProjectSessionNode,
} from '../lib/api.js';
import { asErrorMessage } from '../lib/utils.js';
import { ChatView } from './ChatView.js';
import { SessionTree } from './SessionTree.js';
import { SettingsDialog } from './SettingsDialog.js';
import { Button } from './ui/button.js';
import { ScrollArea } from './ui/scroll-area.js';

type RouteState = {
  view: PrimaryView;
  memoryId: string | null;
};

const navItems: Array<{ view: PrimaryView; label: string; icon: typeof Search }> = [
  { view: 'search', label: 'Search', icon: Search },
  { view: 'wiki', label: 'LLM Wiki', icon: BookOpen },
  { view: 'session', label: 'Session', icon: Library },
  { view: 'settings', label: 'Settings', icon: Settings },
];

export function App() {
  const [apiBase] = useState(resolveApiBase);
  const [dataMode, setDataMode] = useState<DataMode>(resolveDataMode);
  const [route, setRoute] = useState<RouteState>(() => parseRoute(window.location.hash));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [version, setVersion] = useState(DEFAULT_BACKEND_VERSION);
  const [projects, setProjects] = useState<ProjectNode[]>([]);
  const [projectLoading, setProjectLoading] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [document, setDocument] = useState<MemoryDocument | null>(null);
  const [documentLoading, setDocumentLoading] = useState(false);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const client = useMemo(() => createBoardClient(apiBase, dataMode), [apiBase, dataMode]);

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    void client.getVersion().then(setVersion);
  }, [client]);

  useEffect(() => {
    if (route.view === 'settings') {
      setSettingsOpen(true);
      window.location.hash = '#/session';
    }
  }, [route.view]);

  useEffect(() => {
    if (route.view !== 'session') {
      return;
    }

    setProjectLoading(true);
    setProjectError(null);
    client.getProjects()
      .then((nextProjects) => setProjects(nextProjects))
      .catch((error: unknown) => setProjectError(asErrorMessage(error)))
      .finally(() => setProjectLoading(false));
  }, [client, route.view]);

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

  async function openSession(session: ProjectSessionNode) {
    updateSession(session, { loading: true });
    try {
      const response = await client.loadSessionTurns(session);
      updateSession(session, {
        turns: response.turns,
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

  function setMode(nextMode: DataMode) {
    setDataMode(nextMode);
    localStorage.setItem('muninn.board.dataMode', nextMode);
    setProjects([]);
    setDocument(null);
    const url = new URL(window.location.href);
    if (nextMode === 'live') {
      url.searchParams.delete('demo');
    } else {
      url.searchParams.set('demo', '1');
    }
    window.history.replaceState({}, '', url.toString());
  }

  function openView(view: PrimaryView) {
    if (view === 'settings') {
      setSettingsOpen(true);
      return;
    }
    window.location.hash = `#/${view}`;
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
            const active = route.view === item.view || (item.view === 'settings' && settingsOpen);
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
      </aside>

      <main className="app-main">
        <header className="app-header">
          <div className="app-header-left">
            <Button variant="ghost" size="icon" aria-label="Toggle sidebar" onClick={() => setSidebarCollapsed(!sidebarCollapsed)}>
              <PanelLeft />
            </Button>
            <span className="header-section-title">{titleForView(route.view)}</span>
          </div>
          <div className="app-header-actions">
            <div className="mode-toggle" role="group" aria-label="Data mode">
              {(['live', 'tree', 'card'] as DataMode[]).map((mode) => (
                <button
                  key={mode}
                  className={dataMode === mode ? 'mode-toggle-button mode-toggle-button-active' : 'mode-toggle-button'}
                  type="button"
                  onClick={() => setMode(mode)}
                >
                  {mode === 'live' ? 'Live' : mode === 'tree' ? 'Tree' : 'Card'}
                </button>
              ))}
            </div>
            <button className="header-text-action" type="button" onClick={() => setSettingsOpen(true)}>
              <SlidersHorizontal />
              Settings
            </button>
            <a className="header-link" href="https://github.com/majin1102/muninn/releases" target="_blank" rel="noreferrer">
              Version: {version}
            </a>
            <a className="header-icon-link" href="https://github.com/majin1102/muninn" target="_blank" rel="noreferrer" aria-label="Open GitHub repository">
              <Github />
            </a>
          </div>
        </header>

        <div className="content-shell">
          {route.view === 'session' ? (
            <>
              <aside className="project-pane">
                <ScrollArea className="project-scroll">
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
                </ScrollArea>
              </aside>
              <section className="conversation-pane">
                <ChatView document={document} loading={documentLoading} error={documentError} />
              </section>
            </>
          ) : (
            <section className="single-pane">
              <EmptyView view={route.view} />
            </section>
          )}
        </div>
      </main>

      <SettingsDialog client={client} open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
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

  if (view === 'search' || view === 'wiki' || view === 'settings') {
    return { view, memoryId: null };
  }

  return {
    view: 'session',
    memoryId: parts[1] ? decodeURIComponent(parts.slice(1).join('/')) : null,
  };
}

function titleForView(view: PrimaryView): string {
  if (view === 'search') {
    return 'Search';
  }
  if (view === 'wiki') {
    return 'LLM Wiki';
  }
  return 'Session';
}
