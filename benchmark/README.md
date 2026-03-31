# Benchmarks

`benchmark/` is the top-level home for evaluation modules that run directly
against Munnai.

These modules are intentionally different from upstream benchmark repos:

- data is imported into isolated Munnai homes inside this repository
- recall is executed directly through Munnai
- no LLM generation step is required in the benchmark loop
- benchmark adapters live next to Munnai code, so import and retrieval logic can
  evolve with the product

## Directory Structure

- `common/`
  - shared helpers used by multiple benchmark modules
  - current example: Python wrapper around the local Node bridge
- `locomo/`
  - first benchmark module
  - adapts LoCoMo data and scoring to run on top of Munnai

Each benchmark module is expected to be self-contained:

- its own README with concrete run instructions
- dataset adapter logic
- scoring logic
- minimal tests and smoke fixtures
- a thin bridge into Munnai if the benchmark is driven from another runtime

## Working Principles

All benchmark modules under this directory should follow these rules:

1. Use isolated `MUNNAI_HOME` directories so benchmark runs do not pollute
   normal local data.
2. Talk to Munnai directly through `@munnai/core` unless there is a strong
   reason to insert sidecar or MCP in the loop.
3. Keep the benchmark loop deterministic when possible. If a benchmark needs
   answer generation, prefer non-LLM baselines first.
4. Keep benchmark-specific import logic in the benchmark module rather than
   teaching generic product code about one benchmark's schema.

## Outputs

Benchmark run artifacts should go under the module-local ignored directories:

- `benchmark/<name>/out/`
- `benchmark/<name>/.runs/`

These are intentionally ignored by git so benchmark experiments can be rerun and
inspected locally without polluting commits.

## Adding A New Benchmark

When adding another benchmark module under `benchmark/`, follow the LoCoMo
pattern:

1. Create `benchmark/<name>/README.md`
2. Add the module's adapter, runner, and scorer
3. Reuse `benchmark/common` where it makes sense
4. Add at least one smoke fixture and one automated test path
5. Keep the benchmark runnable from the repository root
