import { randomUUID } from 'node:crypto';

import type { SessionTurn } from '../client.js';
import { getEmbeddingConfig, getObserverLlmConfig } from '../config.js';
import { embedText } from '../llm/embedding-provider.js';
import { generateText } from '../llm/provider.js';
import { loadPromptTemplate, renderPromptTemplate } from '../llm/prompt-loader.js';
import type { NativeTables, Observation as StoredObservation } from '../native.js';
import type { ObservationCategory, ObservationInput } from './types.js';

const CATEGORIES = new Set<ObservationCategory>([
  'Preference',
  'Fact',
  'Decision',
  'Entity',
  'Concept',
  'Other',
]);

export type ObservationExtractionResult = {
  observations: ObservationInput[];
};

export async function extractObservations(
  turns: SessionTurn[],
  signal?: AbortSignal,
): Promise<ObservationExtractionResult> {
  throwIfAborted(signal);
  const config = getObserverLlmConfig();
  if (!config) {
    throw new Error('observer is not configured');
  }
  if (config.provider === 'mock') {
    return buildMockExtraction(turns);
  }

  const template = loadPromptTemplate('observation_extraction');
  const inputJson = JSON.stringify({ turns: turns.map(toExtractionTurn) }, null, 2);
  const raw = await generateText('observer', {
    system: template.system,
    prompt: renderPromptTemplate(template.userTemplate, { input_json: inputJson }),
    signal,
  });
  if (!raw) {
    throw new Error('observer is not configured');
  }
  return validateExtraction(parseJson<ObservationExtractionResult>(raw));
}

export async function commitObservations(
  client: NativeTables,
  inputs: ObservationInput[],
  signal?: AbortSignal,
): Promise<StoredObservation[]> {
  throwIfAborted(signal);
  const embeddingConfig = getEmbeddingConfig();
  const rows: StoredObservation[] = [];
  for (const input of validateExtraction({ observations: inputs }).observations) {
    const text = input.text.trim();
    rows.push({
      id: randomUUID(),
      text,
      vector: await embedText(text, signal),
      importance: embeddingConfig.defaultImportance,
      category: observationCategory(input.category),
      references: [...new Set(input.references.map((reference) => reference.trim()).filter(Boolean))],
      createdAt: new Date().toISOString(),
    });
  }
  if (rows.length > 0) {
    await client.observationTable.upsert({ rows });
  }
  return rows;
}

function buildMockExtraction(turns: SessionTurn[]): ObservationExtractionResult {
  const observations: ObservationInput[] = [];
  for (const turn of turns) {
    const text = [turn.prompt, turn.response, turn.summary]
      .map((value) => value?.trim())
      .filter(Boolean)
      .join(' ')
      .trim();
    if (text) {
      observations.push({
        text,
        category: 'Fact',
        references: [turn.turnId],
      });
    }
  }
  return validateExtraction({
    observations,
  });
}

function validateExtraction(result: ObservationExtractionResult): ObservationExtractionResult {
  if (!result || typeof result !== 'object' || !Array.isArray(result.observations)) {
    throw new Error('observation extraction must include observations');
  }
  return {
    observations: result.observations.map(validateObservationInput),
  };
}

function validateObservationInput(input: ObservationInput): ObservationInput {
  if (!input || typeof input !== 'object') {
    throw new Error('observation must be an object');
  }
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) {
    throw new Error('observation.text must be a non-empty string');
  }
  if (!CATEGORIES.has(input.category)) {
    throw new Error(`invalid observation category: ${String(input.category)}`);
  }
  if (!Array.isArray(input.references)) {
    throw new Error('observation.references must be an array');
  }
  const references = [...new Set(input.references.map((reference) => (
    typeof reference === 'string' ? reference.trim() : ''
  )).filter(Boolean))];
  if (references.length === 0) {
    throw new Error('observation.references must include at least one reference');
  }
  return {
    text,
    category: input.category,
    references,
  };
}

function toExtractionTurn(turn: SessionTurn): Record<string, unknown> {
  return {
    turnId: turn.turnId,
    ...(turn.createdAt ? { createdAt: turn.createdAt } : {}),
    ...(turn.prompt ? { prompt: turn.prompt } : {}),
    ...(turn.response ? { response: turn.response } : {}),
    ...(turn.summary ? { summary: turn.summary } : {}),
  };
}

function observationCategory(category: ObservationCategory): string {
  switch (category) {
    case 'Preference':
      return 'preference';
    case 'Fact':
      return 'fact';
    case 'Decision':
      return 'decision';
    case 'Entity':
      return 'entity';
    case 'Concept':
    case 'Other':
      return 'other';
    default:
      return 'other';
  }
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
  validateExtraction,
};
