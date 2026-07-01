import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { buildProjectDreamPrompt, mergeProjectDream } from '../../dist/dreaming/project-dreamer.js';

test('buildProjectDreamPrompt renders existing rows and incremental evidence labels', () => {
  const prompt = buildProjectDreamPrompt({
    project: '/repo/muninn',
    existingProjectSignals: [
      '[signal:101]',
      '## Instruction Signal',
      'Prefer minimal prompt changes.',
    ].join('\n'),
    incrementalSessionSignals: [
      '[turn:256 +1]',
      '## Instruction Signal',
      'Prefer subtractive prompt changes.',
    ].join('\n'),
  });

  assert.match(prompt, /## Existing Project Signals/);
  assert.match(prompt, /\[signal:101\]/);
  assert.match(prompt, /Prefer minimal prompt changes/);
  assert.match(prompt, /## Incremental Session Signals/);
  assert.match(prompt, /\[turn:256 \+1\]/);
  assert.match(prompt, /Prefer subtractive prompt changes/);
  assert.doesNotMatch(prompt, /get_skill|Parent Dream|session:<rowid>/);
});

test('mergeProjectDream validates and retries labeled signal output without tools', async (t) => {
  await withTempMuninnHome(t, {
    providers: {
      llm: { dreamer: { type: 'openai', apiKey: 'test-key' } },
      embedding: { mock: { type: 'mock', dimensions: 8 } },
    },
  });
  const prompts = [];
  const result = await mergeProjectDream({
    project: '/repo/muninn',
    existingProjectSignals: '',
    incrementalSessionSignals: [
      '[turn:256 +1]',
      '## Instruction Signal',
      'Prefer subtractive prompt changes.',
    ].join('\n'),
    labels: {
      turnLabels: ['turn:256 +1'],
    },
    model: async (task, request) => {
      assert.equal(task, 'extractor');
      assert.deepEqual(request.tools, []);
      prompts.push(lastUserMessage(request.messages));
      return prompts.length === 1
        ? { type: 'final', text: '# Project Dream: /repo/muninn' }
        : {
          type: 'final',
          text: [
            '```markdown',
            '# Project Signals',
            '',
            '[turn:256 +1]',
            '## Instruction Signal',
            'Prefer subtractive prompt changes.',
            '```',
          ].join('\n'),
        };
    },
  });

  assert.match(result, /# Project Signals/);
  assert.match(result, /\[turn:256 \+1\]/);
  assert.doesNotMatch(result, /```/);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Previous output was invalid\. Validation error: project dreamer output must start with # Project Signals/);
});

test('mergeProjectDream filters unknown labels through validation', async (t) => {
  await withTempMuninnHome(t, {
    providers: {
      llm: { dreamer: { type: 'openai', apiKey: 'test-key' } },
      embedding: { mock: { type: 'mock', dimensions: 8 } },
    },
  });
  const result = await mergeProjectDream({
    project: '/repo/muninn',
    existingProjectSignals: '[signal:101]\n## Instruction Signal\nExisting.',
    incrementalSessionSignals: '[turn:300 +10]\n## Instruction Signal\nPinned.',
    labels: {
      signalLabels: ['signal:101'],
      turnLabels: ['turn:300 +10'],
    },
    model: async () => ({
      type: 'final',
      text: [
        '# Project Signals',
        '',
        '[signal:101, signal:999, turn:300 +10]',
        '## Instruction Signal',
        'Pinned.',
      ].join('\n'),
    }),
  });

  assert.match(result, /\[signal:101, signal:999, turn:300 \+10\]/);
});

test('mergeProjectDream mock provider returns project signal set', async (t) => {
  await withTempMuninnHome(t, {
    providers: {
      llm: { dreamer: { type: 'mock' } },
      embedding: { mock: { type: 'mock', dimensions: 8 } },
    },
  });
  const result = await mergeProjectDream({
    project: '/repo/muninn',
    existingProjectSignals: [
      '[signal:101]',
      '## Instruction Signal',
      'Existing.',
    ].join('\n'),
    incrementalSessionSignals: [
      '[turn:256 +1]',
      '## Skill Signal',
      '### 记忆清库验证',
      '',
      'Validate memory prompt changes with a clean rerun.',
    ].join('\n'),
    labels: {
      signalLabels: ['signal:101'],
      turnLabels: ['turn:256 +1'],
    },
  });

  assert.match(result, /^# Project Signals/);
  assert.match(result, /\[signal:101\]/);
  assert.match(result, /\[turn:256 \+1\]/);
  assert.match(result, /### 记忆清库验证/);
});

function lastUserMessage(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'user') {
      return message.content;
    }
  }
  return '';
}

async function withTempMuninnHome(t, config) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muninn-project-dreamer-'));
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'muninn.json'), JSON.stringify({
    extractor: {
      name: 'locomo-extractor',
      maxAttempts: 2,
      llmProvider: 'dreamer',
      embeddingProvider: 'mock',
      minEpochTurns: 8,
      maxEpochTurns: 32,
    },
    providers: config.providers,
  }, null, 2));
  const previous = process.env.MUNINN_HOME;
  process.env.MUNINN_HOME = root;
  t.after(async () => {
    if (previous === undefined) {
      delete process.env.MUNINN_HOME;
    } else {
      process.env.MUNINN_HOME = previous;
    }
    await rm(root, { recursive: true, force: true });
  });
}
