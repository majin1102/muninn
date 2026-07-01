import type { ProjectDreamSignalViewRow, ProjectDreamSkillViewRow, ProjectDreamView } from '@muninn/common';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertTriangle, CheckCircle2, ChevronRight, List, Target, type LucideIcon } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn, formatRelativeTime, formatTimestamp } from '../lib/utils.js';
import { ScrollArea } from './ui/scroll-area.js';

type DreamingContentProps = {
  projectLabel: string;
  dream: ProjectDreamView | null | undefined;
  error: string | null;
  loading: boolean;
  onRetry: () => void;
};

export function DreamingContent({
  projectLabel,
  dream,
  error,
  loading,
  onRetry,
}: DreamingContentProps) {
  const [tab, setTab] = useState<'memories' | 'skills'>('memories');
  const [selectedSkillName, setSelectedSkillName] = useState<string | null>(null);
  const skills = dream?.skills ?? [];
  const selectedSkill = useMemo(() => (
    skills.find((skill) => skill.name === selectedSkillName) ?? skills[0] ?? null
  ), [selectedSkillName, skills]);

  useEffect(() => {
    if (skills.length === 0) {
      setSelectedSkillName(null);
      return;
    }
    if (!selectedSkillName || !skills.some((skill) => skill.name === selectedSkillName)) {
      setSelectedSkillName(skills[0]!.name);
    }
  }, [selectedSkillName, skills]);

  return (
    <div className="dreaming-content" aria-label={projectLabel}>
      <div className="dreaming-header">
        <div className="dreaming-tabs" role="tablist" aria-label="Dreaming content">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'memories'}
            className={cn('dreaming-tab', tab === 'memories' && 'dreaming-tab-active')}
            onClick={() => setTab('memories')}
          >
            Memories
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'skills'}
            className={cn('dreaming-tab', tab === 'skills' && 'dreaming-tab-active')}
            onClick={() => setTab('skills')}
          >
            Skills
          </button>
        </div>
      </div>
      <ScrollArea className="dreaming-scroll">
        {error ? (
          <DreamingError error={error} onRetry={onRetry} />
        ) : null}
        {loading && !dream ? null : tab === 'memories' ? (
          <DreamingMemories
            memorySignals={dream?.memorySignals ?? []}
          />
        ) : (
          <DreamingSkills
            skills={skills}
            selectedSkill={selectedSkill}
            onSelectSkill={setSelectedSkillName}
          />
        )}
      </ScrollArea>
    </div>
  );
}

function DreamingError({
  error,
  onRetry,
}: {
  error: string;
  onRetry: () => void;
}) {
  return (
    <div className="dreaming-error-panel" role="alert">
      <AlertTriangle className="dreaming-error-icon" aria-hidden="true" />
      <div className="dreaming-error-copy">
        <div className="dreaming-error-title">Failed to load project dreaming</div>
        <div className="dreaming-error-message">{error}</div>
      </div>
      <button className="dreaming-error-action" type="button" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

function DreamingMemories({
  memorySignals,
}: {
  memorySignals: ProjectDreamSignalViewRow[];
}) {
  return (
    <div className="dreaming-memories">
      {memorySignals.length > 0 ? (
        <SignalTable rows={memorySignals} />
      ) : null}
    </div>
  );
}

function SignalTable({
  rows,
}: {
  rows: ProjectDreamSignalViewRow[];
}) {
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  function toggleRow(key: string) {
    setExpandedRows((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  return (
    <section className="dreaming-section">
      <table className="dreaming-table">
        <colgroup>
          <col className="dreaming-expand-col" />
          <col className="dreaming-signal-col" />
          <col className="dreaming-score-col" />
          <col className="dreaming-time-col" />
        </colgroup>
        <thead>
          <tr>
            <th className="dreaming-expand-column" aria-label="Expand evidence" />
            <th>Signal</th>
            <th className="dreaming-score-column">Score</th>
            <th className="dreaming-time-column">Time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const key = signalRowKey(row, index);
            const expanded = expandedRows.has(key);
            const supportTurns = row.supportTurns ?? [];
            return (
              <SignalTableRows
                key={key}
                rowKey={key}
                row={row}
                expanded={expanded}
                supportTurns={supportTurns}
                onToggle={toggleRow}
              />
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function SignalTableRows({
  row,
  rowKey,
  expanded,
  supportTurns,
  onToggle,
}: {
  row: ProjectDreamSignalViewRow;
  rowKey: string;
  expanded: boolean;
  supportTurns: ProjectDreamSignalViewRow['supportTurns'];
  onToggle: (key: string) => void;
}) {
  const canExpand = supportTurns.length > 0;
  return (
    <>
      <tr className={cn('dreaming-signal-row', expanded && 'dreaming-signal-row-expanded')}>
        <td className="dreaming-expand-cell">
          {canExpand ? (
            <button
              type="button"
              className="dreaming-memory-signal-toggle"
              aria-label={expanded ? 'Collapse signal evidence' : 'Expand signal evidence'}
              aria-expanded={expanded}
              onClick={() => onToggle(rowKey)}
            >
              <ChevronRight className="tree-chevron" aria-hidden="true" />
            </button>
          ) : (
            <span className="dreaming-memory-signal-toggle-placeholder" />
          )}
        </td>
        <td className="dreaming-signal-cell">{row.text}</td>
        <td className="dreaming-score-cell">{formatSignalScore(row.score)}</td>
        <td className="dreaming-time-cell">
          <Timestamp value={row.updatedAt} />
        </td>
      </tr>
      {expanded ? row.supportTurns.map((support) => (
        <tr className="dreaming-support-row" key={`${rowKey}:${support.turnId}:${support.createdAt}`}>
          <td className="dreaming-expand-cell" />
          <td className="dreaming-signal-cell dreaming-support-cell">
            <ClampedSupportContent text={support.content ?? 'Turn content unavailable'} />
          </td>
          <td className="dreaming-score-cell">{formatSignalScore(support.score)}</td>
          <td className="dreaming-time-cell">
            <Timestamp value={support.createdAt} />
          </td>
        </tr>
      )) : null}
    </>
  );
}

function Timestamp({ value }: { value?: string | null }) {
  if (!value) {
    return <span className="dreaming-empty-time">-</span>;
  }
  return (
    <time dateTime={value} title={formatTimestamp(value)}>
      {formatRelativeTime(value)}
    </time>
  );
}

function signalRowKey(row: ProjectDreamSignalViewRow, index: number): string {
  return `${row.updatedAt ?? 'none'}:${row.score}:${row.text}:${index}`;
}

function DreamingSkills({
  skills,
  selectedSkill,
  onSelectSkill,
}: {
  skills: ProjectDreamSkillViewRow[];
  selectedSkill: ProjectDreamSkillViewRow | null;
  onSelectSkill: (name: string) => void;
}) {
  if (skills.length === 0) {
    return null;
  }

  return (
    <div className="dreaming-skills">
      <div className="dreaming-skill-list" aria-label="Skills">
        {skills.map((skill) => (
          <button
            key={skill.name}
            className={cn(
              'dreaming-skill-row',
              selectedSkill?.name === skill.name && 'dreaming-skill-row-active',
            )}
            type="button"
            onClick={() => onSelectSkill(skill.name)}
          >
            <span className="dreaming-skill-main">
              <span className="dreaming-skill-heading">
                <span className="dreaming-skill-name">{skill.name}</span>
                <span className="dreaming-skill-weight">{formatSignalScore(skill.score)}</span>
              </span>
              <ClampedSkillSummary text={skill.summary} />
            </span>
          </button>
        ))}
      </div>
      <div className="dreaming-skill-detail">
        {selectedSkill ? (
          <div className="dreaming-skill-detail-inner">
            <div className="dreaming-skill-detail-heading">
              <h2>
                <span>{selectedSkill.name}</span>
                <span className="dreaming-skill-weight">{formatSignalScore(selectedSkill.score)}</span>
              </h2>
              {selectedSkill.summary ? <p>{selectedSkill.summary}</p> : null}
            </div>
            {selectedSkill.detail ? (
              <div className="artifact-markdown dreaming-skill-markdown">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    h2: ({ children }) => <SkillDetailHeading>{children}</SkillDetailHeading>,
                    h3: ({ children }) => <SkillDetailHeading>{children}</SkillDetailHeading>,
                    h4: ({ children }) => <SkillDetailHeading>{children}</SkillDetailHeading>,
                  }}
                >
                  {selectedSkill.detail}
                </ReactMarkdown>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ClampedSkillSummary({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const update = () => {
      const next = element.scrollHeight > element.clientHeight + 1
        || element.scrollWidth > element.clientWidth + 1;
      setOverflowing((current) => (current === next ? current : next));
    };
    update();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  if (!text) {
    return null;
  }

  return (
    <span ref={ref} className="dreaming-skill-summary" title={overflowing ? text : undefined}>
      {text}
    </span>
  );
}

function ClampedSupportContent({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const update = () => {
      const next = element.scrollHeight > element.clientHeight + 1
        || element.scrollWidth > element.clientWidth + 1;
      setOverflowing((current) => (current === next ? current : next));
    };
    update();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  return (
    <span ref={ref} className="dreaming-support-content" title={overflowing ? text : undefined}>
      {text}
    </span>
  );
}

function formatSignalScore(score: number): string {
  return `[${Number.isInteger(score) ? score : score.toFixed(2)}]`;
}

function SkillDetailHeading({ children }: { children: ReactNode }) {
  const text = reactText(children);
  const Icon = skillDetailIcon(text);
  return (
    <h2 className="dreaming-skill-section-heading">
      <span className="dreaming-skill-section-icon">
        <Icon aria-hidden="true" />
      </span>
      <span>{children}</span>
    </h2>
  );
}

function skillDetailIcon(text: string): LucideIcon {
  const normalized = text.toLowerCase();
  if (normalized.includes('pitfall')) {
    return AlertTriangle;
  }
  if (normalized.includes('verification')) {
    return CheckCircle2;
  }
  if (normalized.includes('procedure')) {
    return List;
  }
  return Target;
}

function reactText(value: ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(reactText).join('');
  }
  return '';
}
