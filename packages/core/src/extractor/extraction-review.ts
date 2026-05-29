import { getExtractorLlmConfig } from '../config.js';
import { generateText } from '../llm/provider.js';
import { loadPromptTemplate, renderPromptTemplate } from '../llm/prompt-loader.js';
import type { Extraction } from '../native.js';

export type ExtractionReviewInput = {
  newExtractions: Extraction[];
  candidateExtractions: Extraction[];
};

export type ExtractionReviewResult = {
  removeExtractionIds: string[];
  reviewedExtractionIds: string[];
};

export async function reviewExtractions(
  input: ExtractionReviewInput,
  signal?: AbortSignal,
): Promise<ExtractionReviewResult> {
  throwIfAborted(signal);
  const config = getExtractorLlmConfig();
  if (!config) {
    throw new Error('observer is not configured');
  }
  if (config.provider === 'mock') {
    return {
      removeExtractionIds: [],
      reviewedExtractionIds: input.newExtractions.map((extraction) => extraction.id),
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
  return validateReview(input, parseJson<ExtractionReviewResult>(raw));
}

function validateReview(
  input: ExtractionReviewInput,
  result: ExtractionReviewResult,
): ExtractionReviewResult {
  if (!result || typeof result !== 'object') {
    throw new Error('extraction review must return an object');
  }
  const removeExtractionIds = normalizeIdList(result.removeExtractionIds, 'removeExtractionIds');
  const reviewedExtractionIds = normalizeIdList(result.reviewedExtractionIds, 'reviewedExtractionIds');
  const candidateIds = new Set(input.candidateExtractions.map((extraction) => extraction.id));
  const newIds = new Set(input.newExtractions.map((extraction) => extraction.id));
  const coveredNewIds = new Set([...removeExtractionIds, ...reviewedExtractionIds]);

  for (const id of removeExtractionIds) {
    if (!candidateIds.has(id) && !newIds.has(id)) {
      throw new Error(`removeExtractionIds includes unknown extraction id: ${id}`);
    }
  }
  for (const id of reviewedExtractionIds) {
    if (!newIds.has(id)) {
      throw new Error(`reviewedExtractionIds includes non-new extraction id: ${id}`);
    }
  }
  for (const id of newIds) {
    if (!coveredNewIds.has(id)) {
      throw new Error(`new extraction id was not reviewed: ${id}`);
    }
  }
  return {
    removeExtractionIds,
    reviewedExtractionIds,
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
