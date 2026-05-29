import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { generateWithTools } from '../dist/llm/provider.js';

test('generateWithTools sends OpenAI-compatible tools and parses tool calls', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);
  const originalFetch = globalThis.fetch;
  let capturedBody;
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            tool_calls: [{
              id: 'call-1',
              type: 'function',
              function: {
                name: 'memory-get',
                arguments: '{"memoryIds":["extraction:1"]}',
              },
            }],
          },
        }],
      }),
    };
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    delete process.env.MUNINN_HOME;
    await rm(dir, { recursive: true, force: true });
  });

  const result = await generateWithTools('observer', {
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'prompt' },
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

  assert.equal(capturedBody.tools[0].type, 'function');
  assert.equal(capturedBody.tools[0].function.name, 'memory-get');
  assert.deepEqual(result, {
    type: 'tool_calls',
    toolCalls: [{
      id: 'call-1',
      name: 'memory-get',
      arguments: { memoryIds: ['extraction:1'] },
    }],
  });
});

test('generateWithTools sends tool result messages and parses final text', async (t) => {
  const { dir, homeDir, configPath } = await makeConfigHome();
  process.env.MUNINN_HOME = homeDir;
  await writeObserverConfig(configPath);
  const originalFetch = globalThis.fetch;
  let capturedBody;
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
              content: '{"sessionFragments":[]}',
          },
        }],
      }),
    };
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    delete process.env.MUNINN_HOME;
    await rm(dir, { recursive: true, force: true });
  });

  const result = await generateWithTools('observer', {
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'prompt' },
      {
        role: 'assistant',
        toolCalls: [{ id: 'call-1', name: 'memory-get', arguments: { memoryIds: ['extraction:1'] } }],
      },
      {
        role: 'tool',
        toolCallId: 'call-1',
        name: 'memory-get',
        content: '{"memories":[]}',
      },
    ],
    tools: [{
      name: 'memory-get',
      description: 'Get memory details.',
      parameters: { type: 'object', properties: {} },
    }],
  });

  assert.equal(capturedBody.messages[2].role, 'assistant');
  assert.equal(capturedBody.messages[2].tool_calls[0].id, 'call-1');
  assert.equal(capturedBody.messages[3].role, 'tool');
  assert.equal(capturedBody.messages[3].tool_call_id, 'call-1');
  assert.deepEqual(result, {
    type: 'final',
    text: '{"sessionFragments":[]}',
  });
});

async function makeConfigHome() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'muninn-provider-tools-'));
  return {
    dir,
    homeDir: path.join(dir, 'muninn'),
    configPath: path.join(dir, 'muninn', 'muninn.json'),
  };
}

async function writeObserverConfig(configPath) {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({
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
      activeWindowDays: 3650,
    },
    llm: {
      extractor_llm: {
        provider: 'openai',
        api: 'openai-completions',
        apiKey: 'test-key',
        baseUrl: 'https://example.test/api',
      },
      observer_llm: {
        provider: 'openai',
        api: 'openai-completions',
        apiKey: 'test-key',
        baseUrl: 'https://example.test/api',
      },
    },
    extraction: {
      embedding: {
        provider: 'mock',
        dimensions: 4,
      },
      defaultImportance: 0.7,
    },
  }, null, 2)}\n`, 'utf8');
}
