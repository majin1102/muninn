import test from 'node:test';
import assert from 'node:assert/strict';

import { parseObserverDocument } from '../dist/observer/markdown.js';

test('observer document parser derives observing paths and extraction-linked refs', () => {
  const parsed = parseObserverDocument(`# Caroline

## Plans
### Summer plans
Caroline compared adoption options and narrowed the plan around inclusive agency support.

- [ext-1] Caroline researched adoption agencies for her summer plans.
- [ext-2] Caroline followed up on agency support and inclusivity.
`, new Set(['ext-1', 'ext-2']));

  const leaf = parsed.sections[0].children[0];
  assert.equal(parsed.title, 'Caroline');
  assert.equal(parsed.sections[0].observingPath, 'Caroline / Plans');
  assert.equal(leaf.observingPath, 'Caroline / Plans / Summer plans');
  assert.deepEqual(leaf.sourceRefs, ['ext-1', 'ext-2']);
  assert.deepEqual(leaf.expandRefs, []);
  assert.match(leaf.body, /Caroline compared adoption options/);
  assert.match(leaf.body, /- \[ext-1\] Caroline researched adoption agencies/);
  assert.equal(leaf.rewritten, true);
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
Caroline tracked the adoption agency plan.

- [8ef63e6640c91a206097e95b4] Caroline researched adoption agencies for her summer plans.
`, new Set([validRef]));

  assert.deepEqual(parsed.sections[0].sourceRefs, [validRef]);
});

test('observer document parser rejects extraction-linked bullets on non-leaf sections', () => {
  assert.throws(() => parseObserverDocument(`# Caroline

## Plans
Parent body.

- [ext-1] Caroline researched adoption agencies.
### Summer plans
Caroline researched adoption agencies.

- [ext-1] Caroline researched adoption agencies for her summer plans.
`, new Set(['ext-1'])), /non-leaf observer section cannot declare refs/i);
});

test('observer document parser rejects leaf sections without extraction-linked bullets', () => {
  assert.throws(() => parseObserverDocument(`# Caroline

## Plans
Caroline researched adoption agencies.
`, new Set(['ext-1'])), /leaf observer section must include extraction-linked bullets/i);
});

test('observer document parser rejects legacy Source extractions blocks', () => {
  assert.throws(() => parseObserverDocument(`# Caroline

## Plans
Caroline researched adoption agencies.

Source extractions:
- [ext-1] adoption agency summer plan research
`, new Set(['ext-1'])), /not Source extractions/i);
});

test('observer document parser rejects multi-id and empty extraction-linked bullets', () => {
  assert.throws(() => parseObserverDocument(`# Caroline

## Plans
Caroline researched adoption agencies.

- [ext-1, ext-2] Caroline compared adoption agency options.
`, new Set(['ext-1', 'ext-2'])), /exactly one extraction id/i);

  assert.throws(() => parseObserverDocument(`# Caroline

## Plans
Caroline researched adoption agencies.

- [ext-1]
`, new Set(['ext-1'])), /must include rewritten remembered content/i);
});

test('observer document parser accepts leaf sections without ids', () => {
  const parsed = parseObserverDocument(`# Caroline

## Plans
Caroline researched adoption agencies.

- [ext-1] Caroline researched adoption agencies for her summer plans.
`, new Set(['ext-1']));

  assert.equal(parsed.sections[0].observingPath, 'Caroline / Plans');
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

## Old plan <!-- refs: \[ext-1\] -->
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

- [ext-1] Caroline has known her long-term friends for years.
`, new Set(['ext-1']));

  assert.equal(parsed.sections[0].children[0].children[0].level, 4);
  assert.equal(
    parsed.sections[0].children[0].children[0].observingPath,
    'Caroline / Support / Friends / Long-term friends',
  );

  assert.throws(() => parseObserverDocument(`# Caroline

## Support / friends
Caroline has support.

- [ext-1] Caroline has support from friends.
`, new Set(['ext-1'])), /observer section heading cannot contain/i);
});

test('observer document parser rejects slash root titles', () => {
  assert.throws(() => parseObserverDocument(`# AC/DC

## Preferences
AC/DC prefers concise notes.

- [ext-1] AC/DC prefers concise notes.
`, new Set(['ext-1'])), /observer document title cannot contain/i);
});

test('observer document parser rejects duplicate observing paths', () => {
  assert.throws(() => parseObserverDocument(`# Caroline

## Support
### Friends
Caroline has friends.

- [ext-1] Caroline has friends.
### Friends
Caroline has other friends.

- [ext-2] Caroline has other friends.
`, new Set(['ext-1', 'ext-2'])), /duplicate observer section path/i);
});
