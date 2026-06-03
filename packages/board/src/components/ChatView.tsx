import type { Artifact, MemoryDocument } from '@muninn/types';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bot } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import userAvatarUrl from '../assets/user-avatar.png';
import { logoForAgent, type AgentLogo } from '../lib/agent_logo.js';
import type { ProjectTurnNode } from '../lib/api.js';
import { CHAT_CONTEXT_STEP, INITIAL_CHAT_CONTEXT_RADIUS, chatTurnWindow } from '../lib/chat_window.js';
import { transcriptMessages, type TranscriptMessage } from '../lib/transcript.js';
import { cn } from '../lib/utils.js';
import {
  entriesFromEvents,
  entriesFromFallback,
  type ChatMessage,
  type ChatTimelineEntry,
  type ChatToolCall,
} from '../server/chat_timeline.js';
import { Avatar } from './ui/avatar.js';
import { Button } from './ui/button.js';
import { ScrollArea } from './ui/scroll-area.js';

type ChatViewProps = {
  document: MemoryDocument | null;
  activeMemoryId: string | null;
  sessionTurns: ProjectTurnNode[];
  canLoadMoreAfter?: boolean;
  loadingMoreAfter?: boolean;
  onLoadMoreAfter?: () => void;
  loading: boolean;
  error: string | null;
};

type ChatTimelineItem =
  | { type: 'time'; key: string; timestamp: string }
  | { type: 'entry'; key: string; entry: ChatTimelineEntry; index: number };

const TIME_SEPARATOR_GAP_MS = 5 * 60 * 1000;

export function ChatView({
  document,
  activeMemoryId,
  sessionTurns,
  canLoadMoreAfter = false,
  loadingMoreAfter = false,
  onLoadMoreAfter,
  loading,
  error,
}: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeMessageRef = useRef<HTMLElement>(null);
  const [beforeLimit, setBeforeLimit] = useState(INITIAL_CHAT_CONTEXT_RADIUS);
  const [afterLimit, setAfterLimit] = useState(INITIAL_CHAT_CONTEXT_RADIUS);
  const turnWindow = useMemo(
    () => chatTurnWindow(sessionTurns, activeMemoryId, beforeLimit, afterLimit),
    [activeMemoryId, afterLimit, beforeLimit, sessionTurns],
  );
  const entries = useMemo(() => (
    sessionTurns.length > 0 ? entriesFromTurns(turnWindow.turns) : entriesFromDocument(document)
  ), [document, sessionTurns.length, turnWindow.turns]);
  const timelineItems = useMemo(() => chatTimelineItems(entries), [entries]);

  useEffect(() => {
    setBeforeLimit(INITIAL_CHAT_CONTEXT_RADIUS);
    setAfterLimit(INITIAL_CHAT_CONTEXT_RADIUS);
  }, [activeMemoryId]);

  useEffect(() => {
    if (!activeMemoryId) {
      return;
    }

    const scrollToActive = () => {
      const scroller = scrollRef.current;
      const active = scroller
        ? Array.from(scroller.querySelectorAll<HTMLElement>('.chat-message-row'))
          .find((row) => row.dataset.memoryId === activeMemoryId)
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
  }, [activeMemoryId, timelineItems.length, turnWindow.turns]);

  if (loading) {
    return <div className="empty-state">Loading conversation...</div>;
  }

  if (error) {
    return <div className="error-state">{error}</div>;
  }

  if (!document && sessionTurns.length === 0) {
    return (
      <div className="chat-empty">
        <p>Select a turn from the project tree.</p>
      </div>
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
            documentAgent: document?.agent ?? document?.observer ?? '',
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
            {loadingMoreAfter ? 'Loading...' : `Show ${Math.min(CHAT_CONTEXT_STEP, Math.max(turnWindow.afterCount, CHAT_CONTEXT_STEP))} later turns`}
          </Button>
        ) : null}
      </div>
    </ScrollArea>
  );
}

function renderTimelineEntry(params: {
  item: Extract<ChatTimelineItem, { type: 'entry' }>;
  activeMemoryId: string | null;
  activeMessageRef: React.RefObject<HTMLElement | null>;
  documentAgent: string;
}) {
  const { item, activeMemoryId, activeMessageRef, documentAgent } = params;
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
          <ToolCallList toolCalls={group.toolCalls} startedAt={group.startedAt} completedAt={group.completedAt} />
        </div>
      </section>
    );
  }

  if (item.entry.type === 'totalTime') {
    return (
      <section
        key={item.key}
        data-memory-id={item.entry.totalTime.memoryId}
        className={cn(
          'chat-message-row chat-message-row-agent chat-total-time-row',
          item.entry.totalTime.memoryId === activeMemoryId && 'chat-turn-active',
        )}
      >
        <Avatar className="chat-avatar chat-avatar-agent chat-avatar-spacer">
          <AgentAvatar logo={logoForAgent(documentAgent)} />
        </Avatar>
        <div className="chat-message-content chat-message-content-tools">
          <ChatTimeMeta
            label="total time"
            startedAt={item.entry.totalTime.startedAt}
            completedAt={item.entry.totalTime.completedAt}
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
              {message.artifacts && message.artifacts.length > 0 ? (
                <ArtifactList artifacts={message.artifacts} />
              ) : null}
            </div>
            {message.role === 'agent' ? (
              <ChatTimeMeta label="time" startedAt={message.startedAt} completedAt={message.completedAt} />
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

function chatTimelineItems(entries: ChatTimelineEntry[]): ChatTimelineItem[] {
  const items: ChatTimelineItem[] = [];
  let previousSeparatorTime: Date | null = null;
  entries.forEach((entry, index) => {
    const timestamp = timestampForEntry(entry);
    if (timestamp && shouldShowTimeSeparator(timestamp, previousSeparatorTime)) {
      items.push({
        type: 'time',
        key: `time-${timestamp}-${index}`,
        timestamp,
      });
      previousSeparatorTime = new Date(timestamp);
    }
    items.push({
      type: 'entry',
      key: keyForEntry(entry, index),
      entry,
      index,
    });
  });
  return items;
}

function timestampForEntry(entry: ChatTimelineEntry): string | undefined {
  if (entry.type === 'message') {
    return entry.message.timestamp;
  }
  if (entry.type === 'toolGroup') {
    return entry.group.timestamp;
  }
  return undefined;
}

function keyForEntry(entry: ChatTimelineEntry, index: number): string {
  if (entry.type === 'message') {
    return `${entry.message.memoryId ?? 'document'}-${entry.message.role}-${index}`;
  }
  if (entry.type === 'toolGroup') {
    return `${entry.group.memoryId ?? 'document'}-tool-${index}`;
  }
  return `${entry.totalTime.memoryId ?? 'document'}-total-time-${index}`;
}

function shouldShowTimeSeparator(timestamp: string, previous: Date | null): boolean {
  const current = new Date(timestamp);
  if (Number.isNaN(current.getTime())) {
    return false;
  }
  if (!previous) {
    return true;
  }
  return current.toDateString() !== previous.toDateString()
    || Math.abs(current.getTime() - previous.getTime()) >= TIME_SEPARATOR_GAP_MS;
}

function entriesFromDocument(document: MemoryDocument | null): ChatTimelineEntry[] {
  if (!document) {
    return [];
  }
  if (document.events && document.events.length > 0) {
    return entriesFromEvents(document.events, {
      memoryId: document.memoryId,
      agent: document.agent ?? document.observer,
      startedAt: document.createdAt,
      completedAt: document.updatedAt,
    });
  }
  if (document.prompt || document.response) {
    return entriesFromFallback({
      memoryId: document.memoryId,
      agent: document.agent ?? document.observer,
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
      agent: document.agent ?? document.observer,
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
      title: turn.title,
      summary: turn.summary,
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
    <div className="chat-time-meta" title={timeRangeTitle(startedAt, completedAt)}>
      {label}: {duration}
    </div>
  );
}

function ArtifactList({ artifacts }: { artifacts: Artifact[] }) {
  const visible = artifacts.filter((artifact) => artifact.kind !== 'metadata');
  if (visible.length === 0) {
    return null;
  }
  return (
    <div className="chat-artifact-list">
      {visible.map((artifact) => (
        artifact.kind === 'image' ? (
          <a
            key={artifact.key}
            href={artifactHref(artifact)}
            className="chat-artifact-image-link"
            target="_blank"
            rel="noreferrer"
          >
            <img src={artifactHref(artifact)} alt={artifact.name ?? artifact.key} className="chat-artifact-image" />
          </a>
        ) : (
          <a
            key={artifact.key}
            href={artifactHref(artifact)}
            className="chat-artifact-file"
            target="_blank"
            rel="noreferrer"
          >
            <span className="chat-artifact-file-name">{artifact.name ?? artifact.key}</span>
            <span className="chat-artifact-file-meta">{artifactMeta(artifact)}</span>
          </a>
        )
      ))}
    </div>
  );
}

function ToolCallList({
  toolCalls,
  startedAt,
  completedAt,
}: {
  toolCalls: ChatToolCall[];
  startedAt?: string;
  completedAt?: string;
}) {
  const summary = toolCallSummary(toolCalls);
  return (
    <>
      <details className="chat-tool-call-group">
        <summary className="chat-tool-call-group-summary">
          <span className="chat-tool-call-chevron">›</span>
          <span className="chat-tool-call-title">Tool calls: {toolCalls.length}</span>
          <span className="chat-tool-call-meta">{summary}</span>
        </summary>
        <div className="chat-tool-call-panel">
          {toolCalls.map((toolCall, index) => (
            <details key={toolCall.id ?? `${toolCall.name}-${index}`} className="chat-tool-call-row">
              <summary className="chat-tool-call-row-summary">
                <span className="chat-tool-call-chevron">›</span>
                <span className="chat-tool-call-name">{toolCall.name}</span>
                <span className="chat-tool-call-arg">{toolCallInputSummary(toolCall)}</span>
                <span className="chat-tool-call-state">{toolCall.output ? 'output' : 'input'}</span>
              </summary>
              <div className="chat-tool-call-io">
                {toolCall.input ? (
                  <div className="chat-tool-call-section">
                    <div className="chat-tool-call-label">Input</div>
                    <pre>{toolCall.input}</pre>
                  </div>
                ) : null}
                {toolCall.output ? (
                  <div className="chat-tool-call-section">
                    <div className="chat-tool-call-label">Output</div>
                    <pre>{toolCall.output}</pre>
                  </div>
                ) : null}
                <ChatTimeMeta label="time" startedAt={toolCall.startedAt} completedAt={toolCall.completedAt} />
              </div>
            </details>
          ))}
        </div>
      </details>
      <ChatTimeMeta label="time" startedAt={startedAt} completedAt={completedAt} />
    </>
  );
}

function toolCallInputSummary(toolCall: ChatToolCall): string {
  const input = toolCall.input?.trim();
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

function artifactHref(artifact: Artifact): string {
  if (!artifact.uri) {
    return '#';
  }
  if (artifact.uri.startsWith('artifact://')) {
    return `/api/v1/ui/artifacts/${encodeURIComponent(artifact.uri.slice('artifact://'.length))}`;
  }
  return artifact.uri;
}

function artifactMeta(artifact: Artifact): string {
  const parts = [
    artifact.mimeType,
    artifact.sizeBytes !== undefined ? formatBytes(artifact.sizeBytes) : undefined,
  ].filter(Boolean);
  return parts.join(' / ') || artifact.kind;
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
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
