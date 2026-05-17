# Muninn LoCoMo Benchmark Skill Design

## Goal

Create a repeatable workflow for running Muninn LoCoMo evaluations without hand-assembling commands each time. The workflow should cover the common targets we use during development, enforce the same preflight checks, run the three scoring views every time, and produce a readable summary when a run succeeds or fails.

This design has two parts:

- A repository runner script that executes the benchmark deterministically.
- A global Codex skill that tells agents to use that runner and how to interpret natural-language test requests.

## Non-Goals

- Do not change LoCoMo scoring semantics.
- Do not change recall, extraction, observer, Lance, or model behavior.
- Do not replace `run.py`, `qa_existing.py`, or the judge scripts; wrap them.
- Do not preserve compatibility for obsolete benchmark command shapes.

## Natural Language Target Selection

The skill should infer the runner `--target` from user wording whenever the request is clear.

Mappings:

- "三个测试集组装的新小样本", "新小样本", "three small" -> `three-small`
- "26", "conv-26", "完整 26 测试集" -> `conv-26`
- "全量", "full", "整个 locomo" -> `full`
- "跑 30", "conv-30" -> `sample:conv-30`
- "跑 26、30、41" -> `sample:conv-26,conv-30,conv-41`
- "session1+session2 小样本" -> `conv-26-sessions-1-2`

If the target is ambiguous, the agent should ask one concise confirmation question. If it is clear, it should run without asking.

## Runner Interface

Add `benchmark/locomo/scripts/run_muninn_eval.py`.

Required behavior:

```bash
python3 benchmark/locomo/scripts/run_muninn_eval.py \
  --target three-small \
  --top-k 8 \
  --budget 0 \
  --query-limit 8 \
  --recall-mode hybrid \
  --watermark-timeout-ms 7200000
```

Parameters:

- `--target`: `three-small`, `conv-26`, `full`, `conv-26-sessions-1-2`, or `sample:<id>[,<id>...]`.
- `--top-k`: forwarded to LoCoMo recall when `budget=0`.
- `--budget`: forwarded to recall. `0` disables recaller mode.
- `--query-limit`: forwarded to recall.
- `--recall-mode`: `vector`, `fts`, or `hybrid`.
- `--watermark-timeout-ms`: exported as `MUNINN_LOCOMO_WATERMARK_TIMEOUT_MS`.
- `--answerer`: default `llm`.
- `--keep-home`: default enabled unless explicitly disabled.
- `--run-name`: optional override for output naming.

The defaults should be safe development defaults, not hidden assumptions:

- `top-k=8`
- `budget=0`
- `query-limit=8`
- `recall-mode=hybrid`
- `watermark-timeout-ms=7200000`
- `answerer=llm`

## Preflight Checks

Before running a benchmark, the runner should:

1. Stop old LoCoMo benchmark processes.
2. Check that the selected data file exists.
3. Check that `muninn.json` exists in the current workspace.
4. Print the detected target, parameters, output prefix, and Muninn home.
5. Require external network capability through the surrounding Codex execution flow. The runner should not silently retry forever if provider calls fail.

Process cleanup is intentionally narrow. It may kill only commands matching:

- `benchmark/locomo/run.py`
- `benchmark/locomo/qa_existing.py`
- `benchmark/locomo/scripts/openviking_judge.py`
- `benchmark/locomo/scripts/honcho_judge.py`

It must not kill arbitrary Python or Node processes.

## Execution Flow

For a full run, the runner should:

1. Run `benchmark/locomo/run.py` with the selected target data and parameters.
2. Use the result JSON from `run.py` as the source of F1 and recall statistics.
3. Run `benchmark/locomo/scripts/openviking_judge.py`.
4. Run `benchmark/locomo/scripts/honcho_judge.py`.
5. Write a machine-readable summary JSON.
6. Write a human-readable bad cases Markdown report.

For future QA-only reuse, the runner may support a mode that uses `qa_existing.py`, but the MVP should optimize for full runs because most recent failures involved import, extraction, observer, or watermark behavior.

## Output Files

Every run should use one output prefix:

```text
benchmark/locomo/out/<run-name>.real.json
benchmark/locomo/out/<run-name>.progress.jsonl
benchmark/locomo/out/<run-name>.openviking.json
benchmark/locomo/out/<run-name>.honcho.json
benchmark/locomo/out/<run-name>.summary.json
benchmark/locomo/out/<run-name>.badcases.md
```

The summary JSON should include:

- Target and resolved data file.
- All recall and benchmark parameters.
- Muninn home path.
- Result JSON path.
- Progress JSONL path.
- F1 and recall aggregates.
- OpenViking pass rate.
- Honcho pass rate.
- Failure stage, if any.
- Failure diagnosis, if detectable.

The bad cases report should include, for each low-quality QA:

- Sample id and QA index.
- Category.
- Question.
- Gold answer.
- Prediction.
- F1 and recall.
- Top recalled memories when available.
- OpenViking and Honcho verdicts when available.
- Short failure note derived from available result fields.

## Failure Diagnosis

The runner should classify common failures from stderr, progress logs, and result artifacts.

Failure classes:

- `fetch_failed`: external LLM or embedding request failed.
- `watermark_pending`: extractor or observer backlog did not drain before timeout.
- `watchdog_or_optimize_stuck`: no QA progress while watchdog or maintenance logs continue.
- `qa_batch_stuck`: recall batch starts but no per-query progress arrives within the timeout window.
- `judge_stuck`: OpenViking or Honcho judge stops emitting progress.
- `missing_data_or_config`: data file or `muninn.json` is missing.
- `unknown`: failure did not match a known signature.

The runner should stop after a classified failure and still write a summary file when possible.

## Skill Behavior

Create a global skill named `muninn-locomo-benchmark`.

The skill should:

- Trigger for Muninn LoCoMo benchmark, small sample, conv-26, full LoCoMo, QA-only, F1/OpenViking/Honcho scoring, and bad case analysis requests.
- Parse natural language into `--target` and runner parameters.
- Prefer the repo runner script over hand-written command sequences.
- Use external execution approval when live LLM or embedding services are required.
- Report the command used, output files, run home, and all three scoring views.
- If the runner fails, report the classified failure and the most relevant log lines.

The skill should not contain a long copy of benchmark implementation details. It should be short and procedural, with the runner script carrying deterministic behavior.

## Testing

Minimum verification after implementation:

- Unit tests for target parsing.
- Unit tests for summary extraction from a fixture result JSON.
- Unit tests for failure classification.
- A smoke run with `--target three-small --budget 0 --top-k 8 --recall-mode hybrid`, if external services are available.

If external services are unavailable, the implementation should still pass local tests and the final response should state that live verification was blocked by provider/network failure.

