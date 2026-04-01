# LoCoMo Benchmark

This module adapts LoCoMo to run directly on top of Munnai.

The key design choice is that the benchmark does not reuse LoCoMo's original
LLM-driven retrieval and answer-generation path. Instead:

- LoCoMo data is imported into isolated Munnai homes
- recall is executed through `@munnai/core`
- answer generation is a deterministic heuristic baseline
- the output shape remains evaluator-compatible with LoCoMo-style QA results

## Module Layout

- `src/bridge.ts`
  - thin Node bridge into `@munnai/core`
  - imports LoCoMo samples into Munnai
  - runs single or batch recall
- `run.py`
  - benchmark entrypoint
  - coordinates import, recall, prediction, and score writing
- `dataset.py`
  - LoCoMo dataset loading and mode parsing
- `heuristics.py`
  - deterministic query builder and answer heuristics
- `scoring.py`
  - evaluator-compatible QA and retrieval scoring
- `test/`
  - Node bridge tests and smoke fixtures
- `tests/`
  - Python unit tests

## Supported Modes

This adapter currently supports the three LoCoMo retrieval views:

- `dialog`
  - each LoCoMo turn becomes one Munnai session row
  - retrieved context maps back to `D{session}:{turn}`
- `observation`
  - each extracted fact becomes one Munnai session row
  - fact rows still preserve the original `D...` source id
- `summary`
  - each LoCoMo session summary becomes one Munnai session row
  - retrieved context maps back to `S{session}`

## Prerequisites

Run everything from the repository root.

Required:

- `pnpm install`
- a working Rust toolchain, because the bridge opts into
  `MUNNAI_CORE_ALLOW_CARGO_FALLBACK=1` and starts the repo-local daemon through
  `cargo run`
- `python3`

No LLM keys are required for this benchmark.

## Build

Build the Node bridge once before running the benchmark:

```bash
pnpm --filter @munnai/benchmark-locomo build
```

You can also run the package test target, which rebuilds the bridge first:

```bash
pnpm --filter @munnai/benchmark-locomo test
```

The benchmark bridge explicitly enables `MUNNAI_CORE_ALLOW_CARGO_FALLBACK=1`, so
you do not need to export or install `munnai-core` separately when running from
this repository checkout.

## Run

### Full LoCoMo-style run

```bash
python3 benchmark/locomo/run.py \
  --data-file ../locomo/data/locomo10.json \
  --out-file benchmark/locomo/out/locomo10_results.json \
  --modes dialog,observation,summary \
  --top-k 5
```

### Single mode

```bash
python3 benchmark/locomo/run.py \
  --data-file ../locomo/data/locomo10.json \
  --out-file benchmark/locomo/out/locomo10_dialog_results.json \
  --modes dialog \
  --top-k 5
```

### Single sample

```bash
python3 benchmark/locomo/run.py \
  --data-file ../locomo/data/locomo10.json \
  --out-file benchmark/locomo/out/sample_1_dialog_results.json \
  --modes dialog \
  --sample-id <sample_id> \
  --top-k 5
```

### Limit the QA count for debugging

```bash
python3 benchmark/locomo/run.py \
  --data-file ../locomo/data/locomo10.json \
  --out-file benchmark/locomo/out/debug_results.json \
  --modes dialog \
  --limit-questions 20 \
  --top-k 5
```

## Runtime Behavior

For each `sample_id + mode` pair, the runner:

1. creates an isolated `MUNNAI_HOME`
2. imports LoCoMo source data into Munnai through the local bridge
3. builds deterministic query candidates from each question
4. runs batch recall through Munnai
5. maps retrieved rows back to LoCoMo source ids
6. generates a non-LLM heuristic answer
7. writes QA results and aggregate stats

This means the benchmark measures Munnai's current text recall behavior, not an
embedding retriever and not an LLM answerer.

## Output Files

The runner writes two files:

- `<out-file>`
  - per-sample QA results
  - includes `munnai_<mode>_top_<k>_prediction`
  - includes `munnai_<mode>_top_<k>_prediction_context`
- `<out-file stem>_stats.json`
  - aggregate F1 and retrieval recall
  - grouped by mode and category

Outputs are written under `benchmark/locomo/out/`, which is gitignored.

Temporary benchmark homes may also be written under `benchmark/locomo/.runs/`
when `--keep-home` is used.

## Current Limitations

- This is an evaluator-compatible baseline, not a parity answerer with the
  original LoCoMo LLM pipeline.
- Munnai recall is currently text-based, so the query builder and heuristic
  answer extraction matter a lot for benchmark quality.
- Original LoCoMo timestamps are preserved as benchmark metadata and text, not
  as first-class Munnai row timestamps.
- The runner is optimized to batch recall queries per mode, but full runs can
  still be slow compared with pure in-memory scoring.

## Tests

Python unit tests:

```bash
python3 -m unittest benchmark.locomo.tests.test_scoring
```

Node bridge tests:

```bash
pnpm --filter @munnai/benchmark-locomo test
```

## Implementation Notes

- The Python side talks to Munnai through `benchmark/common/munnai_bridge.py`
- The bridge itself talks directly to `@munnai/core`, not sidecar
- Benchmark metadata is stored in Munnai row artifacts so recall hits can be
  mapped back to LoCoMo source ids like `D1:3` or `S2`
