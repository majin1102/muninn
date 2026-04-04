# LoCoMo Benchmark

This module benchmarks Muninn as a single QA system.

The benchmark flow is:

1. import one LoCoMo sample into an isolated Muninn home
2. recall context from Muninn for each question
3. send recalled context plus the question to one fixed OpenAI-compatible QA model
4. score final answer F1 and hidden recall

This v1 runner does not mirror LoCoMo's original `dialog / observation / summary`
RAG modes. It intentionally tests one Muninn entrypoint.

## Module Layout

- `src/bridge.ts`
  - thin Node bridge into `@muninn/core`
  - imports raw conversation turns into Muninn
  - maintains an external manifest for hidden recall scoring
  - resolves recalled memories back to LoCoMo evidence ids
- `run.py`
  - benchmark entrypoint
  - coordinates import, recall, QA prompting, and score writing
- `dataset.py`
  - LoCoMo dataset loading helpers
- `heuristics.py`
  - query candidate generation helpers
- `scoring.py`
  - answer F1 and hidden recall scoring helpers
- `test/`
  - Node bridge tests and fixtures
- `tests/`
  - Python unit tests

## Import Model

Each LoCoMo dialog turn is imported as one Muninn record:

- `session_id = locomo:<sample_id>:session_<n>`
- `prompt = "<speaker>: <dialog text>"`
- `summary = "<speaker>: <dialog text>"`
- `response = "Recorded."`

Benchmark-specific truth data is not written into Muninn rows.
Instead, the bridge writes a run-local manifest under the benchmark home that maps:

- `turn_id -> source_id`
- `turn_id -> sample_id`
- `turn_id -> session_id`
- import order and LoCoMo `date_time`

That manifest is used only for hidden recall scoring.

## Prerequisites

Run everything from the repository root.

Required:

- `pnpm install`
- a working Rust toolchain, because `@muninn/core` starts the Rust daemon
- `python3`
- an OpenAI-compatible chat endpoint

Environment:

- `OPENAI_API_KEY`
- optionally `OPENAI_BASE_URL`

## Build

Build the Node bridge once before running the benchmark:

```bash
pnpm --filter @muninn/benchmark-locomo build
```

You can also run the package test target, which rebuilds the bridge first:

```bash
pnpm --filter @muninn/benchmark-locomo test
```

## Run

### Full run

```bash
python3 benchmark/locomo/run.py \
  --data-file ../locomo/data/locomo10.json \
  --out-file benchmark/locomo/out/locomo10_results.json \
  --qa-model gpt-4.1-mini \
  --top-k 5
```

### Single sample

```bash
python3 benchmark/locomo/run.py \
  --data-file ../locomo/data/locomo10.json \
  --out-file benchmark/locomo/out/sample_results.json \
  --sample-id <sample_id> \
  --qa-model gpt-4.1-mini \
  --top-k 5
```

### Limit the QA count for debugging

```bash
python3 benchmark/locomo/run.py \
  --data-file ../locomo/data/locomo10.json \
  --out-file benchmark/locomo/out/debug_results.json \
  --limit-questions 20 \
  --qa-model gpt-4.1-mini \
  --top-k 5
```

## Runtime Behavior

For each `sample_id`, the runner:

1. creates an isolated `MUNINN_HOME`
2. imports the LoCoMo conversation into Muninn
3. builds search query candidates from each question
4. runs batch recall through Muninn
5. renders recalled hits into a QA prompt
6. asks one fixed QA model for the final answer
7. scores answer F1 and hidden recall

Hidden recall is computed inside the harness by resolving recalled `memory_id`s
back to imported turn ids and then to LoCoMo evidence ids. Those ids are not
shown to the QA model.

## Output Files

The runner writes two files:

- `<out-file>`
  - per-sample QA results
  - includes `<model_key>_prediction`
  - includes `<model_key>_f1`
  - includes `<model_key>_recall`
- `<out-file stem>_stats.json`
  - aggregate F1 and hidden recall
  - grouped by category

Outputs are written under `benchmark/locomo/out/`, which is gitignored.

Temporary benchmark homes may also be written under `benchmark/locomo/.runs/`
when `--keep-home` is used.

The benchmark bootstraps each isolated home with `muninn.json`, using
`benchmark/locomo/muninn.json` as the base template and overlaying the active
Muninn config's runtime LLM sections when available.

## Tests

Python unit tests:

```bash
python3 -m unittest benchmark.locomo.tests.test_scoring
```

Node bridge tests:

```bash
pnpm --filter @muninn/benchmark-locomo test
```
