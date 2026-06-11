import { Bot, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BoardClient } from '../lib/api.js';
import type {
  ImportAgentProject,
  ImportAgentSession,
  ImportSelectedResponse,
  ImportSessionsListResponse,
} from '@muninn/types';
import { logoForAgent, type AgentLogo } from '../lib/agent_logo.js';
import { asErrorMessage, formatRelativeTime, formatTimestamp } from '../lib/utils.js';
import { Button } from './ui/button.js';
import { Switch } from './ui/switch.js';

type LoadStatus = 'loading' | 'ready' | 'error';
type ImportAgentKey = 'codex' | 'claude-code';

const IMPORT_AGENTS: Array<{ key: ImportAgentKey; label: string }> = [
  { key: 'codex', label: 'Codex' },
  { key: 'claude-code', label: 'Claude Code' },
];

export function ImportSettings({ client }: { client: BoardClient }) {
  const codex = useImportAgent(client, 'codex');
  const claude = useImportAgent(client, 'claude-code');
  const agents = [
    { key: 'codex' as const, label: 'Codex', data: codex },
    { key: 'claude-code' as const, label: 'Claude Code', data: claude },
  ];
  const [pickerAgent, setPickerAgent] = useState<ImportAgentKey | null>(null);

  return (
    <div className="import-settings">
      <section className="import-section">
        <div className="import-section-head">
          <h2>Agent capture</h2>
          <span>Include agents in automatic session capture.</span>
        </div>
        <div className="import-card">
          {agents.map(({ key, label, data }) => (
            <AgentCaptureRow key={key} agent={key} label={label} sourceRoot={data.imported?.sourceRoot} />
          ))}
        </div>
      </section>

      <section className="import-section">
        <div className="import-section-head">
          <h2>Project capture</h2>
          <span>Include imported projects in automatic session capture.</span>
        </div>
        <div className="import-card">
          <button className="import-action-row" type="button" onClick={() => setPickerAgent('codex')}>
            <Plus className="import-action-icon" aria-hidden="true" />
            <span>Import projects...</span>
          </button>
          {agents.map(({ key, data }) => (
            <ProjectCaptureList
              key={key}
              client={client}
              agent={key}
              loadImported={data.loadImported}
              projects={data.imported?.projects ?? []}
              status={data.status}
              error={data.error}
            />
          ))}
        </div>
      </section>

      {pickerAgent ? (
        <ImportPicker
          agentLabel={IMPORT_AGENTS.find((agent) => agent.key === pickerAgent)?.label ?? pickerAgent}
          ensureScan={pickerAgent === 'codex' ? codex.ensureScan : claude.ensureScan}
          importedSessionIds={pickerAgent === 'codex' ? codex.importedSessionIds : claude.importedSessionIds}
          onCancel={() => setPickerAgent(null)}
          onImport={async (paths) => {
            const result = await client.importSessionsByPaths(pickerAgent, paths);
            if (pickerAgent === 'codex') {
              codex.setImportResult(result);
              codex.loadImported();
            } else {
              claude.setImportResult(result);
              claude.loadImported();
            }
            setPickerAgent(null);
          }}
        />
      ) : null}
    </div>
  );
}

function useImportAgent(client: BoardClient, agent: ImportAgentKey) {
  const [imported, setImported] = useState<ImportSessionsListResponse | null>(null);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const scanPromiseRef = useRef<Promise<ImportSessionsListResponse> | null>(null);
  const [, setImportResult] = useState<ImportSelectedResponse | null>(null);

  const loadImported = useCallback(() => {
    setStatus('loading');
    setError(null);
    client.listImportSessions(agent, 'imported')
      .then((response) => {
        setImported(response);
        setStatus('ready');
      })
      .catch((loadError: unknown) => {
        setError(asErrorMessage(loadError));
        setStatus('error');
      });
  }, [agent, client]);

  useEffect(() => {
    loadImported();
  }, [loadImported]);

  // The local-disk scan is slow (hundreds of transcripts); run it once on demand
  // and share the promise between the reveal rows and the import picker.
  const ensureScan = useCallback((): Promise<ImportSessionsListResponse> => {
    if (scanPromiseRef.current) {
      return scanPromiseRef.current;
    }
    setScanError(null);
    const promise = client.listImportSessions(agent)
      .catch((scanFailure: unknown) => {
        scanPromiseRef.current = null;
        setScanError(asErrorMessage(scanFailure));
        throw scanFailure;
      });
    scanPromiseRef.current = promise;
    return promise;
  }, [agent, client]);

  const importedProjects = imported?.projects ?? [];
  const importedSessionIds = useMemo(
    () => new Set(importedProjects.flatMap((project) => project.sessions.map((session) => session.sessionId))),
    [importedProjects],
  );

  return { imported, status, error: scanError ?? error, ensureScan, importedSessionIds, loadImported, setImportResult };
}

function AgentCaptureRow({ agent, label, sourceRoot }: { agent: string; label: string; sourceRoot?: string }) {
  const [capture, setCapture] = useState(true);
  const logo = logoForAgent(agent);

  return (
    <div className="import-agent-row">
      <span className="import-agent-main">
        <AgentLogoIcon logo={logo} variant="agent" />
        <span className="import-agent-name">{label}</span>
        {sourceRoot ? <span className="import-inline-meta">{sourceRoot}</span> : null}
      </span>
      <Switch size="sm" checked={capture} onChange={setCapture} ariaLabel={`${label} capture`} />
    </div>
  );
}

function ProjectCaptureList({
  client,
  agent,
  loadImported,
  projects,
  status,
  error,
}: {
  client: BoardClient;
  agent: ImportAgentKey;
  loadImported: () => void;
  projects: ImportAgentProject[];
  status: LoadStatus;
  error: string | null;
}) {
  if (status === 'error') {
    return <div className="import-empty-row">{error}</div>;
  }
  if (status === 'loading' && projects.length === 0) {
    return <div className="import-empty-row">Loading captured sessions...</div>;
  }
  return (
    <>
      {projects.map((project) => (
        <ProjectRow key={`${agent}:${project.projectKey}`} client={client} agent={agent} project={project} loadImported={loadImported} />
      ))}
    </>
  );
}

function ProjectRow({
  client,
  agent,
  project,
  loadImported,
}: {
  client: BoardClient;
  agent: ImportAgentKey;
  project: ImportAgentProject;
  loadImported: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [capture, setCapture] = useState(project.captureEnabled ?? false);

  return (
    <div className={`import-proj${open ? ' import-proj-open' : ''}`}>
      <div className="import-proj-row" role="button" tabIndex={0} onClick={() => setOpen((value) => !value)} onKeyDown={(event) => { if (event.key === 'Enter') setOpen((value) => !value); }}>
        <ChevronRight className="tree-chevron import-chev" />
        <span className="import-proj-main">
          <span className="import-proj-title-line">
            <span className="import-proj-name">{project.projectKey}</span>
            <span className="import-inline-meta">{project.sessionCount} sessions</span>
          </span>
          <span className="import-proj-sub">{project.cwd}</span>
        </span>
        <span onClick={(event) => event.stopPropagation()}>
          <Switch
            size="sm"
            checked={capture}
            onChange={(value) => {
              setCapture(value);
              void client.setCapturePolicy(agent, project.projectKey, value).then(loadImported);
            }}
            ariaLabel={`${project.projectKey} capture`}
          />
        </span>
      </div>
      {open ? (
        <div className="import-sess-list">
          {project.sessions.map((session) => (
            <SessionRow key={session.sessionId} session={session} agent={agent} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SessionRow({ session, agent }: { session: ImportAgentSession; agent: string }) {
  const logo = logoForAgent(agent);

  return (
    <div className="import-sess">
      <span className="import-sess-title">
        <AgentLogoIcon logo={logo} variant="session" />
        <span>{session.title}</span>
      </span>
      <span className="tree-meta tree-time" title={formatTimestamp(session.updatedAt)}>{formatRelativeTime(session.updatedAt)}</span>
      <button className="import-delete-button" type="button" aria-label={`Delete ${session.title}`}>
        <Trash2 aria-hidden="true" />
      </button>
    </div>
  );
}

function AgentLogoIcon({ logo, variant }: { logo: AgentLogo; variant: 'agent' | 'session' }) {
  return (
    <span className={variant === 'agent' ? 'import-agent-logo' : 'import-session-agent-logo'} title={logo.label}>
      {logo.fallback ? (
        <Bot className="agent-logo-fallback" aria-label={logo.label} />
      ) : (
        <img src={logo.src} alt={logo.label} className="agent-logo-image" />
      )}
    </span>
  );
}

function ImportPicker({
  agentLabel,
  ensureScan,
  importedSessionIds,
  onCancel,
  onImport,
}: {
  agentLabel: string;
  ensureScan: () => Promise<ImportSessionsListResponse>;
  importedSessionIds: Set<string>;
  onCancel: () => void;
  onImport: (sourcePaths: string[]) => Promise<void>;
}) {
  const [data, setData] = useState<ImportSessionsListResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    ensureScan()
      .then((response) => {
        if (!cancelled) {
          setData(response);
        }
      })
      .catch((scanFailure: unknown) => {
        if (!cancelled) {
          setLoadError(asErrorMessage(scanFailure));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [ensureScan]);

  function isImported(session: ImportAgentSession): boolean {
    return session.imported || importedSessionIds.has(session.sessionId);
  }

  const needle = query.trim().toLowerCase();
  const groups = useMemo(() => {
    if (!data) {
      return [] as Array<{ projectKey: string; sessions: ImportAgentSession[] }>;
    }
    return data.projects
      .map((project) => ({
        projectKey: project.projectKey,
        sessions: project.sessions.filter((session) => !needle
          || session.title.toLowerCase().includes(needle)
          || project.projectKey.toLowerCase().includes(needle)),
      }))
      .filter((group) => group.sessions.length > 0);
  }, [data, needle]);
  const selectable = groups.flatMap((group) => group.sessions).filter((session) => !isImported(session));
  const allSelected = selectable.length > 0 && selectable.every((session) => selected.has(session.sourcePath));

  function toggle(path: string) {
    if (importing) {
      return;
    }
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
    if (importing) {
      return;
    }
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

  function toggleGroup(projectKey: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(projectKey)) {
        next.delete(projectKey);
      } else {
        next.add(projectKey);
      }
      return next;
    });
  }

  return (
    <div className="import-overlay" onClick={(event) => { if (!importing && event.target === event.currentTarget) onCancel(); }}>
      <div className="import-modal" role="dialog" aria-label={`Import ${agentLabel} sessions`}>
        <div className="import-modal-head">
          <div className="import-modal-title">Import {agentLabel} sessions</div>
          <div className="import-modal-sub">Select local sessions to import. Already-captured sessions are dimmed.</div>
        </div>
        <div className="import-modal-tools">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search sessions…" disabled={importing || !data} />
          <span className="import-modal-selall" role="button" tabIndex={0} onClick={toggleAll} onKeyDown={(event) => { if (event.key === 'Enter') toggleAll(); }}>
            {allSelected ? 'Clear all' : 'Select all'}
          </span>
        </div>
        <div className="import-modal-body">
          {loadError ? (
            <div className="import-modal-placeholder import-result-error">{loadError}</div>
          ) : !data ? (
            <div className="import-modal-placeholder">Scanning local sessions…</div>
          ) : groups.length === 0 ? (
            <div className="import-modal-placeholder">No sessions match.</div>
          ) : groups.map((group) => {
            const groupOpen = expanded.has(group.projectKey);
            return (
            <div className={groupOpen ? 'import-pick-group import-pick-group-open' : 'import-pick-group'} key={group.projectKey}>
              <div className="import-pick-group-head" role="button" tabIndex={0} onClick={() => toggleGroup(group.projectKey)} onKeyDown={(event) => { if (event.key === 'Enter') toggleGroup(group.projectKey); }}>
                <ChevronRight className="tree-chevron import-chev" />
                <span className="import-pick-group-name">{group.projectKey}</span>
                <span className="import-pick-group-meta">{group.sessions.length} sessions</span>
              </div>
              {groupOpen ? group.sessions.map((session) => {
                const imported = isImported(session);
                const isSel = selected.has(session.sourcePath);
                return (
                  <div
                    className={`import-pick${imported ? ' import-pick-dim' : ''}${isSel ? ' import-pick-sel' : ''}`}
                    key={session.sourcePath}
                    role="button"
                    tabIndex={imported ? -1 : 0}
                    onClick={() => { if (!imported) toggle(session.sourcePath); }}
                    onKeyDown={(event) => { if (event.key === 'Enter' && !imported) toggle(session.sourcePath); }}
                  >
                    <span className="import-cb">{isSel ? '✓' : ''}</span>
                    <span className="import-pick-title">{session.title}</span>
                    <span className="import-pick-meta tree-time" title={formatTimestamp(session.updatedAt)}>{imported ? <span className="import-tag">captured</span> : formatRelativeTime(session.updatedAt)}</span>
                  </div>
                );
              }) : null}
            </div>
            );
          })}
        </div>
        <div className="import-modal-foot">
          <span className="import-modal-count">{selected.size} selected</span>
          {importError ? <span className="import-result-error">{importError}</span> : null}
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={importing}>Cancel</Button>
          <Button
            size="sm"
            disabled={selected.size === 0 || importing}
            onClick={async () => {
              if (importing || selected.size === 0) {
                return;
              }
              setImporting(true);
              setImportError(null);
              try {
                await onImport([...selected]);
              } catch (importFailure) {
                setImportError(asErrorMessage(importFailure));
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
