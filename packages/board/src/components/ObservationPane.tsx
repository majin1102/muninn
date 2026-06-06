import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ProjectObservationNode, ProjectTurnNode } from '../lib/api.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible.js';
import { ScrollArea } from './ui/scroll-area.js';

type ObservationPaneProps = {
  observations: ProjectObservationNode[];
  sessionSummary?: string;
  activeObservationId: string | null;
  openObservationId: string | null;
  openObservationRequestId: number;
  sessionKey: string | null;
  sessionTurns: ProjectTurnNode[];
  onActiveObservationChange: (memoryId: string | null) => void;
  onLocateTurn: (memoryId: string) => void;
};

export function ObservationPane({
  observations,
  sessionSummary,
  activeObservationId,
  openObservationId,
  openObservationRequestId,
  sessionKey,
  sessionTurns,
  onActiveObservationChange,
  onLocateTurn,
}: ObservationPaneProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [openItem, setOpenItem] = useState<string | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [scrollThumb, setScrollThumb] = useState({ height: 0, top: 0, visible: false });
  const restoreObservationId = openObservationId ?? activeObservationId;
  const turnIndexById = new Map(sessionTurns.map((turn, index) => [turn.memoryId, index + 1]));

  useEffect(() => {
    setSummaryOpen(false);
    if (!restoreObservationId) {
      setOpenItem(null);
    }
  }, [restoreObservationId, sessionKey]);

  useEffect(() => {
    if (!restoreObservationId) {
      setOpenItem(null);
      return;
    }
    setOpenItem(restoreObservationId);

    window.requestAnimationFrame(() => {
      const target = scrollRef.current
        ? Array.from(scrollRef.current.querySelectorAll<HTMLElement>('[data-observation-id]'))
          .find((item) => item.dataset.observationId === restoreObservationId)
        : null;
      target?.scrollIntoView({ block: 'center' });
    });
  }, [observations.length, restoreObservationId, openObservationRequestId]);

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
    const observer = new ResizeObserver(updateThumb);
    observer.observe(scrollElement);
    if (scrollElement.firstElementChild) {
      observer.observe(scrollElement.firstElementChild);
    }

    return () => {
      window.cancelAnimationFrame(frame);
      scrollElement.removeEventListener('scroll', updateThumb);
      observer.disconnect();
    };
  }, [observations, openItem, sessionSummary, summaryOpen]);

  return (
    <div className="observation-scroll-shell">
      <ScrollArea ref={scrollRef} className="observation-scroll">
        <div className="observation-pane-content">
          {sessionSummary ? (
            <Collapsible open={summaryOpen} onOpenChange={setSummaryOpen}>
              <section className="observation-session-summary">
                <CollapsibleTrigger className="observation-summary-trigger">
                  <span>Summary</span>
                  <ChevronRight className="observation-chevron" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="observation-summary-markdown">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{sessionSummary}</ReactMarkdown>
                  </div>
                </CollapsibleContent>
              </section>
            </Collapsible>
          ) : null}
          {observations.length === 0 ? (
            <div className="observation-empty">No observations for this session.</div>
          ) : (
            <div className="observation-list">
              {observations.map((observation) => {
                const open = openItem === observation.memoryId;
                return (
                  <div
                    key={observation.memoryId}
                    data-observation-id={observation.memoryId}
                    className={observation.memoryId === activeObservationId ? 'observation-item observation-item-active' : 'observation-item'}
                  >
                    <Collapsible
                      open={open}
                      onOpenChange={(nextOpen) => {
                        setOpenItem(nextOpen ? observation.memoryId : null);
                        if (nextOpen) {
                          onActiveObservationChange(observation.memoryId);
                        } else if (observation.memoryId === activeObservationId) {
                          onActiveObservationChange(null);
                        }
                      }}
                    >
                      <CollapsibleTrigger className="observation-trigger">
                        <span className="observation-title">{observation.title}</span>
                        <ChevronRight className="observation-chevron" />
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <div className="observation-markdown">
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
                                const label = turnNumber
                                  ? `detail: turn ${turnNumber}`
                                  : `detail: ${turnId.replace(/^turn:/, 'turn ')}`;
                                return (
                                  <button
                                    className="observation-inline-citation"
                                    type="button"
                                    title={turnNumber ? `Go to turn #${turnNumber}` : 'Go to referenced turn'}
                                    onClick={() => onLocateTurn(turnId)}
                                  >
                                    [{label}]
                                  </button>
                                );
                              },
                            }}
                          >
                            {displayObservationMarkdown(observation.markdown)}
                          </ReactMarkdown>
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </ScrollArea>
      {scrollThumb.visible ? (
        <div className="observation-scrollbar-overlay" aria-hidden="true">
          <div
            className="observation-scrollbar-thumb"
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

const TURN_CITATION_HREF_PREFIX = '#muninn-turn=';

function displayObservationMarkdown(markdown: string): string {
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
