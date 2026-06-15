import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getCaptureConfigFromConfigForTests,
  isCanonicalProjectIdentity,
  validateMuninnConfigInput,
} from '../../dist/config.js';

function makeConfig() {
  return {
    extractor: {
      name: 'test-extractor',
      llmProvider: 'extractor_llm',
      embeddingProvider: 'default',
    },
    observer: {
      name: 'test-observer',
      llmProvider: 'observer_llm',
    },
    providers: {
      llm: {
        extractor_llm: { type: 'mock' },
        observer_llm: { type: 'mock' },
      },
      embedding: {
        default: { type: 'mock', dimensions: 8 },
      },
    },
  };
}

test('capture config accepts canonical project identities', () => {
  const config = makeConfig();
  config.capture = {
    agents: {
      codex: true,
      'claude-code': false,
    },
    projects: {
      codex: {
        'github.com/lance-format/lance': true,
        '/Users/Nathan/workspace/muninn': false,
      },
    },
  };

  assert.doesNotThrow(() => validateMuninnConfigInput(JSON.stringify(config)));
  assert.deepEqual(getCaptureConfigFromConfigForTests(config), config.capture);
});

test('capture config rejects non-canonical project keys', () => {
  const config = makeConfig();
  config.capture = {
    projects: {
      codex: {
        amoro: true,
      },
    },
  };

  assert.throws(
    () => validateMuninnConfigInput(JSON.stringify(config)),
    /capture\.projects\.codex\.amoro must be a canonical project identity/i,
  );
});

test('capture config defaults agents on and projects off', () => {
  assert.deepEqual(getCaptureConfigFromConfigForTests(makeConfig()), {
    agents: {},
    projects: {},
  });
  assert.equal(isCanonicalProjectIdentity('github.com/majin1102/muninn'), true);
  assert.equal(isCanonicalProjectIdentity('/Users/Nathan/workspace/muninn'), true);
  assert.equal(isCanonicalProjectIdentity('amoro'), false);
});
