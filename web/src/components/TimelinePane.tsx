import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronRight, MessageSquare } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ProjectTimelineNode, ProjectTurnNode } from '../lib/api.js';
import { cn } from '../lib/utils.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible.js';
import { EmptyState } from './ui/empty-state.js';
import { ScrollArea } from './ui/scroll-area.js';

type TimelinePaneProps = {
  timeline: ProjectTimelineNode[];
  loading: boolean;
  activeTimelineId: string | null;
  openTimelineId: string | null;
  openTimelineRequestId: number;
  sessionKey: string | null;
  sessionTurns: ProjectTurnNode[];
  onActiveTimelineChange: (memoryId: string | null) => void;
  onLocateTurn: (memoryId: string) => void;
};

export function TimelinePane({
  timeline,
  loading,
  activeTimelineId,
  openTimelineId,
  openTimelineRequestId,
  sessionKey,
  sessionTurns,
  onActiveTimelineChange,
  onLocateTurn,
}: TimelinePaneProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [openItems, setOpenItems] = useState<Set<string>>(() => new Set());
  const [scrollThumb, setScrollThumb] = useState({ height: 0, top: 0, visible: false });
  const showLoading = useDelayedBoolean(loading, 150);
  const restoreTimelineId = openTimelineId ?? activeTimelineId;
  const turnIndexById = new Map(sessionTurns.map((turn, index) => [turn.memoryId, index + 1]));

  useEffect(() => {
    setOpenItems(new Set());
  }, [sessionKey]);

  useEffect(() => {
    if (!restoreTimelineId) {
      return;
    }
    setOpenItems((current) => {
      if (current.has(restoreTimelineId)) {
        return current;
      }
      const next = new Set(current);
      next.add(restoreTimelineId);
      return next;
    });

    window.requestAnimationFrame(() => {
      const target = scrollRef.current
        ? Array.from(scrollRef.current.querySelectorAll<HTMLElement>('[data-timeline-id]'))
          .find((item) => item.dataset.timelineId === restoreTimelineId)
        : null;
      target?.scrollIntoView({ block: 'center' });
    });
  }, [timeline.length, restoreTimelineId, openTimelineRequestId, sessionKey]);

  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) {
      return;
    }

    let frame = 0;
    const updateThumb = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const maxScroll = scrollElement.scrollHeight - scrollElement.clientHeight;
        if (maxScroll <= 1) {
          setScrollThumb((current) => (current.visible ? { height: 0, top: 0, visible: false } : current));
          return;
        }

        const trackHeight = scrollElement.clientHeight;
        const height = Math.max(24, Math.round((trackHeight / scrollElement.scrollHeight) * trackHeight));
        const top = Math.round((scrollElement.scrollTop / maxScroll) * (trackHeight - height));
        setScrollThumb((current) => {
          if (current.visible && current.height === height && current.top === top) {
            return current;
          }
          return { height, top, visible: true };
        });
      });
    };

    updateThumb();
    scrollElement.addEventListener('scroll', updateThumb, { passive: true });
    const resizeWatcher = new ResizeObserver(updateThumb);
    resizeWatcher.observe(scrollElement);
    if (scrollElement.firstElementChild) {
      resizeWatcher.observe(scrollElement.firstElementChild);
    }

    return () => {
      window.cancelAnimationFrame(frame);
      scrollElement.removeEventListener('scroll', updateThumb);
      resizeWatcher.disconnect();
    };
  }, [timeline, openItems]);

  return (
    <div className="timeline-scroll-shell">
      <ScrollArea ref={scrollRef} className="timeline-scroll">
        <div className={cn('timeline-pane-content', loading && 'timeline-pane-content-loading')}>
          {showLoading ? (
            <EmptyState className="timeline-loading-panel" icon={MessageSquare} title="loading timeline..." />
          ) : loading ? (
            null
          ) : timeline.length === 0 ? (
            <div className="timeline-empty">No timeline for this session.</div>
          ) : (
            <div className="timeline-list">
              {timeline.map((item) => {
                const open = openItems.has(item.memoryId);
                return (
                  <section
                    key={item.memoryId}
                    data-timeline-id={item.memoryId}
                    className={cn(
                      'timeline-item',
                      `timeline-item-${item.kind}`,
                      item.memoryId === activeTimelineId && 'timeline-item-active',
                    )}
                  >
                    <Collapsible
                      open={open}
                      onOpenChange={(nextOpen) => {
                        setOpenItems((current) => {
                          const next = new Set(current);
                          if (nextOpen) {
                            next.add(item.memoryId);
                          } else {
                            next.delete(item.memoryId);
                          }
                          return next;
                        });
                        if (nextOpen) {
                          onActiveTimelineChange(item.memoryId);
                        } else if (item.memoryId === activeTimelineId) {
                          onActiveTimelineChange(null);
                        }
                      }}
                    >
                      <CollapsibleTrigger className="timeline-trigger">
                        <span className="timeline-title">{item.title}</span>
                        <ChevronRight className="timeline-chevron" />
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <div className="timeline-markdown">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                              a: ({ href, children }) => {
                                const turnId = href?.startsWith(TURN_CITATION_HREF_PREFIX)
                                  ? decodeURIComponent(href.slice(TURN_CITATION_HREF_PREFIX.length))
                                  : null;
                                if (!turnId) {
                                  return <a href={href}>{children}</a>;
                                }
                                const turnNumber = turnIndexById.get(turnId);
                                const label = `detail: ${turnId.replace(/^turn:/, 'turn ')}`;
                                return (
                                  <button
                                    className="timeline-inline-citation"
                                    type="button"
                                    title={turnNumber ? `Go to session turn #${turnNumber} (${turnId})` : `Go to ${turnId}`}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      onLocateTurn(turnId);
                                    }}
                                  >
                                    [{label}]
                                  </button>
                                );
                              },
                            }}
                          >
                            {displayTimelineMarkdown(item.markdown)}
                          </ReactMarkdown>
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </ScrollArea>
      {scrollThumb.visible ? (
        <div className="timeline-scrollbar-overlay" aria-hidden="true">
          <div
            className="timeline-scrollbar-thumb"
            style={{
              height: `${scrollThumb.height}px`,
              transform: `translateY(${scrollThumb.top}px)`,
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

function useDelayedBoolean(value: boolean, delayMs: number): boolean {
  const [delayed, setDelayed] = useState(false);

  useEffect(() => {
    if (!value) {
      setDelayed(false);
      return undefined;
    }

    const timer = window.setTimeout(() => setDelayed(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);

  return value && delayed;
}

const TURN_CITATION_HREF_PREFIX = '#muninn-turn=';

function displayTimelineMarkdown(markdown: string): string {
  return markdown
    .split('\n')
    .filter((line) => !/^###\s+(Summary|Content)\s*$/i.test(line.trim()))
    .join('\n')
    .replace(/@\[turn:([^\]]+)\]/g, (_, turnId: string) => {
      const normalizedTurnId = `turn:${turnId.trim().replace(/^turn:/, '')}`;
      return `[detail: ${normalizedTurnId.replace(':', ' ')}](${TURN_CITATION_HREF_PREFIX}${encodeURIComponent(normalizedTurnId)})`;
    })
    .replace(/^\s+/, '')
    .trimEnd();
}
