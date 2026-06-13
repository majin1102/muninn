import { Bot, Check, ChevronRight, CircleAlert, LoaderCircle, Plus, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ImportAgentLocalProject,
  ImportAgentSession,
  ImportedProjectGroup,
  ImportedProjectsResponse,
  ImportLocalProjectsResponse,
  ImportSessionsListResponse,
} from '@muninn/types';
import * as SessionIdentity from '@muninn/types/session-identity';
import type { AppClient } from '../lib/api.js';
import { logoForAgent, type AgentLogo } from '../lib/agent_logo.js';
import { projectDisplayLabel, projectDisplayLabels } from '../lib/project_display.js';
import { asErrorMessage, formatRelativeTime, formatTimestamp } from '../lib/utils.js';
import { Button } from './ui/button.js';
import { EmptyState } from './ui/empty-state.js';
import { Switch } from './ui/switch.js';

type LoadStatus = 'loading' | 'ready' | 'error';
type ImportAgentKey = 'codex' | 'claude-code';
type ImportAgentState = ReturnType<typeof useImportAgent>;
type ImportedProjectsState = ReturnType<typeof useImportedProjects>;
type ImportAgentEntry = {
  key: ImportAgentKey;
  label: string;
  sourceRoot?: string;
  data: ImportAgentState;
  importedSessionKeys: Set<string>;
  importedProjectPaths: Set<string>;
};
type ProjectAgentEntry = {
  agent: ImportAgentKey;
  label: string;
  data: ImportAgentState;
  sessionCount: number;
  importedCount: number;
  captureEnabled?: boolean;
  importedSessionKeys: Set<string>;
};
type ProjectCaptureGroup = {
  project: string;
  sessionCount: number;
  importedCount: number;
  latestUpdatedAt: string;
  agents: ProjectAgentEntry[];
  sessions: Array<{ agent: ImportAgentKey; session: ImportAgentSession }>;
};
type ProjectImportCandidate = {
  project: string;
  agents: Array<{ agent: ImportAgentKey; project: LocalProjectCandidate }>;
};
type LocalProjectCandidate = ImportAgentLocalProject & { captureEnabled?: boolean };

const IMPORT_AGENTS: Array<{ key: ImportAgentKey; label: string }> = [
  { key: 'codex', label: 'Codex' },
  { key: 'claude-code', label: 'Claude Code' },
];

function sessionCountLabel(count: number): string {
  return `${count} ${count <= 1 ? 'session' : 'sessions'}`;
}

function agentCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'agent' : 'agents'}`;
}

export function ImportSettings({ client }: { client: AppClient }) {
  const importedProjects = useImportedProjects(client);
  const importedByAgent = useMemo(() => importedAgentState(importedProjects.data), [importedProjects.data]);
  const codex = useImportAgent(client, 'codex', importedByAgent.sessionKeys.codex);
  const claude = useImportAgent(client, 'claude-code', importedByAgent.sessionKeys['claude-code']);
  const agentMetadata = useMemo(() => new Map((importedProjects.data?.agents ?? []).map((agent) => [agent.agent, agent])), [importedProjects.data]);
  const agents: ImportAgentEntry[] = [
    {
      key: 'codex',
      label: 'Codex',
      sourceRoot: agentMetadata.get('codex')?.sourceRoot,
      data: codex,
      importedSessionKeys: importedByAgent.sessionKeys.codex,
      importedProjectPaths: importedByAgent.projectPaths.codex,
    },
    {
      key: 'claude-code',
      label: 'Claude Code',
      sourceRoot: agentMetadata.get('claude-code')?.sourceRoot,
      data: claude,
      importedSessionKeys: importedByAgent.sessionKeys['claude-code'],
      importedProjectPaths: importedByAgent.projectPaths['claude-code'],
    },
  ];
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [sessionPicker, setSessionPicker] = useState<ProjectCaptureGroup | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectCaptureGroup | null>(null);

  async function importPaths(agent: ImportAgentKey, sourcePaths: string[]) {
    await client.importSessionsByPaths(agent, sourcePaths);
  }

  async function onImportProjectSelections(selections: Array<{ agent: ImportAgentKey; project: string }>) {
    const byAgent = new Map<ImportAgentKey, string[]>();
    for (const selection of selections) {
      byAgent.set(selection.agent, [...(byAgent.get(selection.agent) ?? []), selection.project]);
    }
    await Promise.all([...byAgent].map(([agent, projects]) => client.importProjects(agent, projects)));
    importedProjects.load();
  }

  async function importSessionSelections(selections: Array<{ agent: ImportAgentKey; sourcePath: string }>) {
    const byAgent = new Map<ImportAgentKey, string[]>();
    for (const selection of selections) {
      byAgent.set(selection.agent, [...(byAgent.get(selection.agent) ?? []), selection.sourcePath]);
    }
    await Promise.all([...byAgent].map(([agent, sourcePaths]) => importPaths(agent, sourcePaths)));
    importedProjects.load();
  }

  async function deleteProject(target: ProjectCaptureGroup) {
    await Promise.all(target.agents.map((entry) => client.deleteImportedProject(entry.agent, target.project)));
    importedProjects.load();
  }

  return (
    <div className="import-settings">
      <section className="import-section">
        <div className="import-section-head">
          <h2>Agent capture</h2>
          <span>Include agents in automatic session capture.</span>
        </div>
        <div className="import-card">
          {agents.map(({ key, label }) => (
            <AgentCaptureRow
              key={key}
              agent={key}
              label={label}
              sourceRoot={agentMetadata.get(key)?.sourceRoot}
              captureEnabled={agentMetadata.get(key)?.captureEnabled ?? true}
              setAgentCapturePolicy={client.setAgentCapturePolicy}
              reloadImportedProjects={importedProjects.load}
            />
          ))}
        </div>
      </section>

      <section className="import-section">
        <div className="import-section-head">
          <h2>Project capture</h2>
          <span>Include imported projects in automatic session capture.</span>
        </div>
        <div className="import-card">
          <button className="import-action-row" type="button" onClick={() => setProjectPickerOpen(true)}>
            <Plus className="import-action-icon" aria-hidden="true" />
            <span>Import projects...</span>
          </button>
          <ProjectCaptureList
            agents={agents}
            importedProjects={importedProjects}
            setCapturePolicy={client.setCapturePolicy}
            onImportProject={setSessionPicker}
            onDeleteProject={setDeleteTarget}
          />
        </div>
      </section>

      {projectPickerOpen ? (
        <ProjectImportPicker
          agents={agents}
          onCancel={() => setProjectPickerOpen(false)}
          onImport={async (selections) => {
            await onImportProjectSelections(selections);
            setProjectPickerOpen(false);
          }}
        />
      ) : null}

      {sessionPicker ? (
        <SessionImportPicker
          group={sessionPicker}
          onCancel={() => setSessionPicker(null)}
          onImport={async (selections) => {
            await importSessionSelections(selections);
            setSessionPicker(null);
          }}
        />
      ) : null}

      {deleteTarget ? (
        <DeleteProjectDialog
          group={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onDelete={async () => {
            await deleteProject(deleteTarget);
            setDeleteTarget(null);
          }}
        />
      ) : null}
    </div>
  );
}

function useImportedProjects(client: AppClient) {
  const [data, setData] = useState<ImportedProjectsResponse | null>(null);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setStatus('loading');
    setError(null);
    client.listImportedProjects()
      .then((response) => {
        setData(response);
        setStatus('ready');
      })
      .catch((loadError: unknown) => {
        setError(asErrorMessage(loadError));
        setStatus('error');
      });
  }, [client]);

  useEffect(() => {
    load();
  }, [load]);

  return { data, status, error, load };
}

function useImportAgent(client: AppClient, agent: ImportAgentKey, importedSessionKeys: Set<string>) {
  const [scanError, setScanError] = useState<string | null>(null);
  const projectScanPromiseRef = useRef<Promise<ImportLocalProjectsResponse> | null>(null);
  const sessionScanPromiseRef = useRef<Map<string, Promise<ImportSessionsListResponse>>>(new Map());

  const ensureProjectScan = useCallback((): Promise<ImportLocalProjectsResponse> => {
    if (projectScanPromiseRef.current) {
      return projectScanPromiseRef.current;
    }
    setScanError(null);
    const promise = client.listLocalProjects(agent)
      .catch((scanFailure: unknown) => {
        projectScanPromiseRef.current = null;
        setScanError(asErrorMessage(scanFailure));
        throw scanFailure;
      });
    projectScanPromiseRef.current = promise;
    return promise;
  }, [agent, client]);

  const ensureSessionScan = useCallback((project?: string): Promise<ImportSessionsListResponse> => {
    const key = project ?? '';
    const current = sessionScanPromiseRef.current.get(key);
    if (current) {
      return current;
    }
    setScanError(null);
    const promise = client.listImportSessions(agent, undefined, project)
      .catch((scanFailure: unknown) => {
        sessionScanPromiseRef.current.delete(key);
        setScanError(asErrorMessage(scanFailure));
        throw scanFailure;
      });
    sessionScanPromiseRef.current.set(key, promise);
    return promise;
  }, [agent, client]);

  return { error: scanError, ensureProjectScan, ensureSessionScan, importedSessionKeys };
}

function AgentCaptureRow({
  agent,
  label,
  sourceRoot,
  captureEnabled,
  setAgentCapturePolicy,
  reloadImportedProjects,
}: {
  agent: string;
  label: string;
  sourceRoot?: string;
  captureEnabled: boolean;
  setAgentCapturePolicy: (agent: string, enabled: boolean) => Promise<void>;
  reloadImportedProjects: () => void;
}) {
  const [capture, setCapture] = useState(captureEnabled);
  const logo = logoForAgent(agent);

  useEffect(() => {
    setCapture(captureEnabled);
  }, [captureEnabled]);

  return (
    <div className="import-agent-row">
      <AgentLogoIcon logo={logo} variant="agent" />
      <span className="import-agent-main" title={sourceRoot}>
        <span className="import-agent-name">{label}</span>
      </span>
      <Switch
        size="sm"
        checked={capture}
        onChange={(value) => {
          setCapture(value);
          void setAgentCapturePolicy(agent, value)
            .then(reloadImportedProjects)
            .catch(() => setCapture(captureEnabled));
        }}
        ariaLabel={`${label} capture`}
      />
    </div>
  );
}

function ProjectCaptureList({
  agents,
  importedProjects,
  setCapturePolicy,
  onImportProject,
  onDeleteProject,
}: {
  agents: ImportAgentEntry[];
  importedProjects: ImportedProjectsState;
  setCapturePolicy: (agent: string, project: string, enabled: boolean) => Promise<void>;
  onImportProject: (group: ProjectCaptureGroup) => void;
  onDeleteProject: (group: ProjectCaptureGroup) => void;
}) {
  const groups = useMemo(() => hydrateProjectCapture(importedProjects.data?.projects ?? [], agents), [agents, importedProjects.data]);
  const projectLabels = useMemo(() => projectDisplayLabels(groups.map((group) => group.project)), [groups]);
  const loading = importedProjects.status === 'loading' && groups.length === 0;

  return (
    <>
      {importedProjects.status === 'error' ? (
        <EmptyState
          className="import-empty-row"
          icon={CircleAlert}
          title={importedProjects.error ?? 'Failed to load imported projects.'}
          tone="danger"
        />
      ) : null}
      {loading ? <EmptyState className="import-empty-row" icon={LoaderCircle} title="Loading captured sessions..." /> : null}
      {groups.map((group) => (
        <ProjectGroupRow
          key={group.project}
          group={group}
          displayName={projectLabels.get(group.project) ?? projectDisplayLabel(group.project)}
          setCapturePolicy={setCapturePolicy}
          reloadImportedProjects={importedProjects.load}
          onImportProject={onImportProject}
          onDeleteProject={onDeleteProject}
        />
      ))}
    </>
  );
}

function ProjectGroupRow({
  group,
  displayName,
  setCapturePolicy,
  reloadImportedProjects,
  onImportProject,
  onDeleteProject,
}: {
  group: ProjectCaptureGroup;
  displayName: string;
  setCapturePolicy: (agent: string, project: string, enabled: boolean) => Promise<void>;
  reloadImportedProjects: () => void;
  onImportProject: (group: ProjectCaptureGroup) => void;
  onDeleteProject: (group: ProjectCaptureGroup) => void;
}) {
  const [open, setOpen] = useState(false);
  const [capture, setCapture] = useState(group.agents.every((entry) => entry.captureEnabled ?? false));
  const name = displayName;
  const canExpand = group.sessions.length > 0;

  function toggleOpen() {
    if (canExpand) {
      setOpen((value) => !value);
    }
  }

  useEffect(() => {
    setCapture(group.agents.every((entry) => entry.captureEnabled ?? false));
  }, [group.agents]);

  return (
    <div className={`import-proj${open ? ' import-proj-open' : ''}${canExpand ? '' : ' import-proj-no-sessions'}`}>
      <div
        className="import-proj-row"
        {...(canExpand ? { role: 'button', tabIndex: 0 } : {})}
        onClick={toggleOpen}
        onKeyDown={(event) => { if (event.key === 'Enter') toggleOpen(); }}
      >
        <ChevronRight className={`tree-chevron import-chev${canExpand ? '' : ' import-chev-disabled'}`} />
        <span className="import-proj-main">
          <span className="import-proj-title-line">
            <span className="import-proj-name">{name}</span>
            <span className="import-inline-meta">{sessionCountLabel(group.sessionCount)}</span>
            <span className="import-inline-meta">{agentCountLabel(group.agents.length)}</span>
          </span>
          <span className="import-proj-sub">{group.project}</span>
        </span>
        <span className="import-proj-actions" onClick={(event) => event.stopPropagation()}>
          <button className="import-icon-button" type="button" aria-label={`Import sessions from ${name}`} onClick={() => onImportProject(group)}>
            <Plus aria-hidden="true" />
          </button>
          <button className="import-icon-button import-icon-button-danger" type="button" aria-label={`Delete ${name}`} onClick={() => onDeleteProject(group)}>
            <Trash2 aria-hidden="true" />
          </button>
          <Switch
            size="sm"
            checked={capture}
            onChange={(value) => {
              setCapture(value);
              void Promise.all(group.agents.map((entry) => setCapturePolicy(entry.agent, group.project, value)))
                .then(reloadImportedProjects)
                .catch(() => setCapture(group.agents.every((entry) => entry.captureEnabled ?? false)));
            }}
            ariaLabel={`${name} capture`}
          />
        </span>
      </div>
      {open && canExpand ? (
        <div className="import-sess-list">
          {group.sessions.map(({ agent, session }) => (
            <SessionRow key={identityKey(agent, session)} session={session} agent={agent} />
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

function ProjectImportPicker({
  agents,
  onCancel,
  onImport,
}: {
  agents: ImportAgentEntry[];
  onCancel: () => void;
  onImport: (selections: Array<{ agent: ImportAgentKey; project: string }>) => Promise<void>;
}) {
  const [selectedAgents, setSelectedAgents] = useState<Set<ImportAgentKey>>(() => new Set(agents.map((agent) => agent.key)));
  const [dataByAgent, setDataByAgent] = useState<Partial<Record<ImportAgentKey, ImportLocalProjectsResponse>>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const selectedAgentKeys = useMemo(
    () => agents.filter((agent) => selectedAgents.has(agent.key)).map((agent) => agent.key),
    [agents, selectedAgents],
  );
  const selectedAgentKey = selectedAgentKeys.join('|');

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    setSelectedProjects(new Set());
    Promise.all(selectedAgentKeys.map((key) => {
      const entry = agents.find((agent) => agent.key === key);
      if (!entry) {
        return null;
      }
      return entry.data.ensureProjectScan().then((response) => ({ key, response }));
    }))
      .then((responses) => {
        if (!cancelled) {
          setDataByAgent((current) => {
            const next = { ...current };
            for (const item of responses) {
              if (item) {
                next[item.key] = item.response;
              }
            }
            return next;
          });
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
  }, [agents, selectedAgentKey, selectedAgentKeys]);

  const loading = selectedAgentKeys.length > 0 && selectedAgentKeys.some((key) => !dataByAgent[key]);
  const allProjects = useMemo(() => {
    const grouped = new Map<string, ProjectImportCandidate>();
    for (const entry of agents) {
      if (!selectedAgents.has(entry.key)) {
        continue;
      }
      const data = dataByAgent[entry.key];
      if (!data) {
        continue;
      }
      for (const project of data.projects as LocalProjectCandidate[]) {
        if (entry.importedProjectPaths.has(project.project) || project.captureEnabled === true) {
          continue;
        }
        const candidate = grouped.get(project.project) ?? { project: project.project, agents: [] };
        candidate.agents.push({ agent: entry.key, project });
        grouped.set(project.project, candidate);
      }
    }
    return [...grouped.values()].sort((left, right) => left.project.localeCompare(right.project));
  }, [agents, dataByAgent, selectedAgents]);
  const projectLabels = useMemo(() => projectDisplayLabels(allProjects.map((project) => project.project)), [allProjects]);
  const projects = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return allProjects
      .filter((project) => {
        const label = projectLabels.get(project.project) ?? projectDisplayLabel(project.project);
        return !needle || project.project.toLowerCase().includes(needle) || label.toLowerCase().includes(needle);
      })
      .sort((left, right) => {
        const leftLabel = projectLabels.get(left.project) ?? projectDisplayLabel(left.project);
        const rightLabel = projectLabels.get(right.project) ?? projectDisplayLabel(right.project);
        return leftLabel.localeCompare(rightLabel) || left.project.localeCompare(right.project);
      });
  }, [allProjects, projectLabels, query]);
  const selectedProjectImports = useMemo(() => (
    allProjects
      .filter((project) => selectedProjects.has(project.project))
      .flatMap((project) => project.agents.flatMap((agentProject) => (
        projectImportSelections(agentProject.agent, agentProject.project)
      )))
  ), [allProjects, selectedProjects]);

  function toggleAgent(agent: ImportAgentKey) {
    if (importing) {
      return;
    }
    setSelectedAgents((current) => {
      const next = new Set(current);
      if (next.has(agent)) {
        next.delete(agent);
      } else {
        next.add(agent);
      }
      return next;
    });
  }

  function toggleProject(project: ProjectImportCandidate) {
    if (importing) {
      return;
    }
    setSelectedProjects((current) => {
      const next = new Set(current);
      if (next.has(project.project)) {
        next.delete(project.project);
      } else {
        next.add(project.project);
      }
      return next;
    });
  }

  return (
    <div className="import-overlay" onClick={(event) => { if (!importing && event.target === event.currentTarget) onCancel(); }}>
      <div className="import-modal" role="dialog" aria-label="Import projects">
        <div className="import-modal-head">
          <div className="import-modal-title">Import projects</div>
        </div>
        <div className="import-modal-tools import-project-tools">
          <label className="import-search-row">
            <Search aria-hidden="true" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search projects..." disabled={importing || selectedAgentKeys.length === 0} />
          </label>
          <div className="import-agent-filter-row">
            {agents.map((item) => (
              <button
                key={item.key}
                className={`import-agent-filter${selectedAgents.has(item.key) ? ' import-agent-filter-active' : ''}`}
                type="button"
                disabled={importing}
                onClick={() => toggleAgent(item.key)}
              >
                <AgentLogoIcon logo={logoForAgent(item.key)} variant="session" />
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="import-modal-body">
          {loadError ? (
            <EmptyState className="import-modal-placeholder" icon={CircleAlert} title={loadError} tone="danger" />
          ) : loading ? (
            <EmptyState className="import-modal-placeholder" icon={LoaderCircle} title="Scanning local projects..." />
          ) : projects.length === 0 ? (
            <EmptyState className="import-modal-placeholder" icon={Search} title="No projects match." />
          ) : (
            <div className="import-pick-table">
              {projects.map((project) => {
                const name = projectLabels.get(project.project) ?? projectDisplayLabel(project.project);
                const selected = selectedProjects.has(project.project);
                return (
                  <div
                    className={`import-pick import-project-pick${selected ? ' import-pick-selected' : ''}`}
                    key={project.project}
                    role="button"
                    tabIndex={0}
                  onClick={() => toggleProject(project)}
                  onKeyDown={(event) => { if (event.key === 'Enter') toggleProject(project); }}
                >
                  <Check className="import-pick-leading-check" aria-hidden="true" />
                  <span className="import-pick-copy">
                    <span className="import-pick-title">
                      <span>{name}</span>
                    </span>
                    <span className="import-pick-sub">{project.project}</span>
                  </span>
                </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="import-modal-foot">
          <span className="import-modal-count">{selectedProjects.size} selected</span>
          {importError ? <span className="import-result-error">{importError}</span> : null}
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={importing}>Cancel</Button>
          <Button
            size="sm"
            disabled={selectedProjectImports.length === 0 || importing}
            onClick={async () => {
              if (selectedProjectImports.length === 0 || importing) {
                return;
              }
              setImporting(true);
              setImportError(null);
              try {
                await onImport(selectedProjectImports);
              } catch (importFailure) {
                setImportError(asErrorMessage(importFailure));
              } finally {
                setImporting(false);
              }
            }}
          >
            {importing ? 'Importing...' : 'Import'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SessionImportPicker({
  group,
  onCancel,
  onImport,
}: {
  group: ProjectCaptureGroup;
  onCancel: () => void;
  onImport: (selections: Array<{ agent: ImportAgentKey; sourcePath: string }>) => Promise<void>;
}) {
  const [data, setData] = useState<Array<{ entry: ProjectAgentEntry; response: ImportSessionsListResponse }> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setLoadError(null);
    setQuery('');
    setSelected(new Set());
    Promise.all(group.agents.map((entry) => entry.data.ensureSessionScan(group.project).then((response) => ({ entry, response }))))
      .then((responses) => {
        if (!cancelled) {
          setData(responses);
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
  }, [group]);

  const allSessions = useMemo(() => {
    return (data ?? [])
      .flatMap(({ entry, response }) => {
        const localProject = response.projects.find((candidate) => candidate.project === group.project);
        return (localProject?.sessions ?? []).map((session) => ({ agent: entry.agent, session, importedSessionKeys: entry.importedSessionKeys }));
      })
      .filter(({ agent, session, importedSessionKeys }) => !isSessionImported(agent, session, importedSessionKeys) && session.sourcePath)
      .sort((left, right) => right.session.updatedAt.localeCompare(left.session.updatedAt));
  }, [data, group.project]);
  const sessions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return allSessions
      .filter(({ session }) => !needle || session.title.toLowerCase().includes(needle))
      .sort((left, right) => right.session.updatedAt.localeCompare(left.session.updatedAt));
  }, [allSessions, query]);
  const selectedSessionImports = useMemo(() => (
    allSessions
      .filter(({ agent, session }) => session.sourcePath && selected.has(selectionKey(agent, session.sourcePath)))
      .map(({ agent, session }) => ({ agent, sourcePath: session.sourcePath! }))
  ), [allSessions, selected]);

  function selectionKey(agent: ImportAgentKey, sourcePath: string): string {
    return `${agent}:${sourcePath}`;
  }

  function toggleSession(agent: ImportAgentKey, session: ImportAgentSession) {
    const sourcePath = session.sourcePath;
    if (!sourcePath || importing) {
      return;
    }
    const key = selectionKey(agent, sourcePath);
    setSelected((current) => {
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
    <div className="import-overlay" onClick={(event) => { if (!importing && event.target === event.currentTarget) onCancel(); }}>
      <div className="import-modal" role="dialog" aria-label="Import sessions">
        <div className="import-modal-head">
          <div className="import-modal-title">Import sessions</div>
        </div>
        <div className="import-modal-tools">
          <label className="import-search-row">
            <Search aria-hidden="true" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search sessions..." disabled={importing || !data} />
          </label>
        </div>
        <div className="import-modal-body">
          {loadError ? (
            <EmptyState className="import-modal-placeholder" icon={CircleAlert} title={loadError} tone="danger" />
          ) : !data ? (
            <EmptyState className="import-modal-placeholder" icon={LoaderCircle} title="Scanning local sessions..." />
          ) : sessions.length === 0 ? (
            <EmptyState className="import-modal-placeholder" icon={Search} title="No sessions match." />
          ) : (
            <div className="import-pick-table">
              {sessions.map(({ agent, session }) => {
                const key = session.sourcePath ? selectionKey(agent, session.sourcePath) : session.sessionId;
                const selectedSession = Boolean(session.sourcePath && selected.has(key));
                return (
                  <div
                    className={`import-pick import-session-pick${selectedSession ? ' import-pick-selected' : ''}`}
                    key={key}
                    title={session.promptPreview ?? session.title}
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleSession(agent, session)}
                    onKeyDown={(event) => { if (event.key === 'Enter') toggleSession(agent, session); }}
                  >
                    <AgentLogoIcon logo={logoForAgent(agent)} variant="agent" />
                    <span className="import-pick-title">
                      <span>{session.title}</span>
                      <Check className="import-pick-inline-check" aria-hidden="true" />
                    </span>
                    <span className="import-pick-meta tree-time" title={formatTimestamp(session.updatedAt)}>{formatRelativeTime(session.updatedAt)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="import-modal-foot">
          <span className="import-modal-count">{selected.size} selected</span>
          {importError ? <span className="import-result-error">{importError}</span> : null}
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={importing}>Cancel</Button>
          <Button
            size="sm"
            disabled={selectedSessionImports.length === 0 || importing}
            onClick={async () => {
              if (selectedSessionImports.length === 0 || importing) {
                return;
              }
              setImporting(true);
              setImportError(null);
              try {
                await onImport(selectedSessionImports);
              } catch (importFailure) {
                setImportError(asErrorMessage(importFailure));
              } finally {
                setImporting(false);
              }
            }}
          >
            {importing ? 'Importing...' : 'Import'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function DeleteProjectDialog({
  group,
  onCancel,
  onDelete,
}: {
  group: ProjectCaptureGroup;
  onCancel: () => void;
  onDelete: () => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="import-overlay" onClick={(event) => { if (!deleting && event.target === event.currentTarget) onCancel(); }}>
      <div className="import-modal import-confirm-modal" role="dialog" aria-label="Delete imported project">
        <div className="import-modal-head">
          <div className="import-modal-title">Delete imported project?</div>
          <div className="import-modal-sub">
            This removes imported sessions for {group.project} from Muninn. Local session files are not deleted.
          </div>
        </div>
        <div className="import-modal-foot">
          <span className="import-modal-count">{error ? <span className="import-result-error">{error}</span> : null}</span>
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={deleting}>Cancel</Button>
          <Button
            size="sm"
            disabled={deleting}
            className="import-danger-button"
            onClick={async () => {
              if (deleting) {
                return;
              }
              setDeleting(true);
              setError(null);
              try {
                await onDelete();
              } catch (deleteFailure) {
                setError(asErrorMessage(deleteFailure));
              } finally {
                setDeleting(false);
              }
            }}
          >
            {deleting ? 'Deleting...' : 'Delete'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function projectImportSelections(agent: ImportAgentKey, project: LocalProjectCandidate): Array<{ agent: ImportAgentKey; project: string }> {
  return [{ agent, project: project.project }];
}

function importedAgentState(data: ImportedProjectsResponse | null): {
  sessionKeys: Record<ImportAgentKey, Set<string>>;
  projectPaths: Record<ImportAgentKey, Set<string>>;
} {
  const sessionKeys: Record<ImportAgentKey, Set<string>> = {
    codex: new Set(),
    'claude-code': new Set(),
  };
  const projectPaths: Record<ImportAgentKey, Set<string>> = {
    codex: new Set(),
    'claude-code': new Set(),
  };

  for (const project of data?.projects ?? []) {
    for (const agent of project.agents) {
      if (isImportAgentKey(agent.agent)) {
        projectPaths[agent.agent].add(project.project);
      }
    }
    for (const { agent, session } of project.sessions) {
      if (isImportAgentKey(agent)) {
        sessionKeys[agent].add(identityKey(agent, session));
      }
    }
  }

  return { sessionKeys, projectPaths };
}

function hydrateProjectCapture(projects: ImportedProjectGroup[], agents: ImportAgentEntry[]): ProjectCaptureGroup[] {
  const agentByKey = new Map(agents.map((agent) => [agent.key, agent]));
  return projects
    .map((project) => ({
      project: project.project,
      sessionCount: project.sessionCount,
      importedCount: project.importedCount,
      latestUpdatedAt: project.latestUpdatedAt,
      agents: project.agents
        .flatMap((agent): ProjectAgentEntry[] => {
          if (!isImportAgentKey(agent.agent)) {
            return [];
          }
          const entry = agentByKey.get(agent.agent);
          if (!entry) {
            return [];
          }
          return [{
            agent: agent.agent,
            label: entry?.label ?? agent.agent,
            data: entry.data,
            sessionCount: agent.sessionCount,
            importedCount: agent.importedCount,
            captureEnabled: agent.captureEnabled,
            importedSessionKeys: entry?.importedSessionKeys ?? new Set<string>(),
          }];
        })
        .sort((left, right) => agentSortIndex(left.agent) - agentSortIndex(right.agent)),
      sessions: project.sessions
        .filter((item): item is { agent: ImportAgentKey; session: ImportAgentSession } => isImportAgentKey(item.agent))
        .sort((left, right) => right.session.updatedAt.localeCompare(left.session.updatedAt)),
    }))
    .filter((project) => project.agents.length > 0)
    .sort((left, right) => right.latestUpdatedAt.localeCompare(left.latestUpdatedAt));
}

function agentSortIndex(agent: ImportAgentKey): number {
  return IMPORT_AGENTS.findIndex((item) => item.key === agent);
}

function isImportAgentKey(agent: string): agent is ImportAgentKey {
  return agent === 'codex' || agent === 'claude-code';
}

function isSessionImported(agent: ImportAgentKey, session: ImportAgentSession, importedSessionKeys: Set<string>): boolean {
  return session.imported || importedSessionKeys.has(identityKey(agent, session));
}

function identityKey(agent: ImportAgentKey, session: Pick<ImportAgentSession, 'project' | 'sessionId'>): string {
  return SessionIdentity.sessionIdentityKey({
    project: session.project,
    agent,
    sessionId: session.sessionId,
  });
}
