import { getObserverLlmConfig } from '../config.js';
import { generateText } from '../llm/provider.js';
import { loadPromptTemplate, renderPromptTemplate } from '../llm/prompt-loader.js';
import type { Observation } from '../native.js';
import type {
  ThreadCandidateMemory,
  ThreadPreparationResult,
  ThreadPreparationThread,
  ThreadWorkItem,
} from './types.js';

export type ThreadPreparationInput = {
  reviewedObservations: Observation[];
  activeThreads: ThreadPreparationThread[];
  candidateMemories?: ThreadCandidateMemory[];
};

export async function prepareThreads(
  input: ThreadPreparationInput,
  signal?: AbortSignal,
): Promise<ThreadPreparationResult> {
  throwIfAborted(signal);
  const config = getObserverLlmConfig();
  if (!config) {
    throw new Error('observer is not configured');
  }
  if (config.provider === 'mock') {
    return validateThreadPreparation(input, {
      workItems: [],
      unthreadedObservationIds: input.reviewedObservations.map((observation) => observation.id),
    });
  }

  const template = loadPromptTemplate('thread_preparation');
  const inputJson = JSON.stringify(toPromptInput(input), null, 2);
  // The prompt contract is get-only. The current text provider path runs it as a structured call;
  // the loop runner can replace this call without changing ThreadPreparationResult.
  const raw = await generateText('observer', {
    system: template.system,
    prompt: renderPromptTemplate(template.userTemplate, { input_json: inputJson }),
    signal,
  });
  if (!raw) {
    throw new Error('observer is not configured');
  }
  return validateThreadPreparation(input, parseJson<ThreadPreparationResult>(raw));
}

function validateThreadPreparation(
  input: ThreadPreparationInput,
  result: ThreadPreparationResult,
): ThreadPreparationResult {
  if (!result || typeof result !== 'object') {
    throw new Error('thread preparation must return an object');
  }
  if (!Array.isArray(result.workItems)) {
    throw new Error('thread preparation workItems must be an array');
  }

  const reviewedIds = new Set(input.reviewedObservations.map((observation) => observation.id));
  const activeThreadIds = new Set(input.activeThreads.map((thread) => thread.threadId));
  const seen = new Set<string>();
  const workItems = result.workItems.map((item) => (
    validateWorkItem(item, reviewedIds, activeThreadIds, seen)
  ));
  const unthreadedObservationIds = normalizeIdList(result.unthreadedObservationIds, 'unthreadedObservationIds');
  for (const id of unthreadedObservationIds) {
    if (!reviewedIds.has(id)) {
      throw new Error(`unthreadedObservationIds includes unknown observation id: ${id}`);
    }
    if (seen.has(id)) {
      throw new Error(`reviewed observation id must appear exactly once: ${id}`);
    }
    seen.add(id);
  }

  for (const id of reviewedIds) {
    if (!seen.has(id)) {
      throw new Error(`reviewed observation id must appear exactly once: ${id}`);
    }
  }

  return {
    workItems,
    unthreadedObservationIds,
  };
}

function validateWorkItem(
  item: ThreadWorkItem,
  reviewedIds: Set<string>,
  activeThreadIds: Set<string>,
  seen: Set<string>,
): ThreadWorkItem {
  if (!item || typeof item !== 'object') {
    throw new Error('thread preparation work item must be an object');
  }
  const observationIds = normalizeIdList(item.observationIds, 'workItems[].observationIds');
  if (observationIds.length === 0) {
    throw new Error('workItems[].observationIds must include at least one observation id');
  }
  for (const id of observationIds) {
    if (!reviewedIds.has(id)) {
      throw new Error(`work item includes unknown observation id: ${id}`);
    }
    if (seen.has(id)) {
      throw new Error(`reviewed observation id must appear exactly once: ${id}`);
    }
    seen.add(id);
  }

  const targetThreadId = normalizeOptionalString(item.targetThreadId);
  const newThreadTitle = normalizeOptionalString(item.newThreadTitle);
  if ((targetThreadId && newThreadTitle) || (!targetThreadId && !newThreadTitle)) {
    throw new Error('work item must include either targetThreadId or newThreadTitle');
  }
  if (targetThreadId && !activeThreadIds.has(targetThreadId)) {
    throw new Error(`unknown targetThreadId: ${targetThreadId}`);
  }
  if (newThreadTitle && observationIds.length < 2) {
    throw new Error('newThreadTitle requires at least two related observations');
  }

  const rationale = typeof item.rationale === 'string' ? item.rationale.trim() : '';
  if (!rationale) {
    throw new Error('work item rationale must be a non-empty string');
  }

  return {
    observationIds,
    ...(targetThreadId ? { targetThreadId } : {}),
    ...(newThreadTitle ? { newThreadTitle } : {}),
    rationale,
  };
}

function normalizeIdList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  const ids = value.map((id) => (typeof id === 'string' ? id.trim() : '')).filter(Boolean);
  if (ids.length !== new Set(ids).size) {
    throw new Error(`${label} contains duplicate observation ids`);
  }
  return ids;
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function toPromptInput(input: ThreadPreparationInput): Record<string, unknown> {
  return {
    reviewedObservations: input.reviewedObservations.map((observation) => ({
      id: observation.id,
      text: observation.text,
      category: observation.category,
      references: observation.references,
    })),
    activeThreads: input.activeThreads,
    candidateMemories: input.candidateMemories ?? [],
  };
}

function parseJson<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end >= start) {
      return JSON.parse(raw.slice(start, end + 1)) as T;
    }
    throw new Error('invalid JSON');
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  const reason = signal.reason;
  if (reason instanceof Error) {
    throw reason;
  }
  const error = new Error('operation aborted');
  error.name = 'AbortError';
  throw error;
}

export const __testing = {
  validateThreadPreparation,
};
