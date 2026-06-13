import type { Artifact } from '@muninn/types';
import { Check, ChevronDown, ChevronRight, File, FileCode, FileText, Image as ImageIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { artifactPresentation } from '../lib/artifacts.js';
import { cn } from '../lib/utils.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible.js';

type ArtifactListProps = {
  artifacts: Artifact[];
  agent?: string;
  variant?: 'chat' | 'session';
};

export function ArtifactList({ artifacts, agent, variant = 'chat' }: ArtifactListProps) {
  const visible = artifacts.filter((artifact) => artifact.kind !== 'metadata');
  if (visible.length === 0) {
    return null;
  }
  if (variant === 'session') {
    return <SessionArtifactList artifacts={visible} agent={agent} />;
  }
  return (
    <div className="artifact-list artifact-list-chat">
      {visible.map((artifact) => (
        <ChatArtifactItem key={artifact.uri ?? artifact.key} artifact={artifact} agent={agent} />
      ))}
    </div>
  );
}

function SessionArtifactList({ artifacts, agent }: { artifacts: Artifact[]; agent?: string }) {
  const [fromFilter, setFromFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [fromOpen, setFromOpen] = useState(false);
  const [typeOpen, setTypeOpen] = useState(false);
  const fromOptions = useMemo(() => sessionFromOptions(artifacts, agent), [agent, artifacts]);
  const filtered = useMemo(() => artifacts.filter((artifact) => (
    (fromFilter === 'all' || originLabel(artifact, agent) === fromFilter)
    && (typeFilter === 'all' || artifactType(artifact) === typeFilter)
  )), [agent, artifacts, fromFilter, typeFilter]);

  return (
    <div className="artifact-session-shell">
      <div className="artifact-session-filters">
        <FilterMenu
          label="From"
          open={fromOpen}
          value={fromFilter}
          options={fromOptions}
          onOpenChange={(open) => {
            setFromOpen(open);
            if (open) {
              setTypeOpen(false);
            }
          }}
          onSelect={setFromFilter}
        />
        <FilterMenu
          label="Type"
          open={typeOpen}
          value={typeFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'image', label: '图片' },
            { value: 'markdown', label: 'Markdown' },
            { value: 'html', label: 'HTML' },
          ]}
          onOpenChange={(open) => {
            setTypeOpen(open);
            if (open) {
              setFromOpen(false);
            }
          }}
          onSelect={setTypeFilter}
        />
      </div>
      {filtered.length === 0 ? (
        <div className="session-artifacts-empty">No artifacts match the filters.</div>
      ) : (
        <div className="artifact-list artifact-list-session">
          {filtered.map((artifact) => (
            <SessionArtifactItem key={artifact.uri ?? artifact.key} artifact={artifact} agent={agent} />
          ))}
        </div>
      )}
    </div>
  );
}

function ChatArtifactItem({ artifact, agent }: { artifact: Artifact; agent?: string }) {
  const view = artifactPresentation(artifact);
  if (view.mode === 'image') {
    return (
      <article className="artifact-bubble artifact-bubble-image">
        <ArtifactHeader artifact={artifact} agent={agent} compact />
        <a
          href={view.href}
          className="artifact-image-link"
          target="_blank"
          rel="noreferrer"
        >
          <img src={view.href} alt={view.label} className="artifact-image-preview" />
        </a>
      </article>
    );
  }

  if (view.mode === 'markdown') {
    return (
      <article className="artifact-bubble artifact-bubble-document">
        <ArtifactHeader artifact={artifact} agent={agent} compact />
        <MarkdownPreview content={view.text ?? ''} className="artifact-markdown-preview" />
      </article>
    );
  }

  if (view.mode === 'external') {
    return <HtmlArtifactCard artifact={artifact} agent={agent} className="artifact-bubble artifact-bubble-html" />;
  }

  return (
    <a
      href={view.href}
      className="artifact-bubble artifact-bubble-file"
      target="_blank"
      rel="noreferrer"
    >
      <ArtifactHeader artifact={artifact} agent={agent} compact />
    </a>
  );
}

function SessionArtifactItem({ artifact, agent }: { artifact: Artifact; agent?: string }) {
  const view = artifactPresentation(artifact);
  if (view.mode === 'external') {
    return <SessionHtmlArtifactItem artifact={artifact} agent={agent} />;
  }

  return (
    <Collapsible className="artifact-session-item">
      <CollapsibleTrigger className="artifact-session-trigger">
        <div className="artifact-session-main">
          <ChevronRight className="artifact-chevron" aria-hidden="true" />
          <ArtifactIcon artifact={artifact} />
          <span className="artifact-name-group">
            <span className="artifact-name" title={view.label}>{view.label}</span>
            <span className="artifact-inline-meta">{view.meta}</span>
          </span>
        </div>
        <span className="artifact-origin-text">{originLabel(artifact, agent)}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="artifact-session-content">
        {view.mode === 'image' ? (
          <a
            href={view.href}
            className="artifact-session-image-link"
            target="_blank"
            rel="noreferrer"
          >
            <img src={view.href} alt={view.label} className="artifact-session-image" />
          </a>
        ) : view.mode === 'markdown' ? (
          <MarkdownPreview content={view.text ?? ''} className="artifact-markdown-preview artifact-session-markdown" />
        ) : (
          <a href={view.href} className="artifact-session-file-link" target="_blank" rel="noreferrer">
            Open file
          </a>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function SessionHtmlArtifactItem({ artifact, agent }: { artifact: Artifact; agent?: string }) {
  const view = artifactPresentation(artifact);
  return (
    <a
      href={view.href}
      className="artifact-session-link artifact-session-row-disabled"
      target="_blank"
      rel="noreferrer"
    >
      <div className="artifact-session-main">
        <ChevronRight className="artifact-chevron artifact-chevron-disabled" aria-hidden="true" />
        <ArtifactIcon artifact={artifact} />
        <span className="artifact-name-group">
          <span className="artifact-name" title={view.label}>{view.label}</span>
          <span className="artifact-inline-meta">{view.meta}</span>
        </span>
      </div>
      <span className="artifact-origin-text">{originLabel(artifact, agent)}</span>
    </a>
  );
}

function HtmlArtifactCard({
  artifact,
  className,
}: {
  artifact: Artifact;
  agent?: string;
  className?: string;
}) {
  const view = artifactPresentation(artifact);
  return (
    <article className={cn('artifact-html-card', className)}>
      <ArtifactHeader artifact={artifact} compact />
      <div className="artifact-html-body">
        <span className="artifact-html-note">HTML 无法在 App 内预览</span>
        <a href={view.href} className="artifact-html-button" target="_blank" rel="noreferrer">
          打开页面
        </a>
      </div>
    </article>
  );
}

function ArtifactHeader({ artifact, compact = false }: { artifact: Artifact; agent?: string; compact?: boolean }) {
  const view = artifactPresentation(artifact);
  return (
    <div className={cn('artifact-header', compact && 'artifact-header-compact')}>
      <ArtifactIcon artifact={artifact} />
      <span className="artifact-name" title={view.label}>{view.label}</span>
      {!compact ? <span className="artifact-meta">{view.meta}</span> : null}
    </div>
  );
}

function MarkdownPreview({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn('artifact-markdown', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

function ArtifactIcon({ artifact }: { artifact: Artifact }) {
  const view = artifactPresentation(artifact);
  const className = 'artifact-icon';
  if (view.icon === 'image') {
    return <ImageIcon className={className} aria-hidden="true" />;
  }
  if (view.icon === 'html') {
    return <FileCode className={className} aria-hidden="true" />;
  }
  if (view.icon === 'document') {
    return <FileText className={className} aria-hidden="true" />;
  }
  return <File className={className} aria-hidden="true" />;
}

function artifactMetrics(artifact: Artifact, agent?: string): string {
  const view = artifactPresentation(artifact);
  return [originLabel(artifact, agent), view.meta].filter(Boolean).join(' · ');
}

function originLabel(artifact: Artifact, agent?: string): string {
  if (artifact.source === 'prompt') {
    return 'prompt';
  }
  return agent || 'agent';
}

function artifactType(artifact: Artifact): 'image' | 'markdown' | 'html' | 'file' {
  const mode = artifactPresentation(artifact).mode;
  if (mode === 'external') {
    return 'html';
  }
  return mode;
}

function sessionFromOptions(artifacts: Artifact[], agent?: string): Array<{ value: string; label: string }> {
  const values = [...new Set(artifacts.map((artifact) => originLabel(artifact, agent)))];
  return [
    { value: 'all', label: 'All' },
    ...values.map((value) => ({ value, label: value })),
  ];
}

function FilterMenu({
  label,
  open,
  value,
  options,
  onOpenChange,
  onSelect,
}: {
  label: string;
  open: boolean;
  value: string;
  options: Array<{ value: string; label: string }>;
  onOpenChange: (open: boolean) => void;
  onSelect: (value: string) => void;
}) {
  const selected = options.find((option) => option.value === value) ?? options[0];
  return (
    <div className="toolbar-popover artifact-filter-popover">
      <button
        className="session-filter artifact-filter-trigger"
        type="button"
        onClick={() => onOpenChange(!open)}
      >
        <span>{label}: {selected.label}</span>
        <ChevronDown />
      </button>
      {open ? (
        <div className="session-popover artifact-filter-menu">
          <div className="session-popover-title">{label}</div>
          {options.map((option) => (
            <button
              key={option.value}
              className={option.value === value ? 'session-menu-item session-menu-item-active' : 'session-menu-item'}
              type="button"
              onClick={() => {
                onSelect(option.value);
                onOpenChange(false);
              }}
            >
              <span className={option.value === value ? 'menu-check menu-check-checked' : 'menu-check'}>
                {option.value === value ? <Check /> : null}
              </span>
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
