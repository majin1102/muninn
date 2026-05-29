import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { validateMuninnConfigInput } from '../dist/config.js';
import { generateText, generateWithTools } from '../dist/llm/provider.js';

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8')
    .toString('base64url');
}

function makeJwt(exp) {
  return `${base64UrlJson({ alg: 'none' })}.${base64UrlJson({ exp })}.signature`;
}

function makeConfig({ provider = 'openai-codex', model, baseUrl } = {}) {
  return {
    extractor: {
      name: 'test-extractor',
      llm: 'extractor_llm',
      maxAttempts: 3,
      activeWindowDays: 3650,
    },
    observer: {
      name: 'test-observer',
      llm: 'observer_llm',
      maxAttempts: 3,
    },
    llm: {
      extractor_llm: {
        provider,
        ...(model ? { model } : {}),
        ...(baseUrl ? { baseUrl } : {}),
      },
      observer_llm: {
        provider,
        ...(model ? { model } : {}),
        ...(baseUrl ? { baseUrl } : {}),
      },
    },
    extraction: {
      embedding: {
        provider: 'mock',
        dimensions: 4,
      },
    },
  };
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function setupCodexRun(t, {
  authMode = 'chatgpt',
  accessToken = makeJwt(Math.floor(Date.now() / 1000) + 172_800),
  config = makeConfig(),
} = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'muninn-openai-codex-provider-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const muninnHome = path.join(dir, 'muninn');
  const codexHome = path.join(dir, 'codex');
  await writeJson(path.join(muninnHome, 'muninn.json'), config);
  await writeJson(path.join(codexHome, 'auth.json'), {
    auth_mode: authMode,
    tokens: {
      access_token: accessToken,
      refresh_token: 'refresh-token',
      account_id: 'account-id',
    },
  });

  process.env.MUNINN_HOME = muninnHome;
  process.env.CODEX_HOME = codexHome;
}

test.beforeEach(() => {
  delete process.env.MUNINN_HOME;
  delete process.env.CODEX_HOME;
});

test.after(() => {
  delete process.env.MUNINN_HOME;
  delete process.env.CODEX_HOME;
});

test('validateMuninnConfigInput accepts openai-codex llm without apiKey', () => {
  assert.doesNotThrow(() => validateMuninnConfigInput(JSON.stringify(makeConfig())));
});

test('validateMuninnConfigInput keeps openai-codex out of embedding providers', () => {
  const config = makeConfig();
  config.extraction.embedding.provider = 'openai-codex';

  assert.throws(
    () => validateMuninnConfigInput(JSON.stringify(config)),
    /unsupported embedding provider: openai-codex/i,
  );
});

test('generateText sends openai-codex requests through Codex CLI auth', async (t) => {
  await setupCodexRun(t);
  const originalFetch = globalThis.fetch;
  let capturedInput;
  let capturedInit;
  globalThis.fetch = async (input, init) => {
    capturedInput = input;
    capturedInit = init;
    return new Response(codexSse({ type: 'response.output_text.delta', delta: 'Codex answer' }));
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const output = await generateText('observer', {
    system: 'system prompt',
    prompt: 'user prompt',
  });

  assert.equal(output, 'Codex answer');
  assert.equal(capturedInput, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(capturedInit.method, 'POST');
  assert.equal(capturedInit.headers.authorization.startsWith('Bearer '), true);
  assert.equal(capturedInit.headers['content-type'], 'application/json');
  const body = JSON.parse(capturedInit.body);
  assert.equal(body.model, 'gpt-5.4');
  assert.equal(body.instructions, 'system prompt');
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.deepEqual(body.input, [
    {
      role: 'user',
      content: [{ type: 'input_text', text: 'user prompt' }],
    },
  ]);
});

test('generateWithTools sends openai-codex Responses tools and parses calls', async (t) => {
  await setupCodexRun(t);
  const originalFetch = globalThis.fetch;
  let capturedInput;
  let capturedInit;
  globalThis.fetch = async (input, init) => {
    capturedInput = input;
    capturedInit = init;
    return new Response(codexSse({
      type: 'response.completed',
      response: {
        output: [{
        type: 'function_call',
        call_id: 'call-1',
        name: 'memory-get',
        arguments: '{"memoryIds":["extraction:1"]}',
        }],
      },
    }));
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await generateWithTools('observer', {
    messages: [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'user prompt' },
    ],
    tools: [{
      name: 'memory-get',
      description: 'Get memory details.',
      parameters: {
        type: 'object',
        properties: {
          memoryIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['memoryIds'],
      },
    }],
  });

  assert.equal(capturedInput, 'https://chatgpt.com/backend-api/codex/responses');
  const body = JSON.parse(capturedInit.body);
  assert.equal(body.instructions, 'system prompt');
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.deepEqual(body.input, [
    {
      role: 'user',
      content: [{ type: 'input_text', text: 'user prompt' }],
    },
  ]);
  assert.deepEqual(body.tools, [{
    type: 'function',
    name: 'memory-get',
    description: 'Get memory details.',
    parameters: {
      type: 'object',
      properties: {
        memoryIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['memoryIds'],
    },
  }]);
  assert.deepEqual(result, {
    type: 'tool_calls',
    toolCalls: [{
      id: 'call-1',
      name: 'memory-get',
      arguments: { memoryIds: ['extraction:1'] },
    }],
  });
});

test('generateWithTools dedupes openai-codex streaming function call skeletons', async (t) => {
  await setupCodexRun(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(codexSse(
    {
      type: 'response.output_item.added',
      item: {
        type: 'function_call',
        call_id: 'call-1',
        name: 'memory-get',
        arguments: '',
      },
    },
    {
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        call_id: 'call-1',
        name: 'memory-get',
        arguments: '{"memoryIds":["session:1"]}',
      },
    },
  ));
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await generateWithTools('observer', {
    messages: [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'user prompt' },
    ],
    tools: [{
      name: 'memory-get',
      description: 'Get memory details.',
      parameters: {
        type: 'object',
        properties: {
          memoryIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['memoryIds'],
      },
    }],
  });

  assert.deepEqual(result, {
    type: 'tool_calls',
    toolCalls: [{
      id: 'call-1',
      name: 'memory-get',
      arguments: { memoryIds: ['session:1'] },
    }],
  });
});

test('generateText normalizes Codex backend baseUrl and parses output fragments', async (t) => {
  await setupCodexRun(t, {
    config: makeConfig({
      model: 'gpt-5.4-mini',
      baseUrl: 'https://chatgpt.com/backend-api',
    }),
  });
  const originalFetch = globalThis.fetch;
  let capturedInput;
  globalThis.fetch = async (input) => {
    capturedInput = input;
    return new Response(codexSse({
      type: 'response.completed',
      response: {
        output: [
          { content: [{ type: 'output_text', text: 'first' }] },
          { content: [{ type: 'output_text', text: 'second' }] },
        ],
      },
    }));
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const output = await generateText('observer', {
    system: 'system prompt',
    prompt: 'user prompt',
  });

  assert.equal(capturedInput, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(output, 'first\n\nsecond');
});

test('generateText normalizes generic ChatGPT responses endpoint to Codex responses endpoint', async (t) => {
  await setupCodexRun(t, {
    config: makeConfig({
      baseUrl: 'https://chatgpt.com/backend-api/responses',
    }),
  });
  const originalFetch = globalThis.fetch;
  let capturedInput;
  globalThis.fetch = async (input) => {
    capturedInput = input;
    return new Response(codexSse({ type: 'response.output_text.delta', delta: 'Codex answer' }));
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await generateText('observer', {
    system: 'system prompt',
    prompt: 'user prompt',
  });

  assert.equal(capturedInput, 'https://chatgpt.com/backend-api/codex/responses');
});

test('generateText rejects non-ChatGPT Codex auth before request', async (t) => {
  await setupCodexRun(t, { authMode: 'api-key' });
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return Response.json({ output_text: 'unexpected' });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(
    () => generateText('observer', { system: 'system', prompt: 'prompt' }),
    /Codex CLI auth.*ChatGPT/i,
  );
  assert.equal(called, false);
});

test('generateText rejects missing Codex access token before request', async (t) => {
  await setupCodexRun(t, { accessToken: '' });
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return Response.json({ output_text: 'unexpected' });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(
    () => generateText('observer', { system: 'system', prompt: 'prompt' }),
    /Codex CLI auth.*access_token/i,
  );
  assert.equal(called, false);
});

test('generateText rejects Codex access tokens expiring within twenty four hours', async (t) => {
  await setupCodexRun(t, {
    accessToken: makeJwt(Math.floor(Date.now() / 1000) + 3600),
  });
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return Response.json({ output_text: 'unexpected' });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(
    () => generateText('observer', { system: 'system', prompt: 'prompt' }),
    /Codex CLI auth token expires within 24 hours/i,
  );
  assert.equal(called, false);
});

test('generateText rejects Codex access tokens without a parseable JWT expiry', async (t) => {
  await setupCodexRun(t, { accessToken: 'not-a-jwt' });
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return Response.json({ output_text: 'unexpected' });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(
    () => generateText('observer', { system: 'system', prompt: 'prompt' }),
    /Codex CLI auth token is not a JWT with an exp claim/i,
  );
  assert.equal(called, false);
});

test('generateText reports openai-codex HTTP errors with status and body', async (t) => {
  await setupCodexRun(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('not authorized', { status: 401 });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(
    () => generateText('observer', { system: 'system', prompt: 'prompt' }),
    /openai-codex request failed with status 401: not authorized/i,
  );
});

function codexSse(...events) {
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
}
