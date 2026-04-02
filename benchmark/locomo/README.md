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

This repository now vendors the LoCoMo benchmark data under
`benchmark/locomo/data/` so benchmark runs do not depend on a sibling checkout.

- Vendored source: <https://github.com/snap-research/locomo>
- Default benchmark file: `benchmark/locomo/data/locomo10.json`
- License note: upstream LoCoMo data is distributed under `CC BY-NC 4.0`
- Attribution and a local license copy are included in
  `benchmark/locomo/data/README.md` and `benchmark/locomo/data/LOCOMO_LICENSE.txt`

If you reuse or redistribute these files, review the upstream non-commercial
license terms first.

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

### Benchmark Run

Run the benchmark end-to-end:

```bash
sh benchmark/locomo/scripts/run.sh \
  --data-file benchmark/locomo/data/locomo10.json \
  --out-file benchmark/locomo/out/locomo10_results.json \
  --modes dialog,observation,summary \
  --pipeline both \
  --top-k 5
```

Or through `pnpm`:

```bash
pnpm --filter @muninn/benchmark-locomo benchmark -- \
  --data-file benchmark/locomo/data/locomo10.json \
  --out-file benchmark/locomo/out/locomo10_results.json \
  --modes dialog,observation,summary \
  --pipeline both \
  --top-k 5
```

### Single Mode

```bash
sh benchmark/locomo/scripts/run.sh \
  --data-file benchmark/locomo/data/locomo10.json \
  --out-file benchmark/locomo/out/locomo10_dialog_results.json \
  --modes dialog \
  --top-k 5
```

### Single Sample

```bash
sh benchmark/locomo/scripts/run.sh \
  --data-file benchmark/locomo/data/locomo10.json \
  --out-file benchmark/locomo/out/sample_1_dialog_results.json \
  --modes dialog \
  --sample-id <sample_id> \
  --top-k 5
```

### Limit QA Count

```bash
sh benchmark/locomo/scripts/run.sh \
  --data-file benchmark/locomo/data/locomo10.json \
  --out-file benchmark/locomo/out/debug_results.json \
  --modes dialog \
  --limit-questions 20 \
  --top-k 5
```

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
