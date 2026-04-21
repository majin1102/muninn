import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { embedText } from '../dist/llm/embedding-provider.js';

async function withConfig(t, config) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'muninn-embedding-provider-'));
  const homeDir = path.join(dir, 'muninn');
  await mkdir(homeDir, { recursive: true });
  await writeFile(
    path.join(homeDir, 'muninn.json'),
    `${JSON.stringify(config, null, 2)}\n`,
    'utf8',
  );

  const originalHome = process.env.MUNINN_HOME;
  process.env.MUNINN_HOME = homeDir;
  t.after(async () => {
    if (originalHome === undefined) {
      delete process.env.MUNINN_HOME;
    } else {
      process.env.MUNINN_HOME = originalHome;
    }
    await rm(dir, { recursive: true, force: true });
  });
}

function makeConfig(embedding) {
  return {
    observer: {
      name: 'default-observer',
      llm: 'observer_llm',
    },
    llm: {
      observer_llm: {
        provider: 'mock',
      },
    },
    semanticIndex: {
      embedding,
      defaultImportance: 0.7,
    },
  };
}

test('embedText sends Doubao multimodal embedding request shape', async (t) => {
  await withConfig(t, makeConfig({
    provider: 'openai',
    model: 'doubao-embedding-vision-251215',
    apiKey: 'test-key',
    baseUrl: 'https://operator.example/api/v1/embeddings/multimodal',
    dimensions: 1024,
  }));

  let requestBody;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      data: [
        {
          embedding: [0.1, 0.2],
        },
      ],
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const vector = await embedText('seed memory');

  assert.deepEqual(vector, [0.1, 0.2]);
  assert.deepEqual(requestBody, {
    model: 'doubao-embedding-vision-251215',
    input: [
      {
        type: 'text',
        text: 'seed memory',
      },
    ],
  });
});

test('embedText accepts Doubao dense embedding response shape', async (t) => {
  await withConfig(t, makeConfig({
    provider: 'openai',
    model: 'doubao-embedding-vision-251215',
    apiKey: 'test-key',
    baseUrl: 'https://operator.example/api/v1/embeddings/multimodal',
    dimensions: 1024,
  }));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => (
    new Response(JSON.stringify({
      data: [
        {
          dense: [0.3, 0.4],
        },
      ],
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    })
  );
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  assert.deepEqual(await embedText('seed memory'), [0.3, 0.4]);
});

test('embedText accepts Doubao object embedding response shape', async (t) => {
  await withConfig(t, makeConfig({
    provider: 'openai',
    model: 'doubao-embedding-vision-251215',
    apiKey: 'test-key',
    baseUrl: 'https://operator.example/api/v1/embeddings/multimodal',
    dimensions: 2048,
  }));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => (
    new Response(JSON.stringify({
      data: {
        object: 'embedding',
        embedding: [0.5, 0.6],
      },
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    })
  );
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  assert.deepEqual(await embedText('seed memory'), [0.5, 0.6]);
});
