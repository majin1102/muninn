import type { MemoryDocument } from '@muninn/common';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bot, CircleAlert, MessageSquare } from 'lucide-react';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import userAvatarUrl from '../assets/user-avatar.png';
import { logoForAgent, type AgentLogo } from '../lib/agent-logo.js';
import type { ProjectTurnNode } from '../lib/api.js';
import { chatTimelineItems, type ChatTimelineItem } from '../lib/chat-timeline-items.js';
import {
  CHAT_CONTEXT_STEP,
  DEFAULT_CHAT_INITIAL_TURN_COUNT,
  INITIAL_CHAT_CONTEXT_RADIUS,
  chatTurnWindow,
} from '../lib/chat-window.js';
import { transcriptMessages, type TranscriptMessage } from '../lib/transcript.js';
import { cn } from '../lib/utils.js';
import {
  entriesFromEvents,
  entriesFromFallback,
  type ChatMessage,
  type ChatTimelineEntry,
  type ChatToolCall,
} from '../lib/chat-timeline.js';
import { ArtifactList } from './ArtifactList.js';
import { Avatar } from './ui/avatar.js';
import { Button } from './ui/button.js';
import { EmptyState } from './ui/empty-state.js';
import { ScrollArea } from './ui/scroll-area.js';

type ChatViewProps = {
  document: MemoryDocument | null;
  activeMemoryId: string | null;
  focusMemoryId: string | null;
  focusRequestId: number;
  sessionTurns: ProjectTurnNode[];
  onVisibleTurnIdsChange?: (turnIds: string[]) => void;
  canLoadMoreAfter?: boolean;
  loadingMoreAfter?: boolean;
  onLoadMoreAfter?: () => void;
  onLoadTurnDetail?: (memoryId: string) => Promise<ProjectTurnNode>;
  loading: boolean;
  error: string | null;
};

const TIME_SEPARATOR_GAP_MS = 5 * 60 * 1000;

export function ChatView({
  document,
  activeMemoryId,
  focusMemoryId,
  focusRequestId,
  sessionTurns,
  onVisibleTurnIdsChange,
  canLoadMoreAfter = false,
  loadingMoreAfter = false,
  onLoadMoreAfter,
  onLoadTurnDetail,
  loading,
  error,
}: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeMessageRef = useRef<HTMLElement>(null);
  const [beforeLimit, setBeforeLimit] = useState(INITIAL_CHAT_CONTEXT_RADIUS);
  const [afterLimit, setAfterLimit] = useState(DEFAULT_CHAT_INITIAL_TURN_COUNT);
  const [turnDetails, setTurnDetails] = useState<Record<string, ProjectTurnNode>>({});
  const [turnDetailLoading, setTurnDetailLoading] = useState<Record<string, boolean>>({});
  const [turnDetailErrors, setTurnDetailErrors] = useState<Record<string, string>>({});
  const sessionDetailKey = sessionTurns[0]
    ? `${sessionTurns[0].agent}:${sessionTurns[0].sessionKey}`
    : document?.memoryId ?? 'empty';
  const displayTurns = useMemo(() => sessionTurns.map((turn) => (
    turn.memoryId && turnDetails[turn.memoryId] ? { ...turn, ...turnDetails[turn.memoryId] } : turn
  )), [sessionTurns, turnDetails]);
  const turnWindow = useMemo(
    () => chatTurnWindow(displayTurns, focusMemoryId, beforeLimit, afterLimit),
    [afterLimit, beforeLimit, displayTurns, focusMemoryId],
  );
  const laterTurnCount = turnWindow.afterCount > 0
    ? Math.min(CHAT_CONTEXT_STEP, turnWindow.afterCount)
    : CHAT_CONTEXT_STEP;
  const entries = useMemo(() => (
    displayTurns.length > 0 ? entriesFromTurns(turnWindow.turns) : entriesFromDocument(document)
  ), [displayTurns.length, document, turnWindow.turns]);
  const timelineItems = useMemo(() => chatTimelineItems(entries, TIME_SEPARATOR_GAP_MS), [entries]);

  const ensureTurnDetail = useCallback(async (memoryId: string | undefined) => {
    if (!memoryId || !onLoadTurnDetail || turnDetails[memoryId] || turnDetailLoading[memoryId]) {
      return;
    }
    setTurnDetailLoading((current) => ({ ...current, [memoryId]: true }));
    setTurnDetailErrors((current) => {
      const next = { ...current };
      delete next[memoryId];
      return next;
    });
    try {
      const detail = await onLoadTurnDetail(memoryId);
      setTurnDetails((current) => ({ ...current, [memoryId]: detail }));
    } catch (error) {
      setTurnDetailErrors((current) => ({
        ...current,
        [memoryId]: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setTurnDetailLoading((current) => ({ ...current, [memoryId]: false }));
    }
  }, [onLoadTurnDetail, turnDetailLoading, turnDetails]);

  useEffect(() => {
    setBeforeLimit(INITIAL_CHAT_CONTEXT_RADIUS);
    setAfterLimit(focusMemoryId ? INITIAL_CHAT_CONTEXT_RADIUS : DEFAULT_CHAT_INITIAL_TURN_COUNT);
  }, [focusMemoryId, focusRequestId]);

  useEffect(() => {
    setTurnDetails({});
    setTurnDetailLoading({});
    setTurnDetailErrors({});
  }, [sessionDetailKey]);

  useEffect(() => {
    if (!focusMemoryId) {
      return;
    }

    const scrollToActive = () => {
      const scroller = scrollRef.current;
      const active = scroller
        ? Array.from(scroller.querySelectorAll<HTMLElement>('.chat-message-row'))
          .find((row) => row.dataset.memoryId === focusMemoryId)
        : null;
      if (!active || !scroller) {
        return;
      }
      const scrollerRect = scroller.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      scroller.scrollTo({
        top: scroller.scrollTop + activeRect.top - scrollerRect.top - 24,
      });
    };

    scrollToActive();
    const frame = window.requestAnimationFrame(scrollToActive);
    const timeout = window.setTimeout(scrollToActive, 50);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [focusMemoryId, focusRequestId, timelineItems.length, turnWindow.turns]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !onVisibleTurnIdsChange) {
      return;
    }

    let frame = 0;
    const scheduleReport = () => {
      if (frame !== 0) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        onVisibleTurnIdsChange(visibleTurnIds(scroller));
      });
    };

    scheduleReport();
    scroller.addEventListener('scroll', scheduleReport, { passive: true });
    window.addEventListener('resize', scheduleReport);

    return () => {
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
      scroller.removeEventListener('scroll', scheduleReport);
      window.removeEventListener('resize', scheduleReport);
    };
  }, [onVisibleTurnIdsChange, timelineItems.length, turnWindow.turns]);

  if (loading) {
    return <EmptyState className="content-empty-panel chat-empty" icon={MessageSquare} title="loading conversation..." />;
  }

  if (error) {
    return <EmptyState className="content-empty-panel chat-empty" icon={CircleAlert} title={error} tone="danger" />;
  }

  if (!document && sessionTurns.length === 0) {
    return (
      <EmptyState className="content-empty-panel chat-empty" icon={MessageSquare} title="Select a turn from the project tree." variant="passive" />
    );
  }

  return (
    <ScrollArea ref={scrollRef} className="chat-scroll">
      <div className="chat-thread">
        {turnWindow.beforeCount > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            className="chat-collapse-divider"
            onClick={() => setBeforeLimit((current) => current + CHAT_CONTEXT_STEP)}
          >
            Show {Math.min(CHAT_CONTEXT_STEP, turnWindow.beforeCount)} earlier turns
          </Button>
        ) : null}
        {timelineItems.map((item) => {
          if (item.type === 'time') {
            return <TimeSeparator key={item.key} timestamp={item.timestamp} />;
          }
          return renderTimelineEntry({
            item,
            activeMemoryId,
            activeMessageRef,
            documentAgent: document?.agent ?? document?.extractor ?? '',
            onLoadTurnDetail: ensureTurnDetail,
            turnDetailLoading,
            turnDetailErrors,
            loadedTurnDetails: turnDetails,
          });
        })}
        {turnWindow.afterCount > 0 || canLoadMoreAfter ? (
          <Button
            variant="ghost"
            size="sm"
            className="chat-collapse-divider"
            disabled={loadingMoreAfter}
            onClick={() => {
              if (turnWindow.afterCount > 0) {
                setAfterLimit((current) => current + CHAT_CONTEXT_STEP);
                return;
              }
              setAfterLimit((current) => current + CHAT_CONTEXT_STEP);
              onLoadMoreAfter?.();
            }}
          >
            {loadingMoreAfter ? 'Loading...' : `Show ${laterTurnCount} later turns`}
          </Button>
        ) : null}
      </div>
    </ScrollArea>
  );
}

function visibleTurnIds(scroller: HTMLElement): string[] {
  const scrollerRect = scroller.getBoundingClientRect();
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const row of Array.from(scroller.querySelectorAll<HTMLElement>('.chat-message-row[data-memory-id]'))) {
    const memoryId = row.dataset.memoryId;
    if (!memoryId || seen.has(memoryId)) {
      continue;
    }
    const rowRect = row.getBoundingClientRect();
    if (rowRect.bottom <= scrollerRect.top || rowRect.top >= scrollerRect.bottom) {
      continue;
    }
    seen.add(memoryId);
    ids.push(memoryId);
  }
  return ids;
}

function renderTimelineEntry(params: {
  item: Extract<ChatTimelineItem, { type: 'entry' }>;
  activeMemoryId: string | null;
  activeMessageRef: React.RefObject<HTMLElement | null>;
  documentAgent: string;
  onLoadTurnDetail: (memoryId: string | undefined) => void;
  turnDetailLoading: Record<string, boolean>;
  turnDetailErrors: Record<string, string>;
  loadedTurnDetails: Record<string, ProjectTurnNode>;
}) {
  const {
    item,
    activeMemoryId,
    activeMessageRef,
    documentAgent,
    onLoadTurnDetail,
    turnDetailLoading,
    turnDetailErrors,
    loadedTurnDetails,
  } = params;
  if (item.entry.type === 'toolGroup') {
    const { group } = item.entry;
    return (
      <section
        key={item.key}
        data-memory-id={group.memoryId}
        className={cn(
          'chat-message-row chat-message-row-agent chat-tool-group-row',
          group.memoryId === activeMemoryId && 'chat-turn-active',
        )}
      >
        <Avatar className="chat-avatar chat-avatar-agent chat-avatar-spacer">
          <AgentAvatar logo={logoForAgent(group.agent ?? documentAgent)} />
        </Avatar>
        <div className="chat-message-content chat-message-content-tools">
          <ToolCallList
            toolCalls={group.toolCalls}
            agent={group.agent ?? documentAgent}
            memoryId={group.memoryId}
            loadingDetail={group.memoryId ? Boolean(turnDetailLoading[group.memoryId]) : false}
            detailError={group.memoryId ? turnDetailErrors[group.memoryId] : undefined}
            hasFullDetail={group.memoryId ? Boolean(loadedTurnDetails[group.memoryId]) : false}
            onLoadTurnDetail={onLoadTurnDetail}
            startedAt={group.startedAt}
            completedAt={group.completedAt}
            totalStartedAt={item.totalTime?.startedAt}
            totalCompletedAt={item.totalTime?.completedAt}
          />
        </div>
      </section>
    );
  }

  const { message } = item.entry;
  return (
    <section
      key={item.key}
      ref={message.memoryId === activeMemoryId && message.role === 'user' ? activeMessageRef : null}
      data-memory-id={message.memoryId}
      className={cn(
        'chat-message-row',
        message.role === 'agent' && 'chat-message-row-agent',
        message.memoryId === activeMemoryId && 'chat-turn-active',
      )}
    >
      <Avatar className={cn('chat-avatar', message.role === 'agent' && 'chat-avatar-agent')}>
        {message.role === 'user' ? (
          <img src={userAvatarUrl} alt="User" className="chat-avatar-image" />
        ) : (
          <AgentAvatar logo={logoForAgent(message.agent ?? documentAgent)} />
        )}
      </Avatar>
      <div
        className={cn(
          'chat-message-content',
          isLongMessage(message.body) && 'chat-message-content-long',
        )}
      >
        {message.body ? (
          <>
            <div className="chat-bubble">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.body}</ReactMarkdown>
            </div>
            {message.artifacts && message.artifacts.length > 0 ? (
              <ArtifactList artifacts={message.artifacts} agent={message.agent ?? documentAgent} />
            ) : null}
            {message.role === 'agent' ? (
              <ChatTimeMetaRow
                items={[
                  { label: 'reply', startedAt: message.startedAt, completedAt: message.completedAt },
                  { label: 'total', startedAt: item.totalTime?.startedAt, completedAt: item.totalTime?.completedAt },
                ]}
              />
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

function entriesFromDocument(document: MemoryDocument | null): ChatTimelineEntry[] {
  if (!document) {
    return [];
  }
  if (document.events && document.events.length > 0) {
    return entriesFromEvents(document.events, {
      memoryId: document.memoryId,
      agent: document.agent ?? document.extractor,
      startedAt: document.createdAt,
      completedAt: document.updatedAt,
    });
  }
  if (document.prompt || document.response) {
    return entriesFromFallback({
      memoryId: document.memoryId,
      agent: document.agent ?? document.extractor,
      createdAt: document.createdAt ?? document.updatedAt,
      updatedAt: document.updatedAt,
      prompt: document.prompt,
      response: document.response,
      artifacts: document.artifacts,
      toolCalls: document.toolCalls,
    });
  }
  return transcriptMessages(document).map((message) => ({
    type: 'message',
    message: {
      ...message,
      memoryId: document.memoryId,
      agent: document.agent ?? document.extractor,
      timestamp: document.updatedAt,
    },
  }));
}

function entriesFromTurns(turns: ProjectTurnNode[]): ChatTimelineEntry[] {
  return turns.flatMap((turn) => {
    if (turn.events && turn.events.length > 0) {
      return entriesFromEvents(turn.events, {
        memoryId: turn.memoryId,
        agent: turn.agent,
        startedAt: turn.createdAt,
        completedAt: turn.updatedAt,
      });
    }
    return entriesFromFallback({
      memoryId: turn.memoryId,
      agent: turn.agent,
      createdAt: turn.createdAt,
      updatedAt: turn.updatedAt,
      prompt: turn.prompt,
      response: turn.response,
      preview: turn.preview,
      artifacts: turn.artifacts,
      toolCalls: turn.toolCalls,
    });
  });
}

function isLongMessage(body: string): boolean {
  return body.length > 48 || body.includes('\n');
}

function AgentAvatar({ logo }: { logo: AgentLogo }) {
  if (logo.src) {
    return <img src={logo.src} alt={logo.label} className="chat-agent-image" />;
  }
  return <Bot className="chat-agent-fallback" aria-label={logo.label} />;
}

function TimeSeparator({ timestamp }: { timestamp: string }) {
  return (
    <time className="chat-time-separator" dateTime={timestamp} title={formatFullTime(timestamp)}>
      {formatTimeSeparator(timestamp)}
    </time>
  );
}

function ChatTimeMeta({ label, startedAt, completedAt }: { label: string; startedAt?: string; completedAt?: string }) {
  const duration = formatDuration(startedAt, completedAt);
  if (!duration) {
    return null;
  }
  return (
    <span className="chat-time-meta" title={timeRangeTitle(startedAt, completedAt)}>
      {label}: {duration}
    </span>
  );
}

function ChatTimeMetaRow({
  items,
}: {
  items: Array<{ label: string; startedAt?: string; completedAt?: string }>;
}) {
  const visible = items
    .map((item) => ({
      ...item,
      duration: formatDuration(item.startedAt, item.completedAt),
    }))
    .filter((item) => item.duration);
  if (visible.length === 0) {
    return null;
  }
  return (
    <div className="chat-time-meta-row">
      {visible.map((item, index) => (
        <Fragment key={item.label}>
          {index > 0 ? <span className="chat-time-meta-separator">·</span> : null}
          <span className="chat-time-meta" title={timeRangeTitle(item.startedAt, item.completedAt)}>
            {item.label}: {item.duration}
          </span>
        </Fragment>
      ))}
    </div>
  );
}

function ToolCallList({
  toolCalls,
  agent,
  memoryId,
  loadingDetail,
  detailError,
  hasFullDetail,
  onLoadTurnDetail,
  startedAt,
  completedAt,
  totalStartedAt,
  totalCompletedAt,
}: {
  toolCalls: ChatToolCall[];
  agent?: string;
  memoryId?: string;
  loadingDetail: boolean;
  detailError?: string;
  hasFullDetail: boolean;
  onLoadTurnDetail: (memoryId: string | undefined) => void;
  startedAt?: string;
  completedAt?: string;
  totalStartedAt?: string;
  totalCompletedAt?: string;
}) {
  const [groupOpen, setGroupOpen] = useState(false);
  const [openRows, setOpenRows] = useState<Record<string, boolean>>({});
  const summary = toolCallSummary(toolCalls);
  const artifacts = toolCalls.flatMap((toolCall) => toolCall.artifacts ?? []);
  return (
    <>
      <details
        className="chat-tool-call-group"
        open={groupOpen}
        onToggle={(event) => setGroupOpen(event.currentTarget.open)}
      >
        <summary className="chat-tool-call-group-summary">
          <span className="chat-tool-call-chevron">›</span>
          <span className="chat-tool-call-title">Tool calls: {toolCalls.length}</span>
          <span className="chat-tool-call-meta">{summary}</span>
        </summary>
        {groupOpen ? (
          <div className="chat-tool-call-panel">
            {toolCalls.map((toolCall, index) => {
              const key = toolCall.id ?? `${toolCall.name}-${index}`;
              const rowOpen = Boolean(openRows[key]);
              return (
                <details
                  key={key}
                  className="chat-tool-call-row"
                  open={rowOpen}
                  onToggle={(event) => {
                    const nextOpen = event.currentTarget.open;
                    setOpenRows((current) => ({ ...current, [key]: nextOpen }));
                    if (nextOpen && hasPreviewOnlyToolIo(toolCall) && !hasFullDetail) {
                      onLoadTurnDetail(memoryId);
                    }
                  }}
                >
                  <summary className="chat-tool-call-row-summary">
                    <span className="chat-tool-call-chevron">›</span>
                    <span className="chat-tool-call-name">{toolCall.name}</span>
                    <span className="chat-tool-call-arg">{toolCallInputSummary(toolCall)}</span>
                    <span className="chat-tool-call-state">{toolCall.output || toolCall.outputPreview ? 'output' : 'input'}</span>
                  </summary>
                  {rowOpen ? (
                    <div className="chat-tool-call-io">
                      {loadingDetail && hasPreviewOnlyToolIo(toolCall) && !hasFullDetail ? (
                        <div className="chat-tool-call-section">
                          <div className="chat-tool-call-label">Loading full tool details...</div>
                        </div>
                      ) : null}
                      {detailError && hasPreviewOnlyToolIo(toolCall) && !hasFullDetail ? (
                        <div className="chat-tool-call-section">
                          <div className="chat-tool-call-label">{detailError}</div>
                        </div>
                      ) : null}
                      <ToolCallIoSection label="Input" value={toolCall.input} preview={toolCall.inputPreview} bytes={toolCall.inputBytes} />
                      <ToolCallIoSection label="Output" value={toolCall.output} preview={toolCall.outputPreview} bytes={toolCall.outputBytes} />
                      <ChatTimeMeta label="time" startedAt={toolCall.startedAt} completedAt={toolCall.completedAt} />
                    </div>
                  ) : null}
                </details>
              );
            })}
          </div>
        ) : null}
      </details>
      {artifacts.length > 0 ? (
        <ArtifactList artifacts={artifacts} agent={agent} />
      ) : null}
      <ChatTimeMetaRow
        items={[
          { label: 'tools', startedAt, completedAt },
          { label: 'total', startedAt: totalStartedAt, completedAt: totalCompletedAt },
        ]}
      />
    </>
  );
}

function ToolCallIoSection({
  label,
  value,
  preview,
  bytes,
}: {
  label: string;
  value?: string;
  preview?: string;
  bytes?: number;
}) {
  const display = value ?? preview;
  if (!display) {
    return null;
  }
  return (
    <div className="chat-tool-call-section">
      <div className="chat-tool-call-label">{value ? label : `${label} preview${bytes ? ` (${formatBytes(bytes)})` : ''}`}</div>
      <pre>{display}</pre>
    </div>
  );
}

function hasPreviewOnlyToolIo(toolCall: ChatToolCall): boolean {
  return Boolean((toolCall.inputPreview && !toolCall.input) || (toolCall.outputPreview && !toolCall.output));
}

function toolCallInputSummary(toolCall: ChatToolCall): string {
  const input = (toolCall.input ?? toolCall.inputPreview)?.trim();
  if (!input) {
    return '';
  }
  const parsed = parseToolCallInput(input);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return truncateToolCallSummary(input);
  }

  const values = parsed as Record<string, unknown>;
  const preferred = [
    values.cmd,
    values.command,
    values.path,
    values.file,
    values.app,
    values.title,
  ].find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (preferred) {
    return truncateToolCallSummary(preferred.trim());
  }

  return truncateToolCallSummary(input);
}

function parseToolCallInput(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function truncateToolCallSummary(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  const maxLength = 120;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function toolCallSummary(toolCalls: ChatToolCall[]): string {
  const counts = new Map<string, number>();
  for (const toolCall of toolCalls) {
    counts.set(toolCall.name, (counts.get(toolCall.name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => `${name} x${count}`)
    .join(', ');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function compactText(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 72 ? `${normalized.slice(0, 68)}...` : normalized;
}

function formatTimeSeparator(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return timeParts(date);
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return `Yesterday ${timeParts(date)}`;
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  const datePrefix = sameYear
    ? `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`
    : `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
  return `${datePrefix} ${timeParts(date)}`;
}

function formatFullTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${timeParts(date)}`;
}

function timeParts(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDuration(startedAt?: string, completedAt?: string): string | null {
  if (!startedAt || !completedAt) {
    return null;
  }
  const started = new Date(startedAt).getTime();
  const completed = new Date(completedAt).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed <= started) {
    return null;
  }
  const totalSeconds = Math.max(1, Math.round((completed - started) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours === 0) {
    return `${remainingMinutes}m ${pad(seconds)}s`;
  }
  return `${hours}h ${pad(remainingMinutes)}m ${pad(seconds)}s`;
}

function timeRangeTitle(startedAt?: string, completedAt?: string): string {
  if (!startedAt || !completedAt) {
    return '';
  }
  return `${formatFullTime(startedAt)} -> ${formatFullTime(completedAt)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
