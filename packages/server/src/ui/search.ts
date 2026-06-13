import type {
  RecallHit,
} from '@muninn/core';
import type {
  SearchResultItem,
  SearchSessionResult,
} from '@muninn/types';
import * as SessionIdentity from '@muninn/types/session-identity';

export type AppSearchParams = {
  query: string;
  projectKeys?: string[];
  sessionKeys?: string[];
  sessionTopN: number;
  topN: number;
};

export type SearchCandidate = {
  sessionKey: string;
  sessionLabel: string;
  agent: string;
  projectKey: string;
  projectCwd?: string;
  latestUpdatedAt: string;
  source: SearchResultItem['source'];
  memoryId?: string;
  title?: string;
  content: string;
  references: string[];
  createdAt?: string;
  score: number;
};

export type AppSearchResult = {
  results: SearchSessionResult[];
};

type SearchDeps = {
  recall: (query: string, limit?: number, options?: {
    mode?: 'vector' | 'fts' | 'hybrid';
    budget?: number;
    queryLimit?: number;
    includeGlobalObservations?: boolean;
  }) => Promise<RecallHit[]>;
};

export async function searchAppMemory(params: AppSearchParams, deps: SearchDeps): Promise<AppSearchResult> {
  const query = params.query.trim();
  if (!query) {
    return {
      results: [],
    };
  }

  const extractionHits = await deps.recall(query, Math.max(params.topN * params.sessionTopN, params.topN * 3), {
    mode: 'hybrid',
    budget: 0,
    includeGlobalObservations: false,
  });
  const candidates = hitCandidates(extractionHits, {
    projectKeys: params.projectKeys,
    sessionKeys: params.sessionKeys,
  });

  return {
    results: groupCandidates(candidates, {
      sessionTopN: params.sessionTopN,
      topN: params.topN,
    }),
  };
}

function hitCandidates(
  hits: RecallHit[],
  scope: { projectKeys?: string[]; sessionKeys?: string[] },
): SearchCandidate[] {
  return hits.flatMap((hit, index) => {
    if (!hit.memoryId.startsWith('extraction:')) {
      return [];
    }
    const resolved = searchSession(hit);
    if (!resolved) {
      return [];
    }
    if (!matchesScope(resolved.projectKey, resolved.sessionKey, scope)) {
      return [];
    }
    return [{
      sessionKey: resolved.sessionKey,
      sessionLabel: resolved.sessionLabel,
      agent: resolved.agent,
      projectKey: resolved.projectKey,
      projectCwd: normalizeText(hit.cwd),
      latestUpdatedAt: hit.updatedAt ?? hit.createdAt ?? '',
      source: 'extraction' as const,
      memoryId: hit.memoryId,
      title: hit.title ?? hit.summary ?? 'Extraction match',
      content: hit.content,
      references: hit.references ?? [],
      createdAt: hit.createdAt,
      score: 90 - index,
    }];
  });
}

function groupCandidates(
  candidates: SearchCandidate[],
  limits: { sessionTopN: number; topN: number },
): SearchSessionResult[] {
  const selected = selectCandidates(candidates, limits);
  const grouped = new Map<string, SearchCandidate[]>();
  for (const candidate of selected) {
    const current = grouped.get(candidate.sessionKey) ?? [];
    current.push(candidate);
    grouped.set(candidate.sessionKey, current);
  }

  return [...grouped.entries()]
    .map(([sessionKey, items]) => {
      const sorted = dedupeCoveredCandidates(items).sort(compareCandidates);
      const first = sorted[0]!;
      return {
        sessionKey,
        sessionLabel: first.sessionLabel,
        agent: first.agent,
        projectKey: first.projectKey,
        projectCwd: first.projectCwd,
        latestUpdatedAt: sorted.reduce((latest, item) => (
          item.latestUpdatedAt > latest ? item.latestUpdatedAt : latest
        ), first.latestUpdatedAt),
        items: sorted.slice(0, limits.sessionTopN).map(candidateToItem),
        score: first.score,
      };
    })
    .sort((left, right) => (
      right.score - left.score
      || right.latestUpdatedAt.localeCompare(left.latestUpdatedAt)
    ))
    .map(({ score: _score, ...result }) => result);
}

function selectCandidates(
  candidates: SearchCandidate[],
  limits: { sessionTopN: number; topN: number },
): SearchCandidate[] {
  const grouped = new Map<string, SearchCandidate[]>();
  for (const candidate of candidates) {
    const current = grouped.get(candidate.sessionKey) ?? [];
    current.push(candidate);
    grouped.set(candidate.sessionKey, current);
  }

  const sorted = [...grouped.values()]
    .flatMap((items) => dedupeCoveredCandidates(items))
    .sort(compareCandidates);
  const sessionCounts = new Map<string, number>();
  const selected: SearchCandidate[] = [];
  for (const candidate of sorted) {
    const sessionCount = sessionCounts.get(candidate.sessionKey) ?? 0;
    if (sessionCount >= limits.sessionTopN) {
      continue;
    }
    selected.push(candidate);
    sessionCounts.set(candidate.sessionKey, sessionCount + 1);
    if (selected.length >= limits.topN) {
      break;
    }
  }
  return selected;
}

function dedupeCoveredCandidates(candidates: SearchCandidate[]): SearchCandidate[] {
  const sorted = candidates.slice().sort(compareCoverageCandidates);
  const kept: SearchCandidate[] = [];
  for (const candidate of sorted) {
    if (coveredByKept(candidate, kept)) {
      continue;
    }
    kept.push(candidate);
  }
  return kept;
}

function coveredByKept(candidate: SearchCandidate, kept: SearchCandidate[]): boolean {
  const title = normalizeText(candidate.title)?.toLowerCase();
  if (!title || candidate.references.length === 0) {
    return false;
  }
  const refs = new Set(candidate.references);
  return kept.some((item) => {
    if (item.source !== candidate.source || item.sessionKey !== candidate.sessionKey) {
      return false;
    }
    if (normalizeText(item.title)?.toLowerCase() !== title) {
      return false;
    }
    if (item.references.length < refs.size) {
      return false;
    }
    const itemRefs = new Set(item.references);
    return [...refs].every((ref) => itemRefs.has(ref));
  });
}

function compareCoverageCandidates(left: SearchCandidate, right: SearchCandidate): number {
  return right.references.length - left.references.length || compareCandidates(left, right);
}

function candidateToItem(candidate: SearchCandidate): SearchResultItem {
  return {
    id: `${candidate.source}:${candidate.memoryId ?? `${candidate.sessionKey}:${candidate.title ?? candidate.createdAt ?? ''}`}`,
    source: candidate.source,
    title: candidate.title,
    content: candidate.content,
    references: candidate.references,
    createdAt: candidate.createdAt,
    memoryId: candidate.memoryId,
  };
}

function compareCandidates(left: SearchCandidate, right: SearchCandidate): number {
  return right.score - left.score || (right.createdAt ?? '').localeCompare(left.createdAt ?? '');
}

function matchesScope(
  projectKey: string,
  sessionKey: string,
  scope: { projectKeys?: string[]; sessionKeys?: string[] },
): boolean {
  const projectKeys = new Set(scope.projectKeys ?? []);
  const sessionKeys = new Set(scope.sessionKeys ?? []);
  if (projectKeys.size > 0 && !projectKeys.has(projectKey)) {
    return false;
  }
  if (sessionKeys.size > 0 && !sessionKeys.has(sessionKey)) {
    return false;
  }
  return true;
}

function searchSession(hit: RecallHit): {
  sessionKey: string;
  sessionLabel: string;
  agent: string;
  projectKey: string;
} | null {
  const projectKey = normalizeText(hit.project);
  const agent = normalizeText(hit.agent);
  const sessionId = normalizeText(hit.sessionId);
  if (!sessionId || !projectKey || !agent) {
    return null;
  }
  return {
    sessionKey: SessionIdentity.sessionIdentityKey({ project: projectKey, agent, sessionId }),
    sessionLabel: normalizeText(hit.displaySession) ?? displayTitle(sessionId),
    agent,
    projectKey,
  };
}

function displayTitle(sessionKey: string): string {
  const lastSlash = sessionKey.lastIndexOf('/');
  const raw = lastSlash >= 0 ? sessionKey.slice(lastSlash + 1) : sessionKey;
  return raw.replace(/-[0-9a-f]{7,}$/i, '') || sessionKey;
}

function normalizeText(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export const __testing = {
  hitCandidates,
  groupCandidates,
  searchAppMemory,
};
