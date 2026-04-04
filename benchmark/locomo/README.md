# LoCoMo Benchmark

This module adapts LoCoMo to run directly on top of Muninn.

The benchmark does not reuse LoCoMo's original LLM-driven retrieval and
answer-generation path. Instead:

- LoCoMo data is imported into isolated Muninn homes
- recall is executed through `@muninn/core`
- answer generation is a deterministic heuristic baseline
- the output shape remains evaluator-compatible with LoCoMo-style QA results

## Module Layout

- `src/bridge.ts`
  - thin Node bridge into `@muninn/core`
  - imports LoCoMo samples into Muninn
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
- `scripts/`
  - benchmark bootstrap, test, and run wrappers
- `test/`
  - Node bridge tests and smoke fixtures
- `tests/`
  - Python unit tests

## Supported Modes

This adapter currently supports the three LoCoMo retrieval views:

- `dialog`
  - each LoCoMo turn becomes one Muninn session row
  - retrieved context maps back to `D{session}:{turn}`
- `observation`
  - each extracted fact becomes one Muninn session row
  - fact rows still preserve the original `D...` source id
- `summary`
  - each LoCoMo session summary becomes one Muninn session row
  - retrieved context maps back to `S{session}`

## Supported Pipelines

The runner supports two benchmark baselines:

- `oracle`
  - imports LoCoMo gold dialog / observation / summary rows directly
  - acts as an upper bound for adapter correctness and retrieval quality
- `generated`
  - imports raw dialog only
  - relies on Muninn's own turn summary / observer path for generated layers
  - is the main end-to-end benchmark result

## Prerequisites

Run everything from the repository root or through the wrapper scripts in this
package.

Required:

- `pnpm install`
- a working Rust toolchain, because `@muninn/core` exports the Rust daemon
- `python3`
- a shell that can source `~/.zshrc`

The wrapper scripts source `~/.zshrc` before invoking `node`, `pnpm`, or
`python3`, so PATH fixes that live in your shell config are available to the
benchmark subprocesses.

No LLM keys are required for this benchmark.

## Data Files

This repository no longer vendors the full LoCoMo benchmark payload in Git.
Instead, the benchmark downloads a pinned copy on demand into the local cache
directory `benchmark/locomo/.cache/data/`.

- Pinned source repository: <https://github.com/majin1102/locomo>
- Pinned source commit: `3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376`
- Default cached benchmark file: `benchmark/locomo/.cache/data/locomo10.json`
- License note: upstream LoCoMo data is distributed under `CC BY-NC 4.0`
- Attribution and a local license copy remain in
  `benchmark/locomo/data/README.md` and `benchmark/locomo/data/LOCOMO_LICENSE.txt`

The download script fetches from the pinned fork commit above and also verifies
SHA256 checksums for the expected data files, so benchmark runs stay pinned to
a known LoCoMo snapshot even though the payload is fetched from GitHub.

If you reuse or redistribute the downloaded files, review the upstream
non-commercial license terms first.

## One-Shot Commands

The recommended entrypoints are the wrapper scripts under `benchmark/locomo/scripts/`.
They handle shell setup, bridge rebuilds, and daemon export for you.

### Bootstrap

Build the Rust daemon and compile the bridge:

```bash
sh benchmark/locomo/scripts/bootstrap.sh
```

You can also use the package script from the repository root:

```bash
pnpm --filter @muninn/benchmark-locomo bootstrap
```

### Tests

Run the full benchmark-local test slice:

```bash
sh benchmark/locomo/scripts/test.sh
```

Or through `pnpm`:

```bash
pnpm --filter @muninn/benchmark-locomo test
```

### Fetch Data

Download or refresh the default cached LoCoMo dataset from the pinned fork
commit:

```bash
sh benchmark/locomo/scripts/fetch-data.sh
```

Or through `pnpm`:

```bash
pnpm --filter @muninn/benchmark-locomo fetch-data
```

### Benchmark Run

Run the benchmark end-to-end. If `--data-file` is omitted, the wrapper script
downloads the default LoCoMo payload into `benchmark/locomo/.cache/data/` and
uses that cached copy automatically:

```bash
sh benchmark/locomo/scripts/run.sh \
  --out-file benchmark/locomo/out/locomo10_results.json \
  --progress-file benchmark/locomo/out/locomo10_progress.jsonl \
  --modes dialog,observation,summary \
  --pipeline both \
  --top-k 5
```

Or through `pnpm`:

```bash
pnpm --filter @muninn/benchmark-locomo benchmark -- \
  --out-file benchmark/locomo/out/locomo10_results.json \
  --progress-file benchmark/locomo/out/locomo10_progress.jsonl \
  --modes dialog,observation,summary \
  --pipeline both \
  --top-k 5
```

### Single Mode

```bash
sh benchmark/locomo/scripts/run.sh \
  --out-file benchmark/locomo/out/locomo10_dialog_results.json \
  --progress-file benchmark/locomo/out/locomo10_dialog_progress.jsonl \
  --modes dialog \
  --top-k 5
```

### Single Sample

```bash
sh benchmark/locomo/scripts/run.sh \
  --out-file benchmark/locomo/out/sample_1_dialog_results.json \
  --progress-file benchmark/locomo/out/sample_1_dialog_progress.jsonl \
  --modes dialog \
  --sample-id <sample_id> \
  --top-k 5
```

If `--sample-id` does not exist in the selected dataset, the runner exits with an error instead of writing an empty benchmark result.

### Limit QA Count

```bash
sh benchmark/locomo/scripts/run.sh \
  --out-file benchmark/locomo/out/debug_results.json \
  --progress-file benchmark/locomo/out/debug_progress.jsonl \
  --modes dialog \
  --limit-questions 20 \
  --top-k 5
```

If you want to use a manually managed dataset file instead of the cached
default, pass `--data-file /path/to/locomo10.json` or
`--data-file=/path/to/locomo10.json` explicitly.

## Runtime Behavior

For each `sample_id + pipeline + mode` tuple, the runner:

1. creates an isolated `MUNINN_HOME`
2. imports LoCoMo source data into Muninn through the local bridge
3. builds deterministic query candidates from each question
4. runs batch recall through Muninn
5. maps retrieved rows back to LoCoMo source ids
6. generates a non-LLM heuristic answer
7. writes QA results and aggregate stats

This means the benchmark measures Muninn's current text recall behavior, not an
embedding retriever and not an LLM answerer.

## Output Files

The runner writes three files:

- `<out-file>`
  - per-sample QA results
  - includes `muninn_<pipeline>_<mode>_top_<k>_prediction`
  - includes `muninn_<pipeline>_<mode>_top_<k>_prediction_context`
- `<out-file stem>_stats.json`
  - aggregate F1 and retrieval recall
  - grouped by `pipeline -> mode -> category`
- `<out-file stem>_report.json`
  - top recall misses
  - top extraction misses
  - oracle vs generated delta samples

If `--progress-file` is provided, the runner also writes a fresh-start
`progress.jsonl` event stream for runtime observation only. It is overwritten on
each run and is not used for resume logic.

Outputs are written under `benchmark/locomo/out/`, which is gitignored.

Temporary benchmark homes may also be written under `benchmark/locomo/.runs/`
when `--keep-home` is used.

## Current Limitations

- This is an evaluator-compatible baseline, not a parity answerer with the
  original LoCoMo LLM pipeline.
- Muninn recall is currently text-based, so the query builder and heuristic
  answer extraction matter a lot for benchmark quality.
- Original LoCoMo timestamps are preserved as benchmark metadata and text, not
  as first-class Muninn row timestamps.
- The runtime wrappers intentionally rebuild the bridge and export the daemon
  before tests or benchmark runs.

## Progress Observation

The runner emits structured progress lines to `stderr` for every major stage:

- `run_start` / `run_complete`
- `sample_start` / `sample_complete`
- `unit_start` / `unit_complete`
- `phase_start` / `phase_complete`
- `*_failed` on the last known failure point

The optional `progress.jsonl` file mirrors those events in machine-readable
form. Each record includes a UTC timestamp plus any available context such as:

- `sample_id`
- `pipeline`
- `mode`
- `qa_count`
- `query_candidate_count`
- `elapsed_s`
- `error_type`
- `error`

This is meant for diagnosing long runs and bottlenecks while keeping each full
benchmark invocation a fresh start.

## Tests

Python unit tests:

```bash
python3 -m unittest benchmark.locomo.tests.test_scoring
```

Node bridge tests:

```bash
sh benchmark/locomo/scripts/test.sh
```

## Implementation Notes

- The Python side talks to Muninn through `benchmark/common/muninn_bridge.py`
- The bridge itself talks directly to `@muninn/core`, not sidecar
- Benchmark metadata is stored in Muninn row artifacts so recall hits can be
  mapped back to LoCoMo source ids like `D1:3` or `S2`
