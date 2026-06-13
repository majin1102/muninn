import { randomUUID } from 'node:crypto';

import type { Turn } from '../backend.js';
import { getExtractorLlmConfig } from '../config.js';
import { loadDomainPrompt } from '../llm/domain-prompt.js';
import { embedText } from '../llm/embedding-provider.js';
import { generateText } from '../llm/provider.js';
import { loadPromptTemplate, renderPromptTemplate } from '../llm/prompt-loader.js';
import type { NativeTables, Extraction as StoredExtraction } from '../native.js';
import type { ExtractionInput } from './types.js';

export type ExtractionExtractionResult = {
  extractions: ExtractionInput[];
};

export async function extractExtractions(
  turns: Turn[],
  signal?: AbortSignal,
): Promise<ExtractionExtractionResult> {
  throwIfAborted(signal);
  const config = getExtractorLlmConfig();
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
  const raw = await generateText('extractor', {
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
  cwd: string,
  signal?: AbortSignal,
): Promise<StoredExtraction[]> {
  throwIfAborted(signal);
  const normalizedCwd = cwd.trim();
  if (!normalizedCwd) {
    throw new Error('cwd is required to commit extractions');
  }
  const rows: StoredExtraction[] = [];
  for (const input of validateExtraction({ extractions: inputs }).extractions) {
    const text = input.text.trim();
    const title = normalizeText(input.title ?? '') || text.slice(0, 80);
    const summary = [title, text].filter(Boolean).join('\n\n');
    const now = new Date().toISOString();
    rows.push({
      id: randomUUID(),
      title,
      summary,
      content: renderExtractionContent(title, text, input.context ?? null),
      cwd: normalizedCwd,
      vector: await embedText(summary, signal),
      turnRefs: [...new Set(input.references.map((reference) => reference.trim()).filter(Boolean))],
      globalObservationPaths: [],
      createdAt: now,
      updatedAt: now,
    });
  }
  if (rows.length > 0) {
    await client.extractionTable.upsert({ rows });
  }
  return rows;
}

function renderExtractionContent(title: string, summary: string, content: string | null): string {
  return [
    '## Title',
    '',
    title,
    '',
    '## Summary',
    '',
    normalizeText(summary),
    '',
    '## Content',
    '',
    content?.trim() ?? '',
  ].join('\n');
}

function normalizeText(value: string): string {
  return value.split(/\s+/).join(' ').trim();
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
    title: typeof input.title === 'string' ? input.title.trim() || null : null,
    context: typeof input.context === 'string' ? input.context.trim() || null : null,
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
