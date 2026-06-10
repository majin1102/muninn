import { ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BoardClient } from '../lib/api.js';
import type {
  ImportAgentProject,
  ImportAgentSession,
  ImportSelectedResponse,
  ImportSessionsListResponse,
} from '@muninn/types';
import { asErrorMessage, formatRelativeTime, formatTimestamp } from '../lib/utils.js';
import { Button } from './ui/button.js';
import { Switch } from './ui/switch.js';

type LoadStatus = 'loading' | 'ready' | 'error';

export function ImportSettings({ client }: { client: BoardClient }) {
  const [imported, setImported] = useState<ImportSessionsListResponse | null>(null);
  const [importedStatus, setImportedStatus] = useState<LoadStatus>('loading');
  const [importedError, setImportedError] = useState<string | null>(null);
  const [scanData, setScanData] = useState<ImportSessionsListResponse | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [revealProjects, setRevealProjects] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [importResult, setImportResult] = useState<ImportSelectedResponse | null>(null);
  const scanPromiseRef = useRef<Promise<ImportSessionsListResponse> | null>(null);

  const loadImported = useCallback(() => {
    setImportedStatus('loading');
    setImportedError(null);
    client.listCodexImportSessions('imported')
      .then((response) => {
        setImported(response);
        setImportedStatus('ready');
      })
      .catch((loadError: unknown) => {
        setImportedError(asErrorMessage(loadError));
        setImportedStatus('error');
      });
  }, [client]);

  useEffect(() => {
    loadImported();
  }, [loadImported]);

  // The local-disk scan is slow (hundreds of transcripts); run it once on demand
  // and share the promise between the reveal rows and the import picker.
  const ensureScan = useCallback((): Promise<ImportSessionsListResponse> => {
    if (scanPromiseRef.current) {
      return scanPromiseRef.current;
    }
    setScanning(true);
    setScanError(null);
    const promise = client.listCodexImportSessions()
      .then((response) => {
        setScanData(response);
        return response;
      })
      .catch((scanFailure: unknown) => {
        scanPromiseRef.current = null;
        setScanError(asErrorMessage(scanFailure));
        throw scanFailure;
      })
      .finally(() => {
        setScanning(false);
      });
    scanPromiseRef.current = promise;
    return promise;
  }, [client]);

  const importedProjects = imported?.projects ?? [];
  const importedSessionIds = useMemo(
    () => new Set(importedProjects.flatMap((project) => project.sessions.map((session) => session.sessionId))),
    [importedProjects],
  );
  const localProjects = useMemo(() => {
    if (!scanData || !revealProjects) {
      return [] as ImportAgentProject[];
    }
    const importedKeys = new Set(importedProjects.map((project) => project.projectKey));
    return scanData.projects
      .filter((project) => !importedKeys.has(project.projectKey))
      .map((project) => ({
        ...project,
        sessions: project.sessions.filter((session) => !importedSessionIds.has(session.sessionId)),
      }))
      .filter((project) => project.sessions.length > 0);
  }, [importedProjects, importedSessionIds, revealProjects, scanData]);

  async function revealAllProjects() {
    if (scanning) {
      return;
    }
    try {
      await ensureScan();
      setRevealProjects(true);
    } catch {
      // surfaced via the scanError row
    }
  }

  const codexStatus = importedStatus === 'error'
    ? 'Unavailable'
    : `Connected${imported ? ` · ${imported.sourceRoot}` : ''}`;

  const resultNode = importResult ? (
    <div className="import-result">
      <div className="import-result-line">
        Imported {importResult.importedSessions} session{importResult.importedSessions === 1 ? '' : 's'} · {importResult.importedTurns} turn{importResult.importedTurns === 1 ? '' : 's'}
      </div>
      {importResult.failedSessions.map((failed) => (
        <div className="import-result-error" key={failed.sourcePath}>{failed.sourcePath}: {failed.errorMessage}</div>
      ))}
    </div>
  ) : null;

  return (
    <div className="import-settings">
      <AgentSection label="Codex" status={codexStatus} supported onImport={() => setPickerOpen(true)} result={resultNode}>
        {importedStatus === 'error' ? (
          <div className="import-empty">{importedError}</div>
        ) : importedStatus === 'loading' && !imported ? (
          <div className="import-empty">Loading captured sessions…</div>
        ) : (
          <div className="import-card">
            {importedProjects.length === 0 && localProjects.length === 0 ? (
              <div className="import-hint-row">No captured sessions yet — scan local projects to import history.</div>
            ) : null}
            {importedProjects.map((project) => (
              <ProjectRow
                key={project.projectKey}
                project={project}
                importedSessionIds={importedSessionIds}
                ensureScan={ensureScan}
              />
            ))}
            {localProjects.map((project) => (
              <ProjectRow key={`local-${project.projectKey}`} project={project} local />
            ))}
            {!revealProjects ? (
              <div
                className="import-scan-row"
                role="button"
                tabIndex={0}
                onClick={() => void revealAllProjects()}
                onKeyDown={(event) => { if (event.key === 'Enter') void revealAllProjects(); }}
              >
                {scanning ? 'Scanning local projects…' : 'Scan local projects…'}
              </div>
            ) : localProjects.length === 0 ? (
              <div className="import-scan-row import-scan-row-static">All local projects already imported.</div>
            ) : null}
            {scanError ? <div className="import-scan-row import-scan-row-static import-result-error">{scanError}</div> : null}
          </div>
        )}
      </AgentSection>

      <AgentSection label="Claude Code" status="Detected · adapter pending · ~/.claude/projects" supported={false} placeholder="Claude Code adapter coming soon. Sessions are detected but capture and import are not wired yet." />
      <AgentSection label="Trae" status="Not found" supported={false} placeholder="No Trae data directory found on this machine. Connect Trae to enable capture." />

      {pickerOpen ? (
        <ImportPicker
          agentLabel="Codex"
          ensureScan={ensureScan}
          importedSessionIds={importedSessionIds}
          onCancel={() => setPickerOpen(false)}
          onImport={async (paths) => {
            const result = await client.importCodexSessionsByPaths(paths);
            setImportResult(result);
            setPickerOpen(false);
            loadImported();
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
  placeholder,
  onImport,
  result,
  children,
}: {
  label: string;
  status: string;
  supported: boolean;
  placeholder?: string;
  onImport?: () => void;
  result?: ReactNode;
  children?: ReactNode;
}) {
  // Per-agent default capture. Policy persistence is deferred; local UI state for now.
  const [defaultCapture, setDefaultCapture] = useState(supported);

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
            <span className="import-ctl-label">Capture</span>
            <Switch checked={defaultCapture} onChange={setDefaultCapture} ariaLabel={`${label} capture`} />
          </span>
        ) : null}
      </div>
      {result}
      {supported ? children : <div className="import-empty">{placeholder}</div>}
    </section>
  );
}

function ProjectRow({
  project,
  local = false,
  importedSessionIds,
  ensureScan,
}: {
  project: ImportAgentProject;
  local?: boolean;
  importedSessionIds?: Set<string>;
  ensureScan?: () => Promise<ImportSessionsListResponse>;
}) {
  const [open, setOpen] = useState(false);
  const [capture, setCapture] = useState(!local);
  const [scannedSessions, setScannedSessions] = useState<ImportAgentSession[] | null>(null);
  const [localScanning, setLocalScanning] = useState(false);

  // Filter at render time against the live imported set, so freshly imported
  // sessions un-dim (move to the imported list) without rescanning.
  const localSessions = scannedSessions?.filter((session) => !(importedSessionIds?.has(session.sessionId))) ?? null;

  async function revealLocalSessions() {
    if (!ensureScan || localScanning) {
      return;
    }
    setLocalScanning(true);
    try {
      const data = await ensureScan();
      const scanProject = data.projects.find((item) => item.projectKey === project.projectKey);
      setScannedSessions(scanProject?.sessions ?? []);
    } catch {
      // section-level scan error row covers messaging
    } finally {
      setLocalScanning(false);
    }
  }

  return (
    <div className={`import-proj${open ? ' import-proj-open' : ''}${local ? ' import-proj-local' : ''}`}>
      <div className="import-proj-row" role="button" tabIndex={0} onClick={() => setOpen((value) => !value)} onKeyDown={(event) => { if (event.key === 'Enter') setOpen((value) => !value); }}>
        <ChevronRight className="tree-chevron import-chev" />
        <span className="import-proj-main">
          <span className="import-proj-name">{project.projectKey}</span>
          <span className="import-proj-sub">{project.sessionCount} sessions{!local && project.importedCount > 0 ? ` · ${project.importedCount} captured` : ''}</span>
        </span>
        <span className="import-capture-ctl" onClick={(event) => event.stopPropagation()}>
          <span className="import-ctl-label">Capture</span>
          <Switch checked={capture} onChange={setCapture} ariaLabel={`${project.projectKey} capture`} />
        </span>
      </div>
      {open ? (
        <div className="import-sess-list">
          {project.sessions.map((session) => (
            <SessionRow key={session.sessionId} session={session} dim={local} />
          ))}
          {!local ? (
            scannedSessions === null ? (
              <div
                className="import-sess-scan-row"
                role="button"
                tabIndex={0}
                onClick={() => void revealLocalSessions()}
                onKeyDown={(event) => { if (event.key === 'Enter') void revealLocalSessions(); }}
              >
                {localScanning ? 'Scanning local sessions…' : 'Scan local sessions…'}
              </div>
            ) : localSessions && localSessions.length > 0 ? (
              localSessions.map((session) => (
                <SessionRow key={session.sessionId} session={session} dim />
              ))
            ) : (
              <div className="import-sess-scan-row import-scan-row-static">All local sessions already imported.</div>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SessionRow({ session, dim = false }: { session: ImportAgentSession; dim?: boolean }) {
  return (
    <div className={dim ? 'import-sess import-sess-local' : 'import-sess'}>
      <span className="import-sess-title">{session.title}</span>
      <span className="tree-meta tree-time" title={formatTimestamp(session.updatedAt)}>{formatRelativeTime(session.updatedAt)}</span>
    </div>
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
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

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
    setCollapsed((current) => {
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
            <div className="import-empty">{loadError}</div>
          ) : !data ? (
            <div className="import-empty">Scanning local sessions…</div>
          ) : groups.length === 0 ? (
            <div className="import-empty">No sessions match.</div>
          ) : groups.map((group) => {
            const groupOpen = !collapsed.has(group.projectKey);
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
