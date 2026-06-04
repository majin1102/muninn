import type { SearchSessionResult } from '@muninn/types';
import { ChevronDown, ChevronUp, Search } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { BoardClient, ProjectNode } from '../lib/api.js';
import {
  DEFAULT_SESSION_TOP_N,
  DEFAULT_TOP_N,
  SEARCH_ALL_VALUE,
  defaultSearchControls,
  normalizeSearchN,
  sessionOptionsForProject,
  type SearchControlsState,
} from '../lib/search_state.js';
import { asErrorMessage } from '../lib/utils.js';

type SearchPageProps = {
  client: BoardClient;
  projects: ProjectNode[];
  projectsLoading: boolean;
  projectError: string | null;
  onLoadProjects: () => void;
};

const N_OPTIONS = [1, 3, 5, 10, 20];

export function SearchPage({
  client,
  projects,
  projectsLoading,
  projectError,
  onLoadProjects,
}: SearchPageProps) {
  const [controls, setControls] = useState<SearchControlsState>(() => defaultSearchControls());
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SearchSessionResult[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const sessionOptions = useMemo(
    () => sessionOptionsForProject(projects, controls.projectKey),
    [controls.projectKey, projects],
  );

  useEffect(() => {
    if (projects.length === 0 && !projectsLoading && !projectError) {
      onLoadProjects();
    }
  }, [onLoadProjects, projectError, projects.length, projectsLoading]);

  function patchControls(patch: Partial<SearchControlsState>) {
    setControls((current) => ({
      ...current,
      ...patch,
    }));
  }

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const query = controls.query.trim();
    if (!query) {
      return;
    }
    setSubmitted(true);
    setLoading(true);
    setError(null);
    setExpanded({});
    try {
      const response = await client.search({
        query,
        projectKey: controls.projectKey,
        sessionKey: controls.sessionKey,
        sessionTopN: controls.sessionTopN,
        topN: controls.topN,
      });
      setResults(response.results);
    } catch (nextError) {
      setResults([]);
      setError(asErrorMessage(nextError));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={submitted ? 'search-page search-page-submitted' : 'search-page'}>
      <form className="search-form" onSubmit={submit}>
        <label className="search-input-shell">
          <Search />
          <input
            type="search"
            value={controls.query}
            placeholder="Search memories"
            onChange={(event) => patchControls({ query: event.target.value })}
          />
          <button type="submit" disabled={!controls.query.trim() || loading}>
            Search
          </button>
        </label>
        <div className="search-controls" aria-label="Search controls">
          <SearchSelect
            label="Project"
            value={controls.projectKey}
            disabled={projectsLoading}
            onChange={(value) => patchControls({ projectKey: value, sessionKey: SEARCH_ALL_VALUE })}
            options={[
              { label: 'All', value: SEARCH_ALL_VALUE },
              ...projects.map((project) => ({ label: project.label, value: project.projectKey })),
            ]}
          />
          <SearchSelect
            label="Session"
            value={controls.sessionKey}
            disabled={controls.projectKey === SEARCH_ALL_VALUE}
            onChange={(value) => patchControls({ sessionKey: value })}
            options={[
              { label: 'All', value: SEARCH_ALL_VALUE },
              ...sessionOptions,
            ]}
          />
          <SearchSelect
            label="Session Top N"
            value={String(controls.sessionTopN)}
            onChange={(value) => patchControls({ sessionTopN: normalizeSearchN(value, DEFAULT_SESSION_TOP_N) })}
            options={N_OPTIONS.map((value) => ({ label: String(value), value: String(value) }))}
          />
          <SearchSelect
            label="Top N"
            value={String(controls.topN)}
            onChange={(value) => patchControls({ topN: normalizeSearchN(value, DEFAULT_TOP_N) })}
            options={N_OPTIONS.map((value) => ({ label: String(value), value: String(value) }))}
          />
        </div>
      </form>
      {projectError ? <div className="search-error">{projectError}</div> : null}
      {submitted ? (
        <SearchResults
          loading={loading}
          error={error}
          results={results}
          expanded={expanded}
          onToggle={(id) => setExpanded((current) => ({ ...current, [id]: !current[id] }))}
        />
      ) : null}
    </div>
  );
}

function SearchSelect({
  label,
  value,
  options,
  disabled = false,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ label: string; value: string }>;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className={disabled ? 'search-control search-control-disabled' : 'search-control'}>
      <span>{label}</span>
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function SearchResults({
  loading,
  error,
  results,
  expanded,
  onToggle,
}: {
  loading: boolean;
  error: string | null;
  results: SearchSessionResult[];
  expanded: Record<string, boolean>;
  onToggle: (id: string) => void;
}) {
  if (loading) {
    return <div className="search-status">Searching...</div>;
  }
  if (error) {
    return <div className="search-error">{error}</div>;
  }
  if (results.length === 0) {
    return <div className="search-status">No results found.</div>;
  }
  return (
    <div className="search-results">
      {results.map((result) => (
        <article key={result.sessionKey} className="search-result">
          <h2>{result.sessionLabel}</h2>
          <div className="search-result-meta">Project: {result.projectKey}</div>
          <div className="search-result-items">
            {result.items.map((item) => {
              const isExpanded = Boolean(expanded[item.id]);
              return (
                <section key={item.id} className="search-hit">
                  <div className="search-hit-source">Source: {item.source}</div>
                  {item.title ? <h3>{item.title}</h3> : null}
                  <div className={isExpanded ? 'search-hit-content search-hit-content-expanded' : 'search-hit-content'}>
                    {item.content}
                  </div>
                  <button className="search-hit-toggle" type="button" onClick={() => onToggle(item.id)}>
                    {isExpanded ? <ChevronUp /> : <ChevronDown />}
                    <span>{isExpanded ? 'Collapse' : 'Expand'}</span>
                  </button>
                </section>
              );
            })}
          </div>
        </article>
      ))}
    </div>
  );
}
