import { getExtractorLlmConfig } from '../config.js';
import { generateText } from '../llm/provider.js';
import { loadPromptTemplate, renderPromptTemplate } from '../llm/prompt-loader.js';
import type { SessionObservation } from '../native.js';

export type SessionObservationReviewInput = {
  newSessionObservations: SessionObservation[];
  candidateSessionObservations: SessionObservation[];
};

export type SessionObservationReviewResult = {
  removeSessionObservationIds: string[];
  reviewedSessionObservationIds: string[];
};

export async function reviewSessionObservations(
  input: SessionObservationReviewInput,
  signal?: AbortSignal,
): Promise<SessionObservationReviewResult> {
  throwIfAborted(signal);
  const config = getExtractorLlmConfig();
  if (!config) {
    throw new Error('observer is not configured');
  }
  if (config.provider === 'mock') {
    return {
      removeSessionObservationIds: [],
      reviewedSessionObservationIds: input.newSessionObservations.map((extraction) => extraction.id),
    };
  }

  const template = loadPromptTemplate('extraction_review');
  const inputJson = JSON.stringify(input, null, 2);
  const raw = await generateText('extractor', {
    system: template.system,
    prompt: renderPromptTemplate(template.userTemplate, { input_json: inputJson }),
    signal,
  });
  if (!raw) {
    throw new Error('observer is not configured');
  }
  return validateReview(input, parseJson<SessionObservationReviewResult>(raw));
}

function validateReview(
  input: SessionObservationReviewInput,
  result: SessionObservationReviewResult,
): SessionObservationReviewResult {
  if (!result || typeof result !== 'object') {
    throw new Error('extraction review must return an object');
  }
  const removeSessionObservationIds = normalizeIdList(result.removeSessionObservationIds, 'removeSessionObservationIds');
  const reviewedSessionObservationIds = normalizeIdList(result.reviewedSessionObservationIds, 'reviewedSessionObservationIds');
  const candidateIds = new Set(input.candidateSessionObservations.map((extraction) => extraction.id));
  const newIds = new Set(input.newSessionObservations.map((extraction) => extraction.id));
  const coveredNewIds = new Set([...removeSessionObservationIds, ...reviewedSessionObservationIds]);

  for (const id of removeSessionObservationIds) {
    if (!candidateIds.has(id) && !newIds.has(id)) {
      throw new Error(`removeSessionObservationIds includes unknown extraction id: ${id}`);
    }
  }
  for (const id of reviewedSessionObservationIds) {
    if (!newIds.has(id)) {
      throw new Error(`reviewedSessionObservationIds includes non-new extraction id: ${id}`);
    }
  }
  for (const id of newIds) {
    if (!coveredNewIds.has(id)) {
      throw new Error(`new extraction id was not reviewed: ${id}`);
    }
  }
  return {
    removeSessionObservationIds,
    reviewedSessionObservationIds,
  };
}

function normalizeIdList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  const ids = value.map((id) => (typeof id === 'string' ? id.trim() : '')).filter(Boolean);
  if (ids.length !== new Set(ids).size) {
    throw new Error(`${label} contains duplicate extraction ids`);
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
