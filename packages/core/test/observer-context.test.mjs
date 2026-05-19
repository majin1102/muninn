import test from 'node:test';
import assert from 'node:assert/strict';

import { parseObserverDocument } from '../dist/observer/markdown.js';

const ID = '11111111-1111-4111-8111-111111111111';

test('observer document parser reads section ids and leaf refs', () => {
  const parsed = parseObserverDocument(`# Caroline

## Plans <!-- id: ${ID} -->
### Summer plans <!-- refs: [ext-1, ext-2] -->
Caroline researched adoption agencies.
`, new Set(['ext-1', 'ext-2']));

  assert.equal(parsed.title, 'Caroline');
  assert.equal(parsed.sections[0].id, ID);
  assert.deepEqual(parsed.sections[0].children[0].refs, ['ext-1', 'ext-2']);
  assert.equal(parsed.sections[0].children[0].body, 'Caroline researched adoption agencies.');
});

test('observer document parser normalizes a unique near-match extraction ref typo', () => {
  const validRef = '8ef63e6640c91a206097e95a';
  const parsed = parseObserverDocument(`# Caroline

## Plans <!-- id: ${ID} -->
### Summer plans <!-- refs: [8ef63e6640c91a206097e95b4] -->
Caroline researched adoption agencies.
`, new Set([validRef]));

  assert.deepEqual(parsed.sections[0].children[0].refs, [validRef]);
});

test('observer document parser rejects refs on non-leaf sections', () => {
  assert.throws(() => parseObserverDocument(`# Caroline

## Plans <!-- refs: [ext-1] -->
### Summer plans <!-- refs: [ext-1] -->
Caroline researched adoption agencies.
`, new Set(['ext-1'])), /non-leaf observer section cannot declare refs/i);
});

test('observer document parser rejects leaf sections without refs', () => {
  assert.throws(() => parseObserverDocument(`# Caroline

## Plans
Caroline researched adoption agencies.
`, new Set(['ext-1'])), /leaf observer section must declare refs/i);
});

test('observer document parser accepts new leaf sections without ids', () => {
  const parsed = parseObserverDocument(`# Caroline

## Plans <!-- refs: [ext-1] -->
Caroline researched adoption agencies.
`, new Set(['ext-1']));

  assert.equal(parsed.sections[0].id, undefined);
  assert.deepEqual(parsed.sections[0].refs, ['ext-1']);
});

test('observer document parser rejects delete sections without ids', () => {
  assert.throws(() => parseObserverDocument(`# Caroline

## Old plan <!-- delete: true -->
`, new Set(['ext-1'])), /delete section must preserve an existing id/i);
});
