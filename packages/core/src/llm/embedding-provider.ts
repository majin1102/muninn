import { getEmbeddingConfig } from './config.js';

export async function embedText(text: string, signal?: AbortSignal): Promise<number[]> {
  const config = getEmbeddingConfig();
  if (config.provider === 'mock') {
    return mockEmbedding(text, config.dimensions);
  }
  throwIfAborted(signal);
  if (!config.apiKey?.trim()) {
    throw new Error('semanticIndex.embedding.apiKey is required for openai embeddings');
  }

  const response = await fetch(config.baseUrl ?? 'https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
    },
    signal,
    body: JSON.stringify({
      model: config.model ?? 'text-embedding-3-small',
      input: text,
      dimensions: config.dimensions,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `semanticIndex embedding request failed with status ${response.status}: ${await response.text()}`,
    );
  }
  const payload = await response.json() as { data?: Array<{ embedding?: number[] }> };
  const vector = payload.data?.[0]?.embedding;
  if (!Array.isArray(vector)) {
    throw new Error('semanticIndex embedding response missing vector');
  }
  return vector;
}

function mockEmbedding(text: string, dimensions: number): number[] {
  const values = new Array(Math.max(dimensions, 1)).fill(0);
  for (let index = 0; index < text.length; index += 1) {
    const slot = index % values.length;
    values[slot] += text.charCodeAt(index) / 255;
  }
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (norm > 0) {
    return values.map((value) => value / norm);
  }
  return values;
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
