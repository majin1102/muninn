import { ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BoardClient } from '../lib/api.js';
import type { ImportAgentProject, ImportSessionsListResponse } from '@muninn/types';
import { asErrorMessage, formatRelativeTime, formatTimestamp } from '../lib/utils.js';
import { Button } from './ui/button.js';
import { Switch } from './ui/switch.js';

type LoadStatus = 'loading' | 'ready' | 'error';

export function ImportSettings({ client }: { client: BoardClient }) {
  const [codex, setCodex] = useState<ImportSessionsListResponse | null>(null);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const loadCodex = useCallback(() => {
    setStatus('loading');
    setError(null);
    client.listCodexImportSessions()
      .then((response) => {
        setCodex(response);
        setStatus('ready');
      })
      .catch((loadError: unknown) => {
        setError(asErrorMessage(loadError));
        setStatus('error');
      });
  }, [client]);

  useEffect(() => {
    loadCodex();
  }, [loadCodex]);

  return (
    <div className="import-settings">
      <AgentSection
        label="Codex"
        status={status === 'ready' && codex ? `Connected · ${codex.sourceRoot}` : status === 'loading' ? 'Scanning…' : 'Unavailable'}
        supported
        loading={status === 'loading'}
        error={status === 'error' ? error : null}
        projects={codex?.projects ?? []}
        onImport={() => setPickerOpen(true)}
      />
      <AgentSection label="Claude Code" status="Detected · adapter pending · ~/.claude/projects" supported={false} placeholder="Claude Code adapter coming soon. Sessions are detected but capture and import are not wired yet." />
      <AgentSection label="Trae" status="Not found" supported={false} placeholder="No Trae data directory found on this machine. Connect Trae to enable capture." />

      {pickerOpen && codex ? (
        <ImportPicker
          agentLabel="Codex"
          projects={codex.projects}
          onCancel={() => setPickerOpen(false)}
          onImport={async (paths) => {
            await client.importCodexSessionsByPaths(paths);
            setPickerOpen(false);
            loadCodex();
          }}
        />
      ) : null}
    </div>
  );
}

function AgentSection({
  label,
  status,
  supported,
  loading,
  error,
  projects = [],
  placeholder,
  onImport,
}: {
  label: string;
  status: string;
  supported: boolean;
  loading?: boolean;
  error?: string | null;
  projects?: ImportAgentProject[];
  placeholder?: string;
  onImport?: () => void;
}) {
  // Per-agent default auto-capture. Capture policy persistence is deferred; this is local UI state for now.
  const [defaultCapture, setDefaultCapture] = useState(true);

  return (
    <section className="import-agent">
      <div className="import-agent-head">
        <span className="import-agent-name">{label}</span>
        {supported ? (
          <span className="import-agent-link" role="button" tabIndex={0} onClick={onImport} onKeyDown={(event) => { if (event.key === 'Enter') onImport?.(); }}>
            Import
          </span>
        ) : null}
      </div>
      <div className="import-agent-subrow">
        <span className="import-agent-sub">{status}</span>
        <span className="import-agent-spacer" />
        {supported ? (
          <span className="import-capture-ctl">
            <span className="import-ctl-label">auto-capture</span>
            <Switch checked={defaultCapture} onChange={setDefaultCapture} ariaLabel={`${label} default auto-capture`} />
          </span>
        ) : null}
      </div>

      {!supported ? (
        <div className="import-empty">{placeholder}</div>
      ) : error ? (
        <div className="import-empty">{error}</div>
      ) : loading ? (
        <div className="import-empty">Scanning sessions…</div>
      ) : projects.length === 0 ? (
        <div className="import-empty">No sessions found.</div>
      ) : (
        <div className="import-card">
          {projects.map((project) => (
            <ProjectRow key={project.projectKey} project={project} />
          ))}
        </div>
      )}
    </section>
  );
}

function ProjectRow({ project }: { project: ImportAgentProject }) {
  const [open, setOpen] = useState(false);
  const [auto, setAuto] = useState(project.importedCount > 0);
  const latestUpdatedAt = project.sessions[0]?.updatedAt ?? '';

  return (
    <div className={open ? 'import-proj import-proj-open' : 'import-proj'}>
      <div className="import-proj-row" role="button" tabIndex={0} onClick={() => setOpen((value) => !value)} onKeyDown={(event) => { if (event.key === 'Enter') setOpen((value) => !value); }}>
        <ChevronRight className="tree-chevron import-chev" />
        <span className="import-proj-main">
          <span className="import-proj-name">{project.projectKey}</span>
          <span className="import-proj-sub">{project.sessionCount} sessions{project.importedCount > 0 ? ` · ${project.importedCount} captured` : ''}</span>
        </span>
        <span className="import-proj-meta">
          {latestUpdatedAt ? (
            <span className="tree-meta tree-time" title={formatTimestamp(latestUpdatedAt)}>{formatRelativeTime(latestUpdatedAt)}</span>
          ) : null}
          <span className="import-capture-ctl" onClick={(event) => event.stopPropagation()}>
            <span className="import-ctl-label">auto-capture</span>
            <Switch checked={auto} onChange={setAuto} ariaLabel={`${project.projectKey} auto-capture`} />
          </span>
        </span>
      </div>
      {open ? (
        <div className="import-sess-list">
          {project.sessions.map((session) => (
            <div className="import-sess" key={session.sessionId}>
              <span className="import-sess-title">{session.title}</span>
              <span className={session.imported ? 'import-sess-cap' : 'import-sess-cap import-sess-cap-off'}>{session.imported ? 'Captured' : 'Not captured'}</span>
              <span className="tree-meta tree-time" title={formatTimestamp(session.updatedAt)}>{formatRelativeTime(session.updatedAt)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ImportPicker({
  agentLabel,
  projects,
  onCancel,
  onImport,
}: {
  agentLabel: string;
  projects: ImportAgentProject[];
  onCancel: () => void;
  onImport: (sourcePaths: string[]) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);

  const needle = query.trim().toLowerCase();
  const groups = useMemo(
    () => projects
      .map((project) => ({
        projectKey: project.projectKey,
        sessions: project.sessions.filter((session) => !needle
          || session.title.toLowerCase().includes(needle)
          || project.projectKey.toLowerCase().includes(needle)),
      }))
      .filter((group) => group.sessions.length > 0),
    [needle, projects],
  );
  const selectable = groups.flatMap((group) => group.sessions).filter((session) => !session.imported);
  const allSelected = selectable.length > 0 && selectable.every((session) => selected.has(session.sourcePath));

  function toggle(path: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  function toggleAll() {
    setSelected((current) => {
      const next = new Set(current);
      if (allSelected) {
        selectable.forEach((session) => next.delete(session.sourcePath));
      } else {
        selectable.forEach((session) => next.add(session.sourcePath));
      }
      return next;
    });
  }

  return (
    <div className="import-overlay" onClick={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div className="import-modal" role="dialog" aria-label={`Import ${agentLabel} sessions`}>
        <div className="import-modal-head">
          <div className="import-modal-title">Import {agentLabel} sessions</div>
          <div className="import-modal-sub">Select local sessions to import. Already-captured sessions are dimmed.</div>
        </div>
        <div className="import-modal-tools">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search sessions…" />
          <span className="import-modal-selall" role="button" tabIndex={0} onClick={toggleAll} onKeyDown={(event) => { if (event.key === 'Enter') toggleAll(); }}>
            {allSelected ? 'Clear all' : 'Select all'}
          </span>
        </div>
        <div className="import-modal-body">
          {groups.length === 0 ? (
            <div className="import-empty">No sessions match.</div>
          ) : groups.map((group) => (
            <div className="import-pick-group" key={group.projectKey}>
              <div className="import-pick-group-head">
                <span className="import-pick-group-name">{group.projectKey}</span>
                <span className="import-pick-group-meta">{group.sessions.length} sessions</span>
              </div>
              {group.sessions.map((session) => {
                const isSel = selected.has(session.sourcePath);
                return (
                  <div
                    className={`import-pick${session.imported ? ' import-pick-dim' : ''}${isSel ? ' import-pick-sel' : ''}`}
                    key={session.sourcePath}
                    role="button"
                    tabIndex={session.imported ? -1 : 0}
                    onClick={() => { if (!session.imported) toggle(session.sourcePath); }}
                    onKeyDown={(event) => { if (event.key === 'Enter' && !session.imported) toggle(session.sourcePath); }}
                  >
                    <span className="import-cb">{isSel ? '✓' : ''}</span>
                    <span className="import-pick-title">{session.title}</span>
                    <span className="import-pick-meta" title={formatTimestamp(session.updatedAt)}>{session.imported ? <span className="import-tag">captured</span> : `${session.turnCount}t · ${formatRelativeTime(session.updatedAt)}`}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="import-modal-foot">
          <span className="import-modal-count">{selected.size} selected</span>
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <Button
            size="sm"
            disabled={selected.size === 0 || importing}
            onClick={async () => {
              setImporting(true);
              try {
                await onImport([...selected]);
              } finally {
                setImporting(false);
              }
            }}
          >
            {importing ? 'Importing…' : 'Import'}
          </Button>
        </div>
      </div>
    </div>
  );
}
