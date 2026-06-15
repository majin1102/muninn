import test from 'node:test';
import assert from 'node:assert/strict';

import { parseObserverDocument } from '../../dist/memory/observer/markdown.js';

test('observer document parser derives observing paths and leaf source refs', () => {
  const parsed = parseObserverDocument(`# Caroline

## Plans
### Summer plans
Caroline researched adoption agencies.

Source extractions:
- [ext-1, ext-2] Caroline researched adoption agencies.
`, new Set(['ext-1', 'ext-2']));

  assert.equal(parsed.title, 'Caroline');
  assert.equal(parsed.sections[0].path, 'Caroline / Plans');
  assert.equal(parsed.sections[0].children[0].path, 'Caroline / Plans / Summer plans');
  assert.deepEqual(parsed.sections[0].children[0].sourceRefs, ['ext-1', 'ext-2']);
  assert.deepEqual(parsed.sections[0].children[0].expandRefs, []);
  assert.match(parsed.sections[0].children[0].body, /Caroline researched adoption agencies/);
  assert.match(parsed.sections[0].children[0].body, /Source extractions:/);
  assert.equal(parsed.sections[0].children[0].rewritten, true);
});

test('observer document parser accepts placeholder source refs as expandable refs', () => {
  const parsed = parseObserverDocument(`# Caroline

## Plans
### Summer plans
Caroline researched adoption agencies.

Source extractions:
- [ext-1]
`, new Set(['ext-1']));

  assert.deepEqual(parsed.sections[0].children[0].sourceRefs, ['ext-1']);
  assert.deepEqual(parsed.sections[0].children[0].expandRefs, ['ext-1']);
});

test('observer document parser accepts heading-only keep markers', () => {
  const parsed = parseObserverDocument(`# Caroline

## Support
### Family
`, new Set(['ext-1']));

  assert.equal(parsed.sections[0].rewritten, false);
  assert.equal(parsed.sections[0].children[0].rewritten, false);
  assert.deepEqual(parsed.sections[0].children[0].sourceRefs, []);
  assert.deepEqual(parsed.sections[0].children[0].expandRefs, []);
});

test('observer document parser normalizes a unique near-match extraction ref typo', () => {
  const validRef = '8ef63e6640c91a206097e95a';
  const parsed = parseObserverDocument(`# Caroline

## Plans
### Summer plans
Caroline researched adoption agencies.

Source extractions:
- [8ef63e6640c91a206097e95b4]
`, new Set([validRef]));

  assert.deepEqual(parsed.sections[0].children[0].sourceRefs, [validRef]);
});

test('observer document parser rejects source refs on non-leaf sections', () => {
  assert.throws(() => parseObserverDocument(`# Caroline

## Plans
Parent body.

Source extractions:
- [ext-1]
### Summer plans
Caroline researched adoption agencies.

Source extractions:
- [ext-1]
`, new Set(['ext-1'])), /non-leaf observer section cannot declare refs/i);
});

test('observer document parser rejects leaf sections without source extractions', () => {
  assert.throws(() => parseObserverDocument(`# Caroline

## Plans
Caroline researched adoption agencies.
`, new Set(['ext-1'])), /leaf observer section must include Source extractions/i);
});

test('observer document parser rejects source extractions without observation body', () => {
  assert.throws(() => parseObserverDocument(`# Caroline

## Plans
Source extractions:
- [ext-1]
`, new Set(['ext-1'])), /rewritten leaf observer section cannot be empty/i);
});

test('observer document parser accepts leaf sections without ids', () => {
  const parsed = parseObserverDocument(`# Caroline

## Plans
Caroline researched adoption agencies.

Source extractions:
- [ext-1]
`, new Set(['ext-1']));

  assert.equal(parsed.sections[0].path, 'Caroline / Plans');
  assert.deepEqual(parsed.sections[0].sourceRefs, ['ext-1']);
});

test('observer document parser rejects id, delete, refs, and path hints', () => {
  assert.throws(() => parseObserverDocument(`# Caroline

## Old plan <!-- id: 11111111-1111-4111-8111-111111111111 -->
Old plan.
`, new Set(['ext-1'])), /unknown observer heading hint: id/i);

  assert.throws(() => parseObserverDocument(`# Caroline

## Old plan <!-- delete: true -->
Old plan.
`, new Set(['ext-1'])), /unknown observer heading hint: delete/i);

  assert.throws(() => parseObserverDocument(`# Caroline

## Old plan <!-- refs: [ext-1] -->
Old plan.
`, new Set(['ext-1'])), /unknown observer heading hint: refs/i);

  assert.throws(() => parseObserverDocument(`# Caroline

## Old plan <!-- path: Caroline / Old plan -->
Old plan.
`, new Set(['ext-1'])), /unknown observer heading hint: path/i);
});

test('observer document parser supports four heading levels and rejects slash headings', () => {
  const parsed = parseObserverDocument(`# Caroline

## Support
### Friends
#### Long-term friends
Caroline has known her friends for years.

Source extractions:
- [ext-1]
`, new Set(['ext-1']));

  assert.equal(parsed.sections[0].children[0].children[0].level, 4);
  assert.equal(
    parsed.sections[0].children[0].children[0].path,
    'Caroline / Support / Friends / Long-term friends',
  );

  assert.throws(() => parseObserverDocument(`# Caroline

## Support / friends
Caroline has support.

Source extractions:
- [ext-1]
`, new Set(['ext-1'])), /observer section heading cannot contain/i);
});

test('observer document parser accepts cwd-like slash root titles', () => {
  const parsed = parseObserverDocument(`# /workspace/AC/DC

## Preferences
AC/DC prefers concise notes.

Source extractions:
- [ext-1]
`, new Set(['ext-1']));

  assert.equal(parsed.title, '/workspace/AC/DC');
  assert.equal(parsed.sections[0].path, '/workspace/AC/DC / Preferences');
});

test('observer document parser rejects duplicate observing paths', () => {
  assert.throws(() => parseObserverDocument(`# Caroline

## Support
### Friends
Caroline has friends.

Source extractions:
- [ext-1]
### Friends
Caroline has other friends.

Source extractions:
- [ext-2]
`, new Set(['ext-1', 'ext-2'])), /duplicate observer section path/i);
});

test('observer document parser rejects rewritten single source extraction bullets', () => {
  assert.throws(() => parseObserverDocument(`# Caroline

## Plans
Caroline researched adoption agencies.

Source extractions:
- [ext-1] Caroline researched adoption agencies.
`, new Set(['ext-1'])), /single Source extraction bullets must not rewrite source content/i);
});
