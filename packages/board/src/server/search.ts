import type {
  RecallHit,
  Turn,
} from '@muninn/core';
import type {
  SearchResultItem,
  SearchResultLink,
  SearchSessionResult,
} from '@muninn/types';

type BoardTurn = Turn & { memoryId?: string };

export type BoardSearchParams = {
  query: string;
  projectKeys?: string[];
  sessionKeys?: string[];
  sessionTopN: number;
  topN: number;
};

export type SearchCandidate = {
  sessionKey: string;
  sessionLabel: string;
  projectKey: string;
  latestUpdatedAt: string;
  source: 'extraction' | 'conversation';
  memoryId?: string;
  title?: string;
  content: string;
  createdAt?: string;
  score: number;
  links: SearchResultLink[];
};

export type BoardSearchResult = {
  results: SearchSessionResult[];
};

type SearchDeps = {
  listTurns: (params: { mode: { type: 'recency'; limit: number } }) => Promise<Turn[]>;
  recall: (query: string, limit?: number, options?: { mode?: 'vector' | 'fts' | 'hybrid'; budget?: number; queryLimit?: number }) => Promise<RecallHit[]>;
};

export async function searchBoardMemory(params: BoardSearchParams, deps: SearchDeps): Promise<BoardSearchResult> {
  const query = params.query.trim();
  if (!query) {
    return {
      results: [],
    };
  }

  const allTurns = await deps.listTurns({
    mode: { type: 'recency', limit: 1_000_000 },
  });
  const conversations = conversationCandidates(allTurns, {
    query,
    projectKeys: params.projectKeys,
    sessionKeys: params.sessionKeys,
  });

  const extractionHits = await deps.recall(query, Math.max(params.topN * params.sessionTopN, params.topN), {
    mode: 'hybrid',
    budget: 0,
  });
  const extractions = extractionCandidates(extractionHits, allTurns, {
    projectKeys: params.projectKeys,
    sessionKeys: params.sessionKeys,
  });

  return {
    results: groupCandidates([...conversations, ...extractions], {
      sessionTopN: params.sessionTopN,
      topN: params.topN,
    }),
  };
}

function conversationCandidates(
  turns: BoardTurn[],
  scope: { query: string; projectKeys?: string[]; sessionKeys?: string[] },
): SearchCandidate[] {
  const query = scope.query.trim().toLowerCase();
  return turns.flatMap((turn) => {
    const sessionKey = turn.sessionId ?? '';
    const projectKey = projectKeyFromSessionKey(sessionKey);
    if (!sessionKey || !matchesScope(projectKey, sessionKey, scope)) {
      return [];
    }

    const text = [
      turn.title,
      turn.summary,
      turn.prompt,
      turn.response,
      eventsText(turn),
    ].filter((value): value is string => Boolean(value?.trim())).join('\n\n');
    const score = scoreText(text, query);
    if (score <= 0) {
      return [];
    }

    const memoryId = turnMemoryId(turn);
    return [{
      sessionKey,
      sessionLabel: displayTitle(sessionKey),
      projectKey,
      latestUpdatedAt: turn.updatedAt,
      source: 'conversation' as const,
      memoryId,
      title: turn.title ?? turn.summary ?? undefined,
      content: text,
      createdAt: turn.createdAt,
      score,
      links: [{
        kind: 'turn' as const,
        label: 'Open turn',
        memoryId,
        sessionKey,
      }],
    }];
  });
}

function extractionCandidates(
  hits: RecallHit[],
  turns: BoardTurn[],
  scope: { projectKeys?: string[]; sessionKeys?: string[] },
): SearchCandidate[] {
  const turnsById = new Map(turns.map((turn) => [turnMemoryId(turn), turn]));
  return hits.flatMap((hit, index) => {
    if (!hit.memoryId.startsWith('extraction:') && !hit.memoryId.startsWith('observation:')) {
      return [];
    }
    const refTurn = (hit.references ?? [])
      .map((ref) => turnsById.get(ref))
      .find((turn): turn is BoardTurn => Boolean(turn?.sessionId));
    if (!refTurn?.sessionId) {
      return [];
    }
    const sessionKey = refTurn.sessionId;
    const projectKey = projectKeyFromSessionKey(sessionKey);
    if (!matchesScope(projectKey, sessionKey, scope)) {
      return [];
    }
    return [{
      sessionKey,
      sessionLabel: displayTitle(sessionKey),
      projectKey,
      latestUpdatedAt: refTurn.updatedAt,
      source: 'extraction' as const,
      memoryId: hit.memoryId,
      title: 'Extraction match',
      content: hit.text,
      createdAt: refTurn.createdAt,
      score: 90 - index,
      links: [{
        kind: 'memory' as const,
        label: 'Open memory',
        memoryId: hit.memoryId,
        sessionKey,
      }],
    }];
  });
}

function groupCandidates(
  candidates: SearchCandidate[],
  limits: { sessionTopN: number; topN: number },
): SearchSessionResult[] {
  const grouped = new Map<string, SearchCandidate[]>();
  for (const candidate of candidates) {
    const current = grouped.get(candidate.sessionKey) ?? [];
    current.push(candidate);
    grouped.set(candidate.sessionKey, current);
  }

  return [...grouped.entries()]
    .map(([sessionKey, items]) => {
      const sorted = items.slice().sort(compareCandidates);
      const first = sorted[0]!;
      return {
        sessionKey,
        sessionLabel: first.sessionLabel,
        projectKey: first.projectKey,
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
    .slice(0, limits.topN)
    .map(({ score: _score, ...result }) => result);
}

function candidateToItem(candidate: SearchCandidate): SearchResultItem {
  return {
    id: `${candidate.source}:${candidate.memoryId ?? `${candidate.sessionKey}:${candidate.title ?? candidate.createdAt ?? ''}`}`,
    source: candidate.source,
    title: candidate.title,
    content: candidate.content,
    createdAt: candidate.createdAt,
    memoryId: candidate.memoryId,
    links: candidate.links,
  };
}

function compareCandidates(left: SearchCandidate, right: SearchCandidate): number {
  return right.score - left.score || (right.createdAt ?? '').localeCompare(left.createdAt ?? '');
}

function scoreText(text: string, query: string): number {
  const haystack = text.toLowerCase();
  if (haystack.includes(query)) {
    return 100 + query.length;
  }
  const terms = query.split(/\s+/).filter(Boolean);
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
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

function projectKeyFromSessionKey(sessionKey: string): string {
  const [projectKey] = sessionKey.split('/').filter(Boolean);
  return projectKey || 'Default Project';
}

function displayTitle(sessionKey: string): string {
  const lastSlash = sessionKey.lastIndexOf('/');
  const raw = lastSlash >= 0 ? sessionKey.slice(lastSlash + 1) : sessionKey;
  return raw.replace(/-[0-9a-f]{7,}$/i, '') || sessionKey;
}

function eventsText(turn: BoardTurn): string | undefined {
  const text = turn.events
    ?.map((event) => 'text' in event ? event.text : 'output' in event ? event.output : 'input' in event ? event.input : undefined)
    .filter((value): value is string => Boolean(value?.trim()))
    .join('\n');
  return text || undefined;
}

function turnMemoryId(turn: BoardTurn): string {
  return turn.memoryId ?? turn.turnId;
}

export const __testing = {
  conversationCandidates,
  extractionCandidates,
  groupCandidates,
  scoreText,
  searchBoardMemory,
};
