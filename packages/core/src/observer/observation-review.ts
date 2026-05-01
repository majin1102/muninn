import { getObserverLlmConfig } from '../config.js';
import { generateText } from '../llm/provider.js';
import { loadPromptTemplate, renderPromptTemplate } from '../llm/prompt-loader.js';
import type { Observation } from '../native.js';

export type ObservationReviewInput = {
  newObservations: Observation[];
  candidateObservations: Observation[];
};

export type ObservationReviewResult = {
  removeObservationIds: string[];
  reviewedObservationIds: string[];
};

export async function reviewObservations(
  input: ObservationReviewInput,
  signal?: AbortSignal,
): Promise<ObservationReviewResult> {
  throwIfAborted(signal);
  const config = getObserverLlmConfig();
  if (!config) {
    throw new Error('observer is not configured');
  }
  if (config.provider === 'mock') {
    return {
      removeObservationIds: [],
      reviewedObservationIds: input.newObservations.map((observation) => observation.id),
    };
  }

  const template = loadPromptTemplate('observation_review');
  const inputJson = JSON.stringify(input, null, 2);
  const raw = await generateText('observer', {
    system: template.system,
    prompt: renderPromptTemplate(template.userTemplate, { input_json: inputJson }),
    signal,
  });
  if (!raw) {
    throw new Error('observer is not configured');
  }
  return validateReview(input, parseJson<ObservationReviewResult>(raw));
}

function validateReview(
  input: ObservationReviewInput,
  result: ObservationReviewResult,
): ObservationReviewResult {
  if (!result || typeof result !== 'object') {
    throw new Error('observation review must return an object');
  }
  const removeObservationIds = normalizeIdList(result.removeObservationIds, 'removeObservationIds');
  const reviewedObservationIds = normalizeIdList(result.reviewedObservationIds, 'reviewedObservationIds');
  const candidateIds = new Set(input.candidateObservations.map((observation) => observation.id));
  const newIds = new Set(input.newObservations.map((observation) => observation.id));
  const coveredNewIds = new Set([...removeObservationIds, ...reviewedObservationIds]);

  for (const id of removeObservationIds) {
    if (!candidateIds.has(id) && !newIds.has(id)) {
      throw new Error(`removeObservationIds includes unknown observation id: ${id}`);
    }
  }
  for (const id of reviewedObservationIds) {
    if (!newIds.has(id)) {
      throw new Error(`reviewedObservationIds includes non-new observation id: ${id}`);
    }
  }
  for (const id of newIds) {
    if (!coveredNewIds.has(id)) {
      throw new Error(`new observation id was not reviewed: ${id}`);
    }
  }
  return {
    removeObservationIds,
    reviewedObservationIds,
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
  validateReview,
};
