# Extractor Observer Queue Design

## Summary

Muninn should stop using extraction table deltas as the observer work-discovery mechanism. The current design lets the observer update `extraction.observationIds`, which changes the extraction table version. The observer then sees its own link update as fresh extraction work and can loop or block benchmark readiness.

The new design uses explicit checkpoint-backed work handoff:

```text
turns
-> extractor epoch
-> extractor.pendingExtractions
-> extraction table upsert
-> observer.observeQueue
-> observer drains anchor buckets
-> observation_context + observation
```

The reliability model is at-least-once plus idempotent processing. We do not try to make checkpoint writes transactional with Lance writes.

## Goals

- Prevent observer self-trigger loops caused by `extraction.observationIds` writes.
- Keep extractor and observer responsibilities separate.
- Make observer work discovery explicit and checkpoint-backed.
- Keep checkpoint flushing moderate; do not write checkpoint before every storage operation.
- Keep BTree id indexes enabled for now and treat Lance BTree failures as a separate observed risk.
- Make benchmark failures stop early on Muninn internal errors and write diagnostics.

## Non-Goals

- No exactly-once delivery guarantee.
- No Lance CDC before/after implementation.
- No disabling BTree id indexes in this change.
- No new third-party queue dependency.
- No support for non-Entity root curation in this MVP.

## Checkpoint Shape

Add extractor-side staging:

```ts
type ExtractorCheckpoint = {
  pendingExtractions: Extraction[];
  // existing extractor fields remain as needed
};
```

Add observer-side queue:

```ts
type ObserverCheckpoint = {
  observeQueue: {
    anchors: Array<{
      key: string;
      anchor: string;
      extractions: Extraction[];
    }>;
  };
  // observer.baseline.extraction is removed
};
```

`key` is the normalized anchor key. `anchor` preserves the display form from the first enqueue. `extractions` stores full extraction rows, including `observationIds`, so the observer queue is self-contained and can be restored without a second table lookup.

## Extraction Handoff

Extractor commit uses this sequence:

1. Generate extraction rows for the committed epoch.
2. Merge rows into `extractor.pendingExtractions` by `extraction.id`.
3. Upsert `pendingExtractions` into the extraction table.
4. Handoff successfully upserted rows into `observer.observeQueue`.
5. Clear `pendingExtractions` only after handoff succeeds.

Merge rules:

- New extraction id appends at the end.
- Existing extraction id replaces the stored row while preserving order.
- If a previous `pendingExtractions` value is replayed after restart, extraction upsert is idempotent.

Checkpoint persistence remains moderate:

- No mandatory checkpoint write before extraction upsert.
- Existing periodic checkpointing stays in place.
- `memoryFinalize()` forces checkpoint persistence before returning.

## Observer Queue

The observer queue is grouped by Entity anchor.

Enqueue rules:

- Only `Entity:` anchors create observer queue buckets.
- Extractions without Entity anchors do not enter observer queue.
- If an extraction has multiple Entity anchors, enqueue it into every corresponding bucket.
- Within a bucket, duplicate extraction ids replace the stored row with the latest row and keep the original position.
- If an extraction already exists in an old bucket and later changes Entity anchors, keep and update the old bucket entry so the old root document gets one final rewrite opportunity. Also enqueue the row into the new current buckets.

Drain rules:

- Default `observer.anchorThreshold = 8`.
- Default `observer.anchorBatchSize = 16`.
- Background observer runs only buckets with `extractions.length >= anchorThreshold`.
- Each run processes at most `anchorBatchSize` rows from one bucket.
- Success acks only the processed rows from that bucket.
- Failure leaves the batch in place for retry.
- `finalize` processes all non-empty buckets, including below-threshold buckets.
- Buckets are processed FIFO by first enqueue order; rows inside buckets keep enqueue order.

## Observation Links

`extraction.observationIds` remains for now, but it must be updated only when the set actually changes.

System behavior:

- The model does not see `observationIds` in the prompt.
- The observer system compares parsed leaf refs with existing `extraction.observationIds`.
- If the resulting link set is unchanged, do not upsert that extraction and do not refresh `updatedAt`.
- If the link set changes, upsert the extraction row with the new `observationIds`.

This keeps reverse links available without letting no-op link writes create table-version churn.

## Watermark And Finalize

`watermark` is status-only.

```ts
memoryWatermark(): MemoryWatermark
```

It must not trigger observer drain. Below-threshold queued work does not block `resolved`.

Recommended status fields:

- extractor pending/running state
- observer running state
- total observer queued extraction count
- ready observer bucket count
- ready observer extraction count

`finalize` is the barrier.

```ts
memoryFinalize(): MemoryWatermark
```

It must:

1. Finalize extractor work, including current open epoch.
2. Upsert any `pendingExtractions`.
3. Handoff all pending extractions into `observer.observeQueue`.
4. Drain all observer queue buckets, regardless of threshold.
5. Force checkpoint persistence.
6. Return resolved only when all work is complete.

Internal Muninn errors during finalize should fail immediately instead of being swallowed or retried indefinitely.

HTTP API:

```text
GET  /api/v1/memory/watermark
POST /api/v1/memory/finalize
```

LoCoMo benchmark should call `POST /api/v1/memory/finalize` before QA. It should not rely on watermark to perform hidden finalize work.

## Prompt Changes

No prompt changes are required for this design. Idempotency is handled by system-level queue deduplication, stable row ids, upsert semantics, and observation link diffing.

Do not add special prompt language for Entity anchor changes. The system will pass queued rows to the appropriate root document, and the model should follow the existing rewrite rules.

## Benchmark Runner Diagnostics

`run_muninn_eval.py` should classify errors into internal fatal and transient external.

Internal Muninn fatal errors stop the benchmark immediately and write:

```text
benchmark/locomo/out/<run-name>.diagnostic.json
```

Internal fatal examples:

- `observer run failed`
- `extractor run failed`
- `Ambiguous merge inserts`
- `RowAddrTreeMap::from_sorted_iter`
- Lance write, merge, or index errors
- schema, parser, validator, or tool contract errors

Transient external examples should not immediately stop the run:

- `fetch failed`
- `ECONNRESET`
- `ETIMEDOUT`
- provider rate limits
- temporary LLM or embedding network failures

Diagnostic JSON should include:

- fatal pattern
- phase/sample/question when known
- stdout/stderr tail
- progress file tail
- watchdog tail
- checkpoint snapshot
- observer trace tail
- extractor trace tail
- run home path
- coarse category: `observer`, `extractor`, `lance-index`, `lance-merge-upsert`, `provider-tool`, or `unknown`

## Lance BTree Index Risk

Keep BTree id indexes enabled in this design. If `RowAddrTreeMap::from_sorted_iter called with non-sorted input` recurs, the runner should stop immediately and classify it as a Lance BTree index risk. Investigation and possible disablement should be handled separately.

## Testing

Core tests:

- `pendingExtractions` merges duplicate ids by replacing rows.
- pending rows are upserted before observer queue handoff.
- pending rows clear only after successful handoff.
- observer queue groups rows by Entity anchor.
- duplicate queue ids replace rows and preserve position.
- multiple Entity anchors enqueue into multiple buckets.
- no Entity anchors do not enqueue.
- old buckets keep updated rows when an extraction changes anchors.
- background observer only drains ready buckets.
- finalize drains all buckets.
- observer success acks only processed rows.
- observer failure does not ack.
- unchanged `observationIds` does not upsert extraction.
- changed `observationIds` upserts extraction.
- `memoryWatermark()` does not call observer finalize.
- `memoryFinalize()` drains extractor and observer work and persists checkpoint.

Benchmark tests:

- LoCoMo bridge uses `/api/v1/memory/finalize` before QA.
- `run_muninn_eval.py` stops immediately on internal Muninn fatal errors.
- transient provider errors do not trigger immediate fatal diagnostic.
- diagnostic JSON includes the expected paths and tails.

Sanity run:

- Run the three-small LoCoMo target with `budget=0`, `topK=8`, `hybrid`.
- Verify QA starts after finalize.
- Verify no observer self-trigger loop.
- Verify no repeated extraction link-only churn.

## Open Risks

- Because checkpoint writes are not transactional with extraction upserts, a hard crash in a narrow window can still cause at-least-once replay or missed observer handoff. This is accepted for MVP.
- Keeping BTree id indexes may still trigger the Lance BTree issue. The runner diagnostic should make this visible quickly.
- Storing full extraction rows in observer queue increases checkpoint size. `anchorBatchSize` controls prompt input size, not checkpoint size.
