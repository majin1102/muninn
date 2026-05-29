import { ChevronRight, Folder, MessageSquare } from 'lucide-react';
import type { ProjectNode, ProjectSessionNode } from '../lib/api.js';
import { formatTime, formatTimestamp } from '../lib/utils.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible.js';
import { Button } from './ui/button.js';

type SessionTreeProps = {
  projects: ProjectNode[];
  activeMemoryId: string | null;
  loading: boolean;
  error: string | null;
  onOpenSession: (session: ProjectSessionNode) => void;
  onOpenTurn: (memoryId: string) => void;
  onLoadMore: (session: ProjectSessionNode) => void;
};

export function SessionTree({
  projects,
  activeMemoryId,
  loading,
  error,
  onOpenSession,
  onOpenTurn,
  onLoadMore,
}: SessionTreeProps) {
  if (loading && projects.length === 0) {
    return <div className="sidebar-empty">Loading projects...</div>;
  }

  if (error && projects.length === 0) {
    return <div className="sidebar-error">{error}</div>;
  }

  if (projects.length === 0) {
    return <div className="sidebar-empty">No sessions yet.</div>;
  }

  return (
    <div className="session-tree">
      {projects.map((project) => (
        <Collapsible key={project.projectKey} defaultOpen className="tree-group">
          <CollapsibleTrigger className="tree-trigger tree-trigger-project">
            <span className="tree-trigger-main">
              <ChevronRight className="tree-chevron" />
              <Folder className="tree-icon" />
              <span>{project.label}</span>
            </span>
            <span className="tree-meta">{formatTimestamp(project.latestUpdatedAt)}</span>
          </CollapsibleTrigger>
          <CollapsibleContent className="tree-children">
            {project.sessions.map((session) => (
              <Collapsible key={`${session.agent}:${session.sessionKey}`} className="tree-group">
                <CollapsibleTrigger
                  className="tree-trigger tree-trigger-session"
                  onClick={() => {
                    if (!session.loaded && !session.loading) {
                      onOpenSession(session);
                    }
                  }}
                >
                  <span className="tree-trigger-main">
                    <ChevronRight className="tree-chevron" />
                    <span>{session.displaySessionId}</span>
                  </span>
                  <span className="tree-meta">{session.agent}</span>
                </CollapsibleTrigger>
                <CollapsibleContent className="turn-list">
                  {session.loading && session.turns.length === 0 ? (
                    <div className="turn-empty">Loading turns...</div>
                  ) : null}
                  {session.turns.map((turn) => (
                    <button
                      key={turn.memoryId}
                      className={activeMemoryId === turn.memoryId ? 'turn-item turn-item-active' : 'turn-item'}
                      type="button"
                      onClick={() => onOpenTurn(turn.memoryId)}
                    >
                      <span className="turn-time">{formatTime(turn.updatedAt)}</span>
                      <MessageSquare className="turn-icon" />
                      <span className="turn-summary">{turn.title ?? turn.summary}</span>
                    </button>
                  ))}
                  {session.nextOffset !== null ? (
                    <Button variant="ghost" size="sm" className="load-more" onClick={() => onLoadMore(session)}>
                      {session.loading ? 'Loading...' : 'More'}
                    </Button>
                  ) : null}
                </CollapsibleContent>
              </Collapsible>
            ))}
          </CollapsibleContent>
        </Collapsible>
      ))}
    </div>
  );
}
