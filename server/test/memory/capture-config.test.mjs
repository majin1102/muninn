import test from 'node:test';
import assert from 'node:assert/strict';

import {
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
    providers: {
      llm: {
        extractor_llm: { type: 'mock' },
      },
      embedding: {
        default: { type: 'mock', dimensions: 8 },
      },
    },
  };
}

test('muninn config rejects embedded capture config', () => {
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

  assert.throws(
    () => validateMuninnConfigInput(JSON.stringify(config)),
    /capture is no longer supported in muninn\.json/i,
  );
});

test('canonical project identity accepts GitHub remotes and absolute paths', () => {
  assert.equal(isCanonicalProjectIdentity('github.com/majin1102/muninn'), true);
  assert.equal(isCanonicalProjectIdentity('/Users/Nathan/workspace/muninn'), true);
  assert.equal(isCanonicalProjectIdentity('amoro'), false);
});
