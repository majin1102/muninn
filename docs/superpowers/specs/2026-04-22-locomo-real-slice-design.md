# LoCoMo Real Slice Benchmark Design

## Goal

Produce a small, real-quality LoCoMo benchmark run that includes the full path:

- ingest a real LoCoMo conversation slice into an isolated Muninn home
- run real Muninn observer and real embedding/indexing from the active `muninn.json`
- recall memories for selected QA questions
- generate benchmark predictions with the existing LoCoMo heuristic QA layer
- write per-question results, aggregate stats, report, and progress logs

The first target slice is `conv-26` session 1. This keeps runtime and provider cost bounded while still using real LoCoMo data and the real Muninn memory pipeline.

## Scope

This design covers one benchmark slice workflow only. It does not change Muninn's product write path, OpenClaw integration, or the core observer architecture.

The slice must be generated from the downloaded LoCoMo dataset rather than hand-written. The generated slice should be treated as an experiment artifact, not a checked-in source fixture.

## Data Selection

Input dataset:

- `benchmark/locomo/.cache/data/locomo10.json`

Slice parameters:

- `sample_id = conv-26`
- `max_session = 1`

Included conversation data:

- `speaker_a`
- `speaker_b`
- `session_1_date_time`
- `session_1`
- `observation.session_1_observation` when present
- `session_summary.session_1_summary` when present

Included QA:

- keep only QA rows whose `evidence` list is non-empty
- every evidence id must exist in the retained dialog ids
- for this first slice, valid evidence ids are `D1:*`

For the current `conv-26` data, this yields 18 dialog turns and 4 QA rows.

## Components

### Slice Tool

Add a small LoCoMo-specific slicer under `benchmark/locomo`.

Responsibilities:

- load the source LoCoMo JSON
- select one sample by `sample_id`
- retain sessions up to `max_session`
- filter QA rows by evidence containment
- validate that every retained QA evidence id exists in the retained dialogs
- write a single-sample JSON file
- print a compact summary: sample id, retained sessions, turn count, QA count, category counts, and output path

The slicer should fail fast if:

- the source file is missing
- the sample id is not found
- no QA rows remain after filtering
- a retained QA references evidence outside the retained dialogs

### Existing Runner

Keep `benchmark/locomo/run.py` as the benchmark execution entrypoint.

The runner should not learn the slice rules. It should simply consume the generated one-sample JSON file with the existing options:

- `--data-file <slice-file>`
- `--out-file benchmark/locomo/out/<run-name>.json`
- `--progress-file benchmark/locomo/out/<run-name>.progress.jsonl`
- `--top-k 5`

### Active Muninn Config

The real run uses the active `muninn.json` through `MUNINN_HOME`.

For the local workflow, `MUNINN_HOME=/Users/Nathan/workspace/muninn` points at the untracked local config. The benchmark home remains isolated; the bridge copies runtime config into the temporary benchmark home while removing storage settings.

## Data Flow

1. Fetch or reuse `locomo10.json`.
2. Generate `conv-26-session-1` slice from the real dataset.
3. Run the existing LoCoMo runner against the generated slice.
4. Runner creates an isolated `MUNINN_HOME`.
5. Bridge imports each retained dialog as one Muninn turn.
6. Bridge waits for observer watermark to resolve.
7. Runner builds query candidates for each retained QA.
8. Bridge recalls memories for each query candidate.
9. Runner merges hits, builds heuristic predictions, and scores F1 plus hidden evidence recall.
10. Runner writes result JSON, stats JSON, report JSON, and progress JSONL.

## Output

Expected files:

- `benchmark/locomo/out/conv-26-session-1.real.json`
- `benchmark/locomo/out/conv-26-session-1.real_stats.json`
- `benchmark/locomo/out/conv-26-session-1.real_report.json`
- `benchmark/locomo/out/conv-26-session-1.real.progress.jsonl`

The main result file should include, for each QA:

- question
- answer
- evidence
- category
- `muninn_top_5_prediction`
- `muninn_top_5_prediction_context`

The stats file should include:

- `qa_count`
- `average_f1`
- `average_recall`
- `category_f1`
- `category_recall`

## Error Handling

The slice tool should report invalid source data before the benchmark run starts.

The runner should preserve existing behavior:

- emit progress events for each phase
- fail the run if import, watermark, recall, prediction, or output writing fails
- include phase name, elapsed time, sample id, and error text in progress output

Watermark waiting should warn when pending turns remain after the warning delay, even if observer epoch state has changed.

## Testing

Add unit coverage for the slicer:

- generating `conv-26` session 1 keeps only evidence-contained QA
- generated QA evidence ids all exist in retained dialogs
- missing sample id fails clearly
- zero retained QA fails clearly

Keep the existing LoCoMo package tests passing:

- `pnpm --filter @muninn/benchmark-locomo test`

Manual validation for the first real run:

- generate the slice
- run the benchmark with the real local `muninn.json`
- inspect stats and report
- confirm progress logs include import, watermark, recall, prediction, and output phases

## Non-Goals

- Do not implement batch observer ingestion in this slice task.
- Do not optimize full `locomo10` runtime yet.
- Do not add OpenClaw or LanceDB baseline comparison yet.
- Do not commit local provider credentials or generated benchmark outputs.
