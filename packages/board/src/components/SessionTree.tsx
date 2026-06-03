import { Bot, Check, ChevronDown, ChevronRight, Folder, MessageSquare, Search, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import claudeLogoUrl from '../assets/agent-claude.svg';
import codexLogoUrl from '../assets/agent-codex.svg';
import openclawLogoUrl from '../assets/agent-openclaw.svg';
import type { ProjectNode, ProjectSegmentNode, ProjectSessionNode, ProjectTurnNode } from '../lib/api.js';
import { formatRelativeTime, formatTimelineTime, formatTimestamp } from '../lib/utils.js';
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

type TimePreset = 'all' | 'last_6h' | 'last_24h' | 'last_7d' | 'last_30d' | 'custom';
type SortDirection = 'asc' | 'desc';

type SessionToolbarState = {
  selectedAgents: string[];
  timePreset: TimePreset;
  sortDirection: SortDirection;
  customFromDate: string;
  customFromTime: string;
  customToDate: string;
  customToTime: string;
};

const SESSION_TOOLBAR_STORAGE_KEY = 'muninn:board:session-toolbar-filter:v1';
const TURN_LIST_PAGE_SIZE = 20;

export function SessionTree({
  projects,
  activeMemoryId,
  loading,
  error,
  onOpenSession,
  onOpenTurn,
  onLoadMore,
}: SessionTreeProps) {
  const initialToolbarState = useRef<SessionToolbarState>(loadSessionToolbarState());
  const [query, setQuery] = useState('');
  const [selectedAgents, setSelectedAgents] = useState<string[]>(() => initialToolbarState.current.selectedAgents);
  const [agentFilterOpen, setAgentFilterOpen] = useState(false);
  const [timeFilterOpen, setTimeFilterOpen] = useState(false);
  const [timePreset, setTimePreset] = useState<TimePreset>(() => initialToolbarState.current.timePreset);
  const [sortDirection, setSortDirection] = useState<SortDirection>(() => initialToolbarState.current.sortDirection);
  const [customFromDate, setCustomFromDate] = useState(() => initialToolbarState.current.customFromDate);
  const [customFromTime, setCustomFromTime] = useState(() => initialToolbarState.current.customFromTime);
  const [customToDate, setCustomToDate] = useState(() => initialToolbarState.current.customToDate);
  const [customToTime, setCustomToTime] = useState(() => initialToolbarState.current.customToTime);
  const [draftTimePreset, setDraftTimePreset] = useState<TimePreset>(() => initialToolbarState.current.timePreset);
  const [draftSortDirection, setDraftSortDirection] = useState<SortDirection>(() => initialToolbarState.current.sortDirection);
  const [draftCustomFromDate, setDraftCustomFromDate] = useState(() => initialToolbarState.current.customFromDate);
  const [draftCustomFromTime, setDraftCustomFromTime] = useState(() => initialToolbarState.current.customFromTime);
  const [draftCustomToDate, setDraftCustomToDate] = useState(() => initialToolbarState.current.customToDate);
  const [draftCustomToTime, setDraftCustomToTime] = useState(() => initialToolbarState.current.customToTime);
  const [openProjects, setOpenProjects] = useState<Record<string, boolean>>({});
  const [openSessions, setOpenSessions] = useState<Record<string, boolean>>({});
  const [expandedTurnLists, setExpandedTurnLists] = useState<Record<string, number>>({});
  const activeRef = useRef<HTMLButtonElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);

  const agents = useMemo(() => uniqueAgents(projects), [projects]);
  const timeRange = useMemo(() => resolveTimeRange(timePreset, customFromDate, customFromTime, customToDate, customToTime), [
    customFromDate,
    customFromTime,
    customToDate,
    customToTime,
    timePreset,
  ]);
  const filteredProjects = useMemo(() => filterProjects(projects, {
    query,
    selectedAgents,
    sortDirection,
    timeRange,
  }), [projects, query, selectedAgents, sortDirection, timeRange]);
  const activePath = useMemo(() => findActivePath(filteredProjects, activeMemoryId), [activeMemoryId, filteredProjects]);
  const canLocateActive = activePath !== null;

  useEffect(() => {
    setOpenProjects((current) => {
      const next = { ...current };
      for (const project of projects) {
        if (next[project.projectKey] === undefined) {
          next[project.projectKey] = true;
        }
      }
      return next;
    });
    setOpenSessions((current) => {
      const next = { ...current };
      for (const project of projects) {
        for (const session of project.sessions) {
          const key = sessionKey(session);
          if (next[key] === undefined) {
            next[key] = session.loaded && shouldAutoExpandSession(session);
          }
        }
      }
      return next;
    });
  }, [projects]);

  useEffect(() => {
    if (!query.trim()) {
      return;
    }
    setOpenProjects((current) => openVisibleProjects(current, filteredProjects));
    setOpenSessions((current) => openVisibleSessions(current, filteredProjects));
  }, [filteredProjects, query]);

  useEffect(() => {
    if (!activePath) {
      return;
    }
    setOpenProjects((current) => ({ ...current, [activePath.projectKey]: true }));
    setOpenSessions((current) => ({ ...current, [activePath.sessionKey]: true }));
    window.requestAnimationFrame(() => {
      activeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }, [activePath]);

  useEffect(() => {
    if (!agentFilterOpen && !timeFilterOpen) {
      return;
    }

    const closeOnOutsidePointer = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && toolbarRef.current?.contains(event.target)) {
        return;
      }
      setAgentFilterOpen(false);
      setTimeFilterOpen(false);
    };

    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [agentFilterOpen, timeFilterOpen]);

  useEffect(() => {
    saveSessionToolbarState({
      selectedAgents,
      timePreset,
      sortDirection,
      customFromDate,
      customFromTime,
      customToDate,
      customToTime,
    });
  }, [customFromDate, customFromTime, customToDate, customToTime, selectedAgents, sortDirection, timePreset]);

  if (loading && projects.length === 0) {
    return <div className="sidebar-empty">Loading projects...</div>;
  }

  if (error && projects.length === 0) {
    return <div className="sidebar-error">{error}</div>;
  }

  if (projects.length === 0) {
    return <div className="sidebar-empty">No sessions yet.</div>;
  }

  function toggleAgent(agent: string) {
    setSelectedAgents((current) => (
      current.includes(agent)
        ? current.filter((item) => item !== agent)
        : [...current, agent]
    ));
  }

  function collapseAll() {
    setOpenProjects(Object.fromEntries(filteredProjects.map((project) => [project.projectKey, false])));
    setOpenSessions({});
  }

  function locateActive() {
    if (!activePath) {
      return;
    }
    setOpenProjects((current) => ({ ...current, [activePath.projectKey]: true }));
    setOpenSessions((current) => ({ ...current, [activePath.sessionKey]: true }));
    window.requestAnimationFrame(() => {
      activeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  function syncDraftTimeFilter() {
    setDraftTimePreset(timePreset);
    setDraftSortDirection(sortDirection);
    if (timePreset === 'custom') {
      setDraftCustomFromDate(customFromDate);
      setDraftCustomFromTime(customFromTime);
      setDraftCustomToDate(customToDate);
      setDraftCustomToTime(customToTime);
      return;
    }
    syncDraftRangeInputs(timePreset);
  }

  function selectDraftTimePreset(preset: TimePreset) {
    setDraftTimePreset(preset);
    if (preset !== 'custom') {
      syncDraftRangeInputs(preset);
    }
  }

  function syncDraftRangeInputs(preset: TimePreset) {
    const range = resolveTimeRange(preset, customFromDate, customFromTime, customToDate, customToTime);
    if (!range.from || !range.to) {
      return;
    }
    setDraftCustomFromDate(dateInputValue(range.from));
    setDraftCustomFromTime(timeInputValue(range.from));
    setDraftCustomToDate(dateInputValue(range.to));
    setDraftCustomToTime(timeInputValue(range.to));
  }

  function applyDraftTimeFilter() {
    setTimePreset(draftTimePreset);
    setSortDirection(draftSortDirection);
    setCustomFromDate(draftCustomFromDate);
    setCustomFromTime(draftCustomFromTime);
    setCustomToDate(draftCustomToDate);
    setCustomToTime(draftCustomToTime);
    setTimeFilterOpen(false);
  }

  return (
    <div className="session-panel">
      <div ref={toolbarRef} className="session-toolbar">
        <label className="session-search">
          <Search />
          <input
            type="text"
            value={query}
            placeholder="Search"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button type="button" aria-label="Clear search" onClick={() => setQuery('')}>
              <X />
            </button>
          ) : <span />}
        </label>
        <button
          className="tree-action-button tree-locate-button"
          type="button"
          title={canLocateActive ? 'Locate selected' : 'No selected turn'}
          disabled={!canLocateActive}
          onClick={locateActive}
        >
          <LocateIcon />
        </button>
        <div className="session-toolbar-row">
          <div className="toolbar-popover agent-filter-popover">
            <button
              className={selectedAgents.length > 0 ? 'session-filter session-filter-icons' : 'session-filter'}
              type="button"
              onClick={() => {
                setAgentFilterOpen(!agentFilterOpen);
                setTimeFilterOpen(false);
              }}
            >
              {selectedAgents.length > 0 ? (
                <AgentLogoCluster agents={selectedAgents.map(logoForAgent).filter((logo): logo is AgentLogo => logo !== null)} />
              ) : (
                <span>Agents: All</span>
              )}
              <ChevronDown />
            </button>
            {agentFilterOpen ? (
              <div className="session-popover session-agent-popover">
                <div className="session-popover-title">Agents</div>
                <button
                  className={selectedAgents.length === 0 ? 'session-menu-item session-menu-item-active' : 'session-menu-item'}
                  type="button"
                  onClick={() => setSelectedAgents([])}
                >
                  <span className={selectedAgents.length === 0 ? 'menu-check menu-check-checked' : 'menu-check'}>
                    {selectedAgents.length === 0 ? <Check /> : null}
                  </span>
                  <span>All agents</span>
                </button>
                {agents.map((agent) => (
                  <button
                    key={agent}
                    className={selectedAgents.includes(agent) ? 'session-menu-item session-menu-item-active' : 'session-menu-item'}
                    type="button"
                    onClick={() => toggleAgent(agent)}
                  >
                    <span className={selectedAgents.includes(agent) ? 'menu-check menu-check-checked' : 'menu-check'}>
                      {selectedAgents.includes(agent) ? <Check /> : null}
                    </span>
                    <AgentLogoCluster agents={[logoForAgent(agent)].filter((logo): logo is AgentLogo => logo !== null)} />
                    <span>{agentLabel(agent)}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="toolbar-popover time-filter-popover">
            <button
              className="session-filter session-time-filter"
              type="button"
              onClick={() => {
                if (!timeFilterOpen) {
                  syncDraftTimeFilter();
                }
                setTimeFilterOpen(!timeFilterOpen);
                setAgentFilterOpen(false);
              }}
            >
              <span>{timeTriggerLabel(timePreset, timeRange, sortDirection)}</span>
              <ChevronDown />
            </button>
            {timeFilterOpen ? (
              <div className="session-popover session-time-popover">
                <div className="time-filter-heading">Time Range</div>
                <div className="time-filter-card">
                  <div className="session-popover-section">
                    {TIME_PRESETS.map((preset) => (
                      <button
                        key={preset.value}
                        className={draftTimePreset === preset.value ? 'session-menu-item session-menu-item-active' : 'session-menu-item'}
                        type="button"
                        onClick={() => selectDraftTimePreset(preset.value)}
                      >
                        <span className={draftTimePreset === preset.value ? 'menu-radio menu-radio-active' : 'menu-radio'} />
                        <span>{preset.label}</span>
                      </button>
                    ))}
                    <button
                      className={draftTimePreset === 'custom' ? 'session-menu-item session-menu-item-active' : 'session-menu-item'}
                      type="button"
                      onClick={() => selectDraftTimePreset('custom')}
                    >
                      <span className={draftTimePreset === 'custom' ? 'menu-radio menu-radio-active' : 'menu-radio'} />
                      <span>Custom</span>
                    </button>
                  </div>
                  <div className={draftTimePreset === 'custom' ? 'custom-time' : 'custom-time custom-time-disabled'}>
                    <label className="time-input-row">
                      <span>From</span>
                      <input disabled={draftTimePreset !== 'custom'} type="date" value={draftCustomFromDate} onChange={(event) => setDraftCustomFromDate(event.target.value)} />
                      <input disabled={draftTimePreset !== 'custom'} type="time" value={draftCustomFromTime} onChange={(event) => setDraftCustomFromTime(event.target.value)} />
                    </label>
                    <label className="time-input-row">
                      <span>To</span>
                      <input disabled={draftTimePreset !== 'custom'} type="date" value={draftCustomToDate} onChange={(event) => setDraftCustomToDate(event.target.value)} />
                      <input disabled={draftTimePreset !== 'custom'} type="time" value={draftCustomToTime} onChange={(event) => setDraftCustomToTime(event.target.value)} />
                    </label>
                  </div>
                  <div className="session-order-section">
                    <button
                      className="time-order-toggle"
                      type="button"
                      role="switch"
                      aria-checked={draftSortDirection === 'asc'}
                      onClick={() => setDraftSortDirection(draftSortDirection === 'asc' ? 'desc' : 'asc')}
                    >
                      <span className="time-order-copy">
                        <span>Ascending order</span>
                        <span>Oldest session first</span>
                      </span>
                      <span className={draftSortDirection === 'asc' ? 'pill-switch pill-switch-on' : 'pill-switch'} aria-hidden="true">
                        <span />
                      </span>
                    </button>
                  </div>
                </div>
                <div className="custom-time-actions">
                  <button type="button" className="time-action-button time-action-button-primary" onClick={applyDraftTimeFilter}>Apply</button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
        <button className="tree-action-button tree-collapse-button" type="button" title="Collapse all" onClick={collapseAll}>
          <CollapseIcon />
        </button>
      </div>

      <div className="session-tree">
      {filteredProjects.length === 0 ? (
        <div className="sidebar-empty">No matching sessions.</div>
      ) : filteredProjects.map((project) => (
        <Collapsible
          key={project.projectKey}
          open={openProjects[project.projectKey] ?? true}
          onOpenChange={(open) => setOpenProjects((current) => ({ ...current, [project.projectKey]: open }))}
          className="tree-group"
        >
          <CollapsibleTrigger className="tree-trigger tree-trigger-project">
            <span className="tree-trigger-main">
              <ChevronRight className="tree-chevron" />
              <Folder className="tree-icon" />
              <span>{project.label}</span>
              <AgentLogoCluster agents={projectAgents(project)} />
            </span>
            <span className="tree-meta tree-time" title={formatTimestamp(project.latestUpdatedAt)}>
              {formatRelativeTime(project.latestUpdatedAt)}
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent className="tree-children">
            {project.sessions.map((session) => (
              <Collapsible
                key={`${session.agent}:${session.sessionKey}`}
                open={openSessions[sessionKey(session)] ?? session.loaded}
                onOpenChange={(open) => setOpenSessions((current) => ({ ...current, [sessionKey(session)]: open }))}
                className="tree-group"
              >
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
                    <AgentLogoIcon logo={logoForAgent(session.agent)} />
                    <span>{session.displaySessionId}</span>
                  </span>
                  <span className="tree-meta tree-time" title={formatTimestamp(session.latestUpdatedAt)}>
                    {formatRelativeTime(session.latestUpdatedAt)}
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent className="turn-list">
                  {session.loading && session.turns.length === 0 ? (
                    <div className="turn-empty">Loading turns...</div>
                  ) : null}
                  <SessionTurnList
                    session={session}
                    activeMemoryId={activeMemoryId}
                    activeRef={activeRef}
                    visibleCount={expandedTurnLists[sessionKey(session)] ?? TURN_LIST_PAGE_SIZE}
                    onVisibleCountChange={(visibleCount) => setExpandedTurnLists((current) => ({
                      ...current,
                      [sessionKey(session)]: visibleCount,
                    }))}
                    onOpenTurn={onOpenTurn}
                    onLoadMore={onLoadMore}
                  />
                </CollapsibleContent>
              </Collapsible>
            ))}
          </CollapsibleContent>
        </Collapsible>
      ))}
      </div>
    </div>
  );
}

function SessionTurnList({
  session,
  activeMemoryId,
  activeRef,
  visibleCount,
  onVisibleCountChange,
  onOpenTurn,
  onLoadMore,
}: {
  session: ProjectSessionNode;
  activeMemoryId: string | null;
  activeRef: RefObject<HTMLButtonElement | null>;
  visibleCount: number;
  onVisibleCountChange: (visibleCount: number) => void;
  onOpenTurn: (memoryId: string) => void;
  onLoadMore: (session: ProjectSessionNode) => void;
}) {
  const items = session.segments.length > 0 ? session.segments : session.turns;
  const visibleItems = items.slice(0, visibleCount);
  const localHiddenCount = Math.max(0, items.length - visibleItems.length);
  const hasMore = localHiddenCount > 0 || session.nextOffset !== null;

  function showMore() {
    if (localHiddenCount === 0 && session.nextOffset !== null && !session.loading) {
      onLoadMore(session);
    }
    onVisibleCountChange(visibleCount + TURN_LIST_PAGE_SIZE);
  }

  return (
    <>
      {visibleItems.map((turn) => (
        <button
          key={turn.memoryId}
          ref={activeMemoryId === turn.memoryId ? activeRef : null}
          data-memory-id={turn.memoryId}
          className={activeMemoryId === turn.memoryId ? 'turn-item turn-item-active' : 'turn-item'}
          type="button"
          onClick={() => onOpenTurn(turn.memoryId)}
        >
          <MessageSquare className="turn-icon" />
          <TurnSummary text={segmentTitle(turn)} />
          <span className="turn-time" title={formatTimestamp(turn.createdAt)}>{formatTimelineTime(turn.createdAt)}</span>
        </button>
      ))}
      {hasMore ? (
        <Button
          variant="ghost"
          size="sm"
          className="load-more turn-list-toggle"
          disabled={session.loading}
          onClick={showMore}
        >
          {session.loading ? 'Loading...' : `Show ${TURN_LIST_PAGE_SIZE} more`}
        </Button>
      ) : null}
    </>
  );
}

function segmentTitle(item: ProjectSegmentNode | ProjectTurnNode): string {
  return 'prompt' in item
    ? item.prompt ?? item.title ?? item.summary ?? ''
    : item.title ?? '';
}

type TimeRange = {
  from: Date | null;
  to: Date | null;
};

const TIME_PRESETS: Array<{ value: TimePreset; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'last_6h', label: 'Last 6 hours' },
  { value: 'last_24h', label: 'Last 24 hours' },
  { value: 'last_7d', label: 'Last 7 days' },
  { value: 'last_30d', label: 'Last 30 days' },
];

type ProjectFilter = {
  query: string;
  selectedAgents: string[];
  sortDirection: SortDirection;
  timeRange: TimeRange;
};

function filterProjects(projects: ProjectNode[], filter: ProjectFilter): ProjectNode[] {
  const normalizedQuery = filter.query.trim().toLowerCase();
  const selectedAgents = new Set(filter.selectedAgents);
  const compare = filter.sortDirection === 'desc'
    ? (left: string, right: string) => right.localeCompare(left)
    : (left: string, right: string) => left.localeCompare(right);

  return projects.flatMap((project) => {
    const projectMatches = matchesQuery(project.label, normalizedQuery);
    const sessions = project.sessions.flatMap((session) => {
      if (selectedAgents.size > 0 && !selectedAgents.has(session.agent)) {
        return [];
      }
      if (!isInRange(session.latestUpdatedAt, filter.timeRange)) {
        return [];
      }

      const sessionMatches = projectMatches
        || matchesQuery(session.displaySessionId, normalizedQuery)
        || matchesQuery(session.agent, normalizedQuery);
      const items = session.segments.length > 0 ? session.segments : session.turns;
      const filteredItems = items
        .filter((item) => isInRange(item.createdAt, filter.timeRange))
        .filter((item) => (
          !normalizedQuery
          || sessionMatches
          || matchesQuery(segmentTitle(item), normalizedQuery)
        ))
        .sort((left, right) => compare(left.createdAt, right.createdAt));

      if (normalizedQuery && !sessionMatches && filteredItems.length === 0) {
        return [];
      }

      return [{
        ...session,
        segments: session.segments.length > 0 ? filteredItems as ProjectSegmentNode[] : session.segments,
        turns: session.segments.length > 0 ? session.turns : filteredItems as ProjectTurnNode[],
      }];
    }).sort((left, right) => compare(left.latestUpdatedAt, right.latestUpdatedAt));

    if (sessions.length === 0) {
      return [];
    }

    const latestUpdatedAt = sessions.reduce((latest, session) => (
      session.latestUpdatedAt > latest ? session.latestUpdatedAt : latest
    ), sessions[0]!.latestUpdatedAt);

    return [{
      ...project,
      latestUpdatedAt,
      sessions,
    }];
  }).sort((left, right) => compare(left.latestUpdatedAt, right.latestUpdatedAt));
}

function matchesQuery(value: string, query: string): boolean {
  return !query || value.toLowerCase().includes(query);
}

function isInRange(value: string, range: TimeRange): boolean {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) {
    return false;
  }
  if (range.from && time < range.from.getTime()) {
    return false;
  }
  if (range.to && time > range.to.getTime()) {
    return false;
  }
  return true;
}

function uniqueAgents(projects: ProjectNode[]): string[] {
  return [...new Set(projects.flatMap((project) => project.sessions.map((session) => session.agent)))]
    .sort((left, right) => agentLabel(left).localeCompare(agentLabel(right)));
}

function sessionKey(session: ProjectSessionNode): string {
  return `${session.agent}:${session.sessionKey}`;
}

function shouldAutoExpandSession(session: ProjectSessionNode): boolean {
  const itemCount = session.segments.length > 0 ? session.segments.length : session.turns.length;
  return itemCount <= TURN_LIST_PAGE_SIZE;
}

function openVisibleProjects(current: Record<string, boolean>, projects: ProjectNode[]): Record<string, boolean> {
  const next = { ...current };
  for (const project of projects) {
    next[project.projectKey] = true;
  }
  return next;
}

function openVisibleSessions(current: Record<string, boolean>, projects: ProjectNode[]): Record<string, boolean> {
  const next = { ...current };
  for (const project of projects) {
    for (const session of project.sessions) {
      next[sessionKey(session)] = true;
    }
  }
  return next;
}

function findActivePath(projects: ProjectNode[], activeMemoryId: string | null): { projectKey: string; sessionKey: string } | null {
  if (!activeMemoryId) {
    return null;
  }
  for (const project of projects) {
    for (const session of project.sessions) {
      if (
        session.turns.some((turn) => turn.memoryId === activeMemoryId)
        || session.segments.some((segment) => segment.memoryId === activeMemoryId)
      ) {
        return {
          projectKey: project.projectKey,
          sessionKey: sessionKey(session),
        };
      }
    }
  }
  return null;
}

function resolveTimeRange(
  preset: TimePreset,
  customFromDate: string,
  customFromTime: string,
  customToDate: string,
  customToTime: string,
): TimeRange {
  if (preset === 'all') {
    return { from: null, to: null };
  }
  if (preset === 'custom') {
    return {
      from: parseDateTime(customFromDate, customFromTime),
      to: parseDateTime(customToDate, customToTime),
    };
  }

  const now = new Date();
  const hours = preset === 'last_6h'
    ? 6
    : preset === 'last_24h'
      ? 24
      : preset === 'last_7d'
        ? 24 * 7
        : 24 * 30;
  return {
    from: new Date(now.getTime() - hours * 60 * 60 * 1000),
    to: now,
  };
}

function parseDateTime(date: string, time: string): Date | null {
  const value = new Date(`${date}T${time || '00:00'}:00`);
  return Number.isFinite(value.getTime()) ? value : null;
}

function daysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

function dateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function timeInputValue(date: Date): string {
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${hour}:${minute}`;
}

function defaultSessionToolbarState(): SessionToolbarState {
  return {
    selectedAgents: [],
    timePreset: 'last_7d',
    sortDirection: 'desc',
    customFromDate: dateInputValue(daysAgo(7)),
    customFromTime: '00:00',
    customToDate: dateInputValue(new Date()),
    customToTime: '23:59',
  };
}

function loadSessionToolbarState(): SessionToolbarState {
  const defaults = defaultSessionToolbarState();
  if (typeof window === 'undefined') {
    return defaults;
  }

  const urlState = loadSessionToolbarStateFromUrl(defaults);
  if (urlState) {
    return urlState;
  }

  try {
    const raw = window.localStorage?.getItem(SESSION_TOOLBAR_STORAGE_KEY);
    if (!raw) {
      return defaults;
    }

    const parsed = JSON.parse(raw) as Partial<SessionToolbarState>;
    return {
      selectedAgents: Array.isArray(parsed.selectedAgents)
        ? parsed.selectedAgents.filter((agent): agent is string => typeof agent === 'string' && agent.length > 0)
        : defaults.selectedAgents,
      timePreset: isTimePreset(parsed.timePreset) ? parsed.timePreset : defaults.timePreset,
      sortDirection: isSortDirection(parsed.sortDirection) ? parsed.sortDirection : defaults.sortDirection,
      customFromDate: isDateInput(parsed.customFromDate) ? parsed.customFromDate : defaults.customFromDate,
      customFromTime: isTimeInput(parsed.customFromTime) ? parsed.customFromTime : defaults.customFromTime,
      customToDate: isDateInput(parsed.customToDate) ? parsed.customToDate : defaults.customToDate,
      customToTime: isTimeInput(parsed.customToTime) ? parsed.customToTime : defaults.customToTime,
    };
  } catch {
    return defaults;
  }
}

function saveSessionToolbarState(state: SessionToolbarState) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage?.setItem(SESSION_TOOLBAR_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage failures; filters still work for the current page lifecycle.
  }

  saveSessionToolbarStateToUrl(state);
}

function loadSessionToolbarStateFromUrl(defaults: SessionToolbarState): SessionToolbarState | null {
  const params = new URL(window.location.href).searchParams;
  const hasToolbarParams = params.has('agent')
    || params.has('time')
    || params.has('sort')
    || params.has('from')
    || params.has('to');
  if (!hasToolbarParams) {
    return null;
  }

  const next: SessionToolbarState = { ...defaults };
  const agents = params.getAll('agent').filter((agent) => agent.length > 0);
  if (agents.length > 0) {
    next.selectedAgents = agents;
  }

  const timePreset = params.get('time');
  if (isTimePreset(timePreset)) {
    next.timePreset = timePreset;
  }

  const sortDirection = params.get('sort');
  if (isSortDirection(sortDirection)) {
    next.sortDirection = sortDirection;
  }

  const from = parseUrlDateTime(params.get('from'));
  if (from) {
    next.customFromDate = from.date;
    next.customFromTime = from.time;
  }

  const to = parseUrlDateTime(params.get('to'));
  if (to) {
    next.customToDate = to.date;
    next.customToTime = to.time;
  }

  return next;
}

function saveSessionToolbarStateToUrl(state: SessionToolbarState) {
  const url = new URL(window.location.href);
  url.searchParams.delete('agent');
  for (const agent of state.selectedAgents) {
    url.searchParams.append('agent', agent);
  }

  setSearchParam(url, 'time', state.timePreset === 'last_7d' ? null : state.timePreset);
  setSearchParam(url, 'sort', state.sortDirection === 'desc' ? null : state.sortDirection);
  if (state.timePreset === 'custom') {
    setSearchParam(url, 'from', `${state.customFromDate}T${state.customFromTime}`);
    setSearchParam(url, 'to', `${state.customToDate}T${state.customToTime}`);
  } else {
    url.searchParams.delete('from');
    url.searchParams.delete('to');
  }

  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextUrl !== currentUrl) {
    window.history.replaceState(null, '', nextUrl);
  }
}

function setSearchParam(url: URL, key: string, value: string | null) {
  if (value === null) {
    url.searchParams.delete(key);
    return;
  }
  url.searchParams.set(key, value);
}

function parseUrlDateTime(value: string | null): { date: string; time: string } | null {
  if (!value) {
    return null;
  }
  const [date, time] = value.split('T');
  if (!isDateInput(date) || !isTimeInput(time)) {
    return null;
  }
  return { date, time };
}

function isTimePreset(value: unknown): value is TimePreset {
  return value === 'all'
    || value === 'last_6h'
    || value === 'last_24h'
    || value === 'last_7d'
    || value === 'last_30d'
    || value === 'custom';
}

function isSortDirection(value: unknown): value is SortDirection {
  return value === 'asc' || value === 'desc';
}

function isDateInput(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isTimeInput(value: unknown): value is string {
  return typeof value === 'string' && /^\d{2}:\d{2}$/.test(value);
}

function timeFilterLabel(preset: TimePreset, range: TimeRange): string {
  if (preset === 'all') {
    return 'All';
  }
  if (preset !== 'custom') {
    return TIME_PRESETS.find((item) => item.value === preset)?.label ?? 'Time';
  }
  if (!range.from || !range.to) {
    return 'Custom';
  }
  return `${formatRangePart(range.from)} - ${formatRangePart(range.to)}`;
}

function timeTriggerLabel(preset: TimePreset, range: TimeRange, sortDirection: SortDirection): string {
  const suffix = sortDirection === 'desc' ? '↓' : '↑';
  if (preset === 'all') {
    return `Time: All ${suffix}`;
  }
  return `${timeFilterLabel(preset, range)} ${suffix}`;
}

function formatRangePart(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${hour}:${minute}`;
}

function agentLabel(agent: string): string {
  const logo = logoForAgent(agent);
  return logo?.fallback ? 'Other' : (logo?.label ?? agent);
}

function CollapseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="m7 15 5-5 5 5" />
      <path d="M5 19h14" />
    </svg>
  );
}

function LocateIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v3" />
      <path d="M12 18v3" />
      <path d="M3 12h3" />
      <path d="M18 12h3" />
      <circle cx="12" cy="12" r="5" />
    </svg>
  );
}

function TurnSummary({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [displayText, setDisplayText] = useState(text);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }

    const fits = (value: string) => {
      element.textContent = value;
      return element.scrollHeight <= element.clientHeight + 1;
    };

    const updateText = () => {
      element.textContent = text;
      if (fits(text)) {
        setDisplayText(text);
        return;
      }

      let low = 0;
      let high = text.length;
      let best = '';
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const candidate = `${text.slice(0, Math.max(0, mid - 4)).trimEnd()}...`;
        if (fits(candidate)) {
          best = candidate;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      setDisplayText(best || '...');
    };

    updateText();
    const observer = new ResizeObserver(updateText);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  return (
    <span ref={ref} className="turn-summary" title={text}>
      {displayText}
    </span>
  );
}

type AgentLogo = {
  key: string;
  label: string;
  src?: string;
  fallback?: boolean;
};

const AGENT_LOGOS: Record<string, AgentLogo> = {
  claude: { key: 'claude', label: 'Claude Code', src: claudeLogoUrl },
  codex: { key: 'codex', label: 'Codex', src: codexLogoUrl },
  openclaw: { key: 'openclaw', label: 'OpenClaw', src: openclawLogoUrl },
  cursor: { key: 'cursor', label: 'Cursor', src: codexLogoUrl },
};

function projectAgents(project: ProjectNode): AgentLogo[] {
  const logos: AgentLogo[] = [];
  const seen = new Set<string>();
  for (const session of project.sessions) {
    const logo = logoForAgent(session.agent);
    if (!logo || seen.has(logo.key)) {
      continue;
    }
    seen.add(logo.key);
    logos.push(logo);
  }
  return logos;
}

function logoForAgent(agent: string): AgentLogo | null {
  const normalized = agent.toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized.includes('claude')) {
    return AGENT_LOGOS.claude;
  }
  if (normalized.includes('codex') || normalized.includes('openai')) {
    return AGENT_LOGOS.codex;
  }
  if (normalized.includes('openclaw') || normalized.includes('open_claw')) {
    return AGENT_LOGOS.openclaw;
  }
  if (normalized.includes('cursor')) {
    return AGENT_LOGOS.cursor;
  }
  return { key: `fallback:${normalized}`, label: agent || 'Unknown agent', fallback: true };
}

function AgentLogoCluster({ agents }: { agents: AgentLogo[] }) {
  if (agents.length === 0) {
    return null;
  }

  const title = agents.map((agent) => agent.label).join(', ');
  return (
    <span className="agent-logo-cluster" title={title}>
      {agents.map((agent) => (
        <span key={agent.key} className="agent-logo-frame">
          {agent.fallback ? (
            <Bot className="agent-logo-fallback" aria-label={agent.label} />
          ) : (
            <img src={agent.src} alt={agent.label} className="agent-logo-image" />
          )}
        </span>
      ))}
    </span>
  );
}

function AgentLogoIcon({ logo }: { logo: AgentLogo | null }) {
  if (!logo) {
    return null;
  }
  return (
    <span className="tree-session-agent-icon" title={logo.label}>
      {logo.fallback ? (
        <Bot className="agent-logo-fallback" aria-label={logo.label} />
      ) : (
        <img src={logo.src} alt={logo.label} className="agent-logo-image" />
      )}
    </span>
  );
}
