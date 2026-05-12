import { randomUUID } from 'node:crypto';

import type { Turn } from '../client.js';
import { getEmbeddingConfig, getObserverLlmConfig } from '../config.js';
import { loadDomainPrompt } from '../llm/domain-prompt.js';
import { embedText } from '../llm/embedding-provider.js';
import { generateText } from '../llm/provider.js';
import { loadPromptTemplate, renderPromptTemplate } from '../llm/prompt-loader.js';
import type { NativeTables, Extraction as StoredExtraction } from '../native.js';
import type { ExtractionCategory, ExtractionInput } from './types.js';

const CATEGORIES = new Set<ExtractionCategory>([
  'Preference',
  'Fact',
  'Decision',
  'Entity',
  'Concept',
  'Other',
]);

export type ExtractionExtractionResult = {
  extractions: ExtractionInput[];
};

export async function extractExtractions(
  turns: Turn[],
  signal?: AbortSignal,
): Promise<ExtractionExtractionResult> {
  throwIfAborted(signal);
  const config = getObserverLlmConfig();
  if (!config) {
    throw new Error('observer is not configured');
  }
  if (config.provider === 'mock') {
    return buildMockExtraction(turns);
  }

  const inputJson = JSON.stringify({ turns: turns.map(toExtractionTurn) }, null, 2);
  const rendered = renderExtractionPrompt({
    inputJson,
    domainPrompt: loadDomainPrompt(config.domainPrompt),
  });
  const raw = await generateText('observer', {
    system: rendered.system,
    prompt: rendered.prompt,
    signal,
  });
  if (!raw) {
    throw new Error('observer is not configured');
  }
  return validateExtraction(parseJson<ExtractionExtractionResult>(raw));
}

export async function commitExtractions(
  client: NativeTables,
  inputs: ExtractionInput[],
  signal?: AbortSignal,
): Promise<StoredExtraction[]> {
  throwIfAborted(signal);
  const embeddingConfig = getEmbeddingConfig();
  const rows: StoredExtraction[] = [];
  for (const input of validateExtraction({ extractions: inputs }).extractions) {
    const text = input.text.trim();
    rows.push({
      id: randomUUID(),
      text,
      context: input.context ?? null,
      anchors: [],
      vector: await embedText(text, signal),
      importance: embeddingConfig.defaultImportance,
      category: extractionCategory(input.category),
      references: [...new Set(input.references.map((reference) => reference.trim()).filter(Boolean))],
      createdAt: new Date().toISOString(),
    });
  }
  if (rows.length > 0) {
    await client.extractionTable.upsert({ rows });
  }
  return rows;
}

function buildMockExtraction(turns: Turn[]): ExtractionExtractionResult {
  const extractions: ExtractionInput[] = [];
  for (const turn of turns) {
    const text = [turn.prompt, turn.response, turn.summary]
      .map((value) => value?.trim())
      .filter(Boolean)
      .join(' ')
      .trim();
    if (text) {
      extractions.push({
        text,
        category: 'Fact',
        references: [turn.turnId],
      });
    }
  }
  return validateExtraction({
    extractions,
  });
}

function renderExtractionPrompt(input: {
  inputJson: string;
  domainPrompt?: string;
}): { system: string; prompt: string } {
  const template = loadPromptTemplate('extraction_extraction');
  return {
    system: renderPromptTemplate(template.system, {
      domain_prompt: input.domainPrompt?.trim() || 'No additional domain guidance.',
    }),
    prompt: renderPromptTemplate(template.userTemplate, { input_json: input.inputJson }),
  };
}

function validateExtraction(result: ExtractionExtractionResult): ExtractionExtractionResult {
  if (!result || typeof result !== 'object' || !Array.isArray(result.extractions)) {
    throw new Error('extraction extraction must include extractions');
  }
  return {
    extractions: result.extractions.map(validateExtractionInput),
  };
}

function validateExtractionInput(input: ExtractionInput): ExtractionInput {
  if (!input || typeof input !== 'object') {
    throw new Error('extraction must be an object');
  }
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) {
    throw new Error('extraction.text must be a non-empty string');
  }
  if (!CATEGORIES.has(input.category)) {
    throw new Error(`invalid extraction category: ${String(input.category)}`);
  }
  if (!Array.isArray(input.references)) {
    throw new Error('extraction.references must be an array');
  }
  const references = [...new Set(input.references.map((reference) => (
    typeof reference === 'string' ? reference.trim() : ''
  )).filter(Boolean))];
  if (references.length === 0) {
    throw new Error('extraction.references must include at least one reference');
  }
  return {
    text,
    category: input.category,
    references,
  };
}

function toExtractionTurn(turn: Turn): Record<string, unknown> {
  return {
    turnId: turn.turnId,
    ...(turn.createdAt ? { createdAt: turn.createdAt } : {}),
    ...(turn.recentContext && turn.recentContext.length > 0
      ? { recentContext: turn.recentContext.map(toExtractionContextTurn) }
      : {}),
    ...(turn.prompt ? { prompt: turn.prompt } : {}),
    ...(turn.response ? { response: turn.response } : {}),
    ...(turn.summary ? { summary: turn.summary } : {}),
  };
}

function toExtractionContextTurn(turn: NonNullable<Turn['recentContext']>[number]): Record<string, unknown> {
  return {
    turnId: turn.turnId,
    ...(turn.updatedAt ? { updatedAt: turn.updatedAt } : {}),
    ...(turn.prompt ? { prompt: turn.prompt } : {}),
    ...(turn.response ? { response: turn.response } : {}),
  };
}

function extractionCategory(category: ExtractionCategory): string {
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
  renderExtractionPrompt,
  toExtractionTurn,
  validateExtraction,
};
