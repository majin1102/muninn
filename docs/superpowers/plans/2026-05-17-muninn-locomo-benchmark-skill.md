# Muninn LoCoMo Benchmark Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a repeatable Muninn LoCoMo evaluation workflow with a repo runner and a global Codex skill so agents stop hand-assembling fragile benchmark commands.

**Architecture:** Add a Python runner under `benchmark/locomo/scripts/` that wraps existing `run.py`, `qa_existing.py`, OpenViking judge, and Honcho judge with target parsing, preflight checks, process cleanup, failure diagnosis, and summary report generation. Add a thin global skill under `/Users/Nathan/.codex/skills/muninn-locomo-benchmark/` that maps natural language requests to runner parameters and requires the runner as the default execution path.

**Tech Stack:** Python standard library, existing LoCoMo benchmark scripts, existing unittest test suite, Codex global skill Markdown.

---

## File Map

- Create `benchmark/locomo/scripts/run_muninn_eval.py`: deterministic CLI entrypoint for Muninn LoCoMo benchmark runs.
- Create `benchmark/locomo/tests/test_run_muninn_eval.py`: unit tests for target resolution, command construction, summary extraction, badcase generation, and failure diagnosis.
- Create `/Users/Nathan/.codex/skills/muninn-locomo-benchmark/SKILL.md`: global skill instructions. This path is outside the repo and requires filesystem approval during implementation.
- Optionally create `/Users/Nathan/.codex/skills/muninn-locomo-benchmark/agents/openai.yaml`: UI metadata for the global skill if the implementation worker chooses to use `skill-creator` helpers.
- Modify no existing benchmark behavior unless tests prove the runner cannot wrap it correctly.

## Design Notes For Implementers

- Do not duplicate `run.py` internals. The runner should call existing scripts as subprocesses.
- Do not make the runner kill arbitrary processes. Only kill matching LoCoMo benchmark commands.
- Do not make live external services part of unit tests. Unit tests use pure functions and fixture JSON.
- Do not hide partial failures. Always write a summary JSON when enough information exists.
- Keep natural-language target parsing in the skill text, not in the Python runner. The runner receives explicit `--target`.

---

### Task 1: Add Runner Pure Helpers And Tests

**Files:**
- Create: `benchmark/locomo/scripts/run_muninn_eval.py`
- Create: `benchmark/locomo/tests/test_run_muninn_eval.py`

- [ ] **Step 1: Write failing tests for target resolution**

Add this test file:

```python
from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from benchmark.locomo.scripts.run_muninn_eval import (
    BuildConfig,
    build_paths,
    classify_failure,
    extract_stats,
    resolve_target,
)


class RunMuninnEvalTests(unittest.TestCase):
    def test_resolve_known_targets(self) -> None:
        self.assertEqual(resolve_target("three-small").data_file, Path("benchmark/locomo/.cache/data/locomo-three-small-shared.json"))
        self.assertEqual(resolve_target("conv-26").sample_ids, ["conv-26"])
        self.assertEqual(resolve_target("conv-26-sessions-1-2").data_file, Path("benchmark/locomo/.cache/data/conv-26-sessions-1-2-current.json"))
        self.assertEqual(resolve_target("full").data_file, Path("benchmark/locomo/.cache/data/locomo10.json"))

    def test_resolve_sample_list_target(self) -> None:
        target = resolve_target("sample:conv-26,conv-30,conv-41")
        self.assertEqual(target.data_file, Path("benchmark/locomo/.cache/data/locomo10.json"))
        self.assertEqual(target.sample_ids, ["conv-26", "conv-30", "conv-41"])

    def test_resolve_rejects_unknown_target(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsupported target"):
            resolve_target("custom")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
python3 -m unittest benchmark.locomo.tests.test_run_muninn_eval
```

Expected: import failure because `benchmark.locomo.scripts.run_muninn_eval` does not exist yet.

- [ ] **Step 3: Implement target and path helpers**

Create `benchmark/locomo/scripts/run_muninn_eval.py` with:

```python
from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[3]
OUT_DIR = ROOT / "benchmark" / "locomo" / "out"
RUNS_DIR = ROOT / "benchmark" / "locomo" / ".runs"
DEFAULT_FULL_DATA = ROOT / "benchmark" / "locomo" / ".cache" / "data" / "locomo10.json"
THREE_SMALL_DATA = ROOT / "benchmark" / "locomo" / ".cache" / "data" / "locomo-three-small-shared.json"
CONV_26_SESSIONS_1_2_DATA = ROOT / "benchmark" / "locomo" / ".cache" / "data" / "conv-26-sessions-1-2-current.json"


@dataclass(frozen=True)
class Target:
    name: str
    data_file: Path
    sample_ids: list[str]


@dataclass(frozen=True)
class BuildConfig:
    target: Target
    top_k: int
    budget: int
    query_limit: int
    recall_mode: str
    watermark_timeout_ms: int
    answerer: str
    keep_home: bool
    run_name: str | None = None


@dataclass(frozen=True)
class RunPaths:
    run_name: str
    out_file: Path
    progress_file: Path
    openviking_file: Path
    honcho_file: Path
    summary_file: Path
    badcases_file: Path
    home_dir: Path


def rel(path: Path) -> Path:
    try:
        return path.resolve().relative_to(ROOT.resolve())
    except ValueError:
        return path


def resolve_target(value: str) -> Target:
    target = value.strip()
    if target == "three-small":
        return Target(target, rel(THREE_SMALL_DATA), [])
    if target == "conv-26":
        return Target(target, rel(DEFAULT_FULL_DATA), ["conv-26"])
    if target == "conv-26-sessions-1-2":
        return Target(target, rel(CONV_26_SESSIONS_1_2_DATA), [])
    if target == "full":
        return Target(target, rel(DEFAULT_FULL_DATA), [])
    if target.startswith("sample:"):
        sample_ids = [item.strip() for item in target.removeprefix("sample:").split(",") if item.strip()]
        if not sample_ids:
            raise ValueError("sample target must include at least one sample id")
        return Target(target, rel(DEFAULT_FULL_DATA), sample_ids)
    raise ValueError(f"unsupported target: {value}")


def build_paths(config: BuildConfig) -> RunPaths:
    base = config.run_name or default_run_name(config)
    return RunPaths(
        run_name=base,
        out_file=rel(OUT_DIR / f"{base}.real.json"),
        progress_file=rel(OUT_DIR / f"{base}.progress.jsonl"),
        openviking_file=rel(OUT_DIR / f"{base}.openviking.json"),
        honcho_file=rel(OUT_DIR / f"{base}.honcho.json"),
        summary_file=rel(OUT_DIR / f"{base}.summary.json"),
        badcases_file=rel(OUT_DIR / f"{base}.badcases.md"),
        home_dir=rel(RUNS_DIR / f"{base}.real"),
    )


def default_run_name(config: BuildConfig) -> str:
    safe_target = config.target.name.replace(":", "-").replace(",", "-")
    return f"{safe_target}-budget{config.budget}-top{config.top_k}-{config.recall_mode}"
```

- [ ] **Step 4: Run target tests**

Run:

```bash
python3 -m unittest benchmark.locomo.tests.test_run_muninn_eval
```

Expected: the target tests pass and later tests are not present yet.

- [ ] **Step 5: Commit target helpers**

Run:

```bash
git add benchmark/locomo/scripts/run_muninn_eval.py benchmark/locomo/tests/test_run_muninn_eval.py
git commit -m "feat: add locomo eval target helpers"
```

---

### Task 2: Add Summary Extraction, Badcase Report, And Failure Classification

**Files:**
- Modify: `benchmark/locomo/scripts/run_muninn_eval.py`
- Modify: `benchmark/locomo/tests/test_run_muninn_eval.py`

- [ ] **Step 1: Add tests for stats and failure diagnosis**

Append tests:

```python
    def test_extract_stats_reads_f1_recall_and_judges(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            result = root / "result.json"
            openviking = root / "openviking.json"
            honcho = root / "honcho.json"
            result.write_text(json.dumps([{"sample_id": "conv-a", "qa": []}]), encoding="utf8")
            result.with_name("result.real_stats.json").write_text(json.dumps({
                "qa_count": 2,
                "average_f1": 0.5,
                "average_recall": 0.75,
            }), encoding="utf8")
            openviking.write_text(json.dumps({"accuracy": {"correct": 1, "total": 2, "accuracy": 0.5}}), encoding="utf8")
            honcho.write_text(json.dumps({"accuracy": {"passed": 2, "total": 2, "accuracy": 1.0}}), encoding="utf8")

            stats = extract_stats(result, openviking, honcho)

        self.assertEqual(stats["qa_count"], 2)
        self.assertEqual(stats["average_f1"], 0.5)
        self.assertEqual(stats["average_recall"], 0.75)
        self.assertEqual(stats["openviking_accuracy"], 0.5)
        self.assertEqual(stats["honcho_accuracy"], 1.0)

    def test_classify_known_failures(self) -> None:
        self.assertEqual(classify_failure("TypeError: fetch failed", ""), "fetch_failed")
        self.assertEqual(classify_failure("", "waiting for turn:17: 40 pending"), "watermark_pending")
        self.assertEqual(classify_failure("", "phase_start phase=recall_batch"), "qa_batch_stuck")
        self.assertEqual(classify_failure("[openviking_judge] 10/40", ""), "judge_stuck")
        self.assertEqual(classify_failure("FileNotFoundError: muninn.json", ""), "missing_data_or_config")
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
python3 -m unittest benchmark.locomo.tests.test_run_muninn_eval
```

Expected: fails because `extract_stats` and `classify_failure` are missing.

- [ ] **Step 3: Implement stats extraction and failure classification**

Add:

```python
def stats_path(out_file: Path) -> Path:
    name = out_file.name
    if name.endswith(".real.json"):
        return out_file.with_name(name.removesuffix(".real.json") + ".real_stats.json")
    return out_file.with_name(out_file.stem + "_stats.json")


def load_json_if_exists(path: Path) -> Any:
    actual = ROOT / path if not path.is_absolute() else path
    if not actual.exists():
        return None
    return json.loads(actual.read_text(encoding="utf8"))


def extract_stats(result_file: Path, openviking_file: Path, honcho_file: Path) -> dict[str, Any]:
    f1_stats = load_json_if_exists(stats_path(result_file)) or {}
    openviking = load_json_if_exists(openviking_file) or {}
    honcho = load_json_if_exists(honcho_file) or {}
    openviking_accuracy = (openviking.get("accuracy") or {}).get("accuracy")
    honcho_accuracy = (honcho.get("accuracy") or {}).get("accuracy")
    return {
        "qa_count": f1_stats.get("qa_count", 0),
        "average_f1": f1_stats.get("average_f1", 0.0),
        "average_recall": f1_stats.get("average_recall", 0.0),
        "category_f1": f1_stats.get("category_f1", {}),
        "category_recall": f1_stats.get("category_recall", {}),
        "openviking_accuracy": openviking_accuracy,
        "honcho_accuracy": honcho_accuracy,
    }


def classify_failure(stderr: str, progress: str) -> str:
    combined = f"{stderr}\n{progress}".lower()
    if "fetch failed" in combined:
        return "fetch_failed"
    if "filenotfounderror" in combined or "muninn.json" in combined or "data file" in combined:
        return "missing_data_or_config"
    if "waiting for" in combined and "pending" in combined:
        return "watermark_pending"
    if "phase_start phase=recall_batch" in combined and "qa_progress" not in combined:
        return "qa_batch_stuck"
    if "openviking_judge" in combined or "honcho_judge" in combined:
        return "judge_stuck"
    if "watchdog" in combined or "optimize" in combined or "maintenance" in combined:
        return "watchdog_or_optimize_stuck"
    return "unknown"
```

- [ ] **Step 4: Add badcase report generation tests**

Append:

```python
    def test_build_badcases_report_includes_low_f1_rows(self) -> None:
        from benchmark.locomo.scripts.run_muninn_eval import build_badcases_report

        samples = [{
            "sample_id": "conv-a",
            "qa": [{
                "question": "What did Alice research?",
                "answer": "adoption agencies",
                "category": 4,
                "muninn_hybrid_top_8_prediction": "career options",
                "muninn_hybrid_top_8_f1": 0.0,
                "muninn_hybrid_top_8_recall": 0.0,
                "muninn_hybrid_top_8_hits": [{
                    "memory_id": "observation:1",
                    "detail": "Alice discussed career options.",
                    "evidence_ids": ["D1:1"],
                }],
            }],
        }]
        report = build_badcases_report(samples, "muninn_hybrid_top_8", {}, {})

        self.assertIn("What did Alice research?", report)
        self.assertIn("Gold: adoption agencies", report)
        self.assertIn("Prediction: career options", report)
        self.assertIn("observation:1", report)
```

- [ ] **Step 5: Implement badcase report generation**

Add:

```python
def build_badcases_report(
    samples: list[dict[str, Any]],
    model_key: str,
    openviking_by_key: dict[tuple[str, int], dict[str, Any]],
    honcho_by_key: dict[tuple[str, int], dict[str, Any]],
) -> str:
    lines = ["# Muninn LoCoMo Bad Cases", ""]
    for sample in samples:
        sample_id = str(sample.get("sample_id") or "")
        for index, qa in enumerate(sample.get("qa") or []):
            f1 = float(qa.get(f"{model_key}_f1") or 0.0)
            recall = float(qa.get(f"{model_key}_recall") or 0.0)
            ov = openviking_by_key.get((sample_id, index))
            hc = honcho_by_key.get((sample_id, index))
            ov_bad = ov is not None and ov.get("result") != "CORRECT"
            hc_bad = hc is not None and not bool(hc.get("passed"))
            if f1 >= 1.0 and recall >= 1.0 and not ov_bad and not hc_bad:
                continue
            lines.extend([
                f"## {sample_id} Q{index}",
                "",
                f"- Category: {qa.get('category')}",
                f"- Question: {qa.get('question')}",
                f"- Gold: {qa.get('answer')}",
                f"- Prediction: {qa.get(f'{model_key}_prediction')}",
                f"- F1: {f1:.4f}",
                f"- Recall: {recall:.4f}",
            ])
            if ov is not None:
                lines.append(f"- OpenViking: {ov.get('result')} - {ov.get('reasoning')}")
            if hc is not None:
                lines.append(f"- Honcho: {'PASS' if hc.get('passed') else 'FAIL'} - {hc.get('reasoning')}")
            hits = qa.get(f"{model_key}_hits") or []
            for hit_index, hit in enumerate(hits[:5], start=1):
                detail = str(hit.get("detail") or hit.get("matched_text") or "").replace("\n", " ")
                lines.append(f"- Hit {hit_index}: {hit.get('memory_id')} | {detail[:300]} | evidence={hit.get('evidence_ids')}")
            lines.append("")
    if len(lines) == 2:
        lines.append("No bad cases detected by F1, recall, OpenViking, or Honcho.")
    return "\n".join(lines).rstrip() + "\n"


def judge_items_by_key(path: Path, kind: str) -> dict[tuple[str, int], dict[str, Any]]:
    payload = load_json_if_exists(path) or {}
    result: dict[tuple[str, int], dict[str, Any]] = {}
    for item in payload.get("items") or []:
        sample_id = str(item.get("sample_id") or "")
        qa_index = int(item.get("qa_index") or 0)
        result[(sample_id, qa_index)] = item
    return result
```

- [ ] **Step 6: Run unit tests**

Run:

```bash
python3 -m unittest benchmark.locomo.tests.test_run_muninn_eval
```

Expected: all runner helper tests pass.

- [ ] **Step 7: Commit helper reports**

Run:

```bash
git add benchmark/locomo/scripts/run_muninn_eval.py benchmark/locomo/tests/test_run_muninn_eval.py
git commit -m "feat: summarize locomo eval runs"
```

---

### Task 3: Implement Process Execution And Preflight

**Files:**
- Modify: `benchmark/locomo/scripts/run_muninn_eval.py`
- Modify: `benchmark/locomo/tests/test_run_muninn_eval.py`

- [ ] **Step 1: Add tests for command construction**

Append:

```python
    def test_build_run_command_includes_sample_ids_and_timeout(self) -> None:
        from benchmark.locomo.scripts.run_muninn_eval import build_run_command

        config = BuildConfig(
            target=resolve_target("sample:conv-26,conv-30"),
            top_k=8,
            budget=0,
            query_limit=8,
            recall_mode="hybrid",
            watermark_timeout_ms=7200000,
            answerer="llm",
            keep_home=True,
            run_name="test-run",
        )
        paths = build_paths(config)
        command, env = build_run_command(config, paths)

        joined = " ".join(command)
        self.assertIn("benchmark/locomo/run.py", joined)
        self.assertIn("--sample-id conv-26", joined)
        self.assertIn("--sample-id conv-30", joined)
        self.assertIn("--budget 0", joined)
        self.assertEqual(env["MUNINN_LOCOMO_WATERMARK_TIMEOUT_MS"], "7200000")
```

- [ ] **Step 2: Implement command builders**

Add:

```python
def build_run_command(config: BuildConfig, paths: RunPaths) -> tuple[list[str], dict[str, str]]:
    command = [
        sys.executable,
        "benchmark/locomo/run.py",
        "--data-file",
        str(config.target.data_file),
        "--out-file",
        str(paths.out_file),
        "--progress-file",
        str(paths.progress_file),
        "--top-k",
        str(config.top_k),
        "--budget",
        str(config.budget),
        "--query-limit",
        str(config.query_limit),
        "--recall-mode",
        config.recall_mode,
        "--answerer",
        config.answerer,
    ]
    if config.keep_home:
        command.append("--keep-home")
    for sample_id in config.target.sample_ids:
        command.extend(["--sample-id", sample_id])
    env = os.environ.copy()
    env["MUNINN_LOCOMO_WATERMARK_TIMEOUT_MS"] = str(config.watermark_timeout_ms)
    return command, env


def build_judge_commands(config: BuildConfig, paths: RunPaths) -> list[list[str]]:
    return [
        [
            sys.executable,
            "benchmark/locomo/scripts/openviking_judge.py",
            str(paths.out_file),
            str(paths.openviking_file),
        ],
        [
            sys.executable,
            "benchmark/locomo/scripts/honcho_judge.py",
            str(paths.out_file),
            str(paths.honcho_file),
            "--data-file",
            str(config.target.data_file),
        ],
    ]
```

- [ ] **Step 3: Add preflight and narrow process cleanup**

Add:

```python
MATCHED_PROCESS_MARKERS = (
    "benchmark/locomo/run.py",
    "benchmark/locomo/qa_existing.py",
    "benchmark/locomo/scripts/openviking_judge.py",
    "benchmark/locomo/scripts/honcho_judge.py",
)


def check_preflight(config: BuildConfig) -> None:
    data_file = ROOT / config.target.data_file
    if not data_file.exists():
        raise FileNotFoundError(f"data file does not exist: {config.target.data_file}")
    muninn_config = ROOT / "muninn.json"
    if not muninn_config.exists():
        raise FileNotFoundError("muninn.json does not exist in workspace root")


def kill_old_processes() -> list[int]:
    try:
        result = subprocess.run(["ps", "-ef"], cwd=ROOT, check=True, text=True, capture_output=True)
    except Exception:
        return []
    current_pid = os.getpid()
    killed: list[int] = []
    for line in result.stdout.splitlines():
        if not any(marker in line for marker in MATCHED_PROCESS_MARKERS):
            continue
        fields = line.split()
        if len(fields) < 2:
            continue
        try:
            pid = int(fields[1])
        except ValueError:
            continue
        if pid == current_pid:
            continue
        try:
            os.kill(pid, signal.SIGTERM)
            killed.append(pid)
        except ProcessLookupError:
            continue
    return killed
```

- [ ] **Step 4: Implement subprocess runner and summary writer**

Add:

```python
def run_command(command: list[str], *, env: dict[str, str] | None = None, phase: str) -> subprocess.CompletedProcess[str]:
    print(f"[muninn-eval] phase={phase} command={' '.join(command)}", flush=True)
    return subprocess.run(command, cwd=ROOT, env=env, text=True, capture_output=True)


def write_summary(
    config: BuildConfig,
    paths: RunPaths,
    *,
    status: str,
    failure: str | None = None,
    stderr: str = "",
    progress: str = "",
) -> dict[str, Any]:
    stats = extract_stats(paths.out_file, paths.openviking_file, paths.honcho_file)
    summary = {
        "status": status,
        "failure": failure,
        "target": config.target.name,
        "data_file": str(config.target.data_file),
        "sample_ids": config.target.sample_ids,
        "parameters": {
            "top_k": config.top_k,
            "budget": config.budget,
            "query_limit": config.query_limit,
            "recall_mode": config.recall_mode,
            "watermark_timeout_ms": config.watermark_timeout_ms,
            "answerer": config.answerer,
        },
        "paths": {
            "run_home": str(paths.home_dir),
            "result": str(paths.out_file),
            "progress": str(paths.progress_file),
            "openviking": str(paths.openviking_file),
            "honcho": str(paths.honcho_file),
            "badcases": str(paths.badcases_file),
        },
        "scores": stats,
        "stderr_tail": stderr[-4000:],
        "progress_tail": progress[-4000:],
    }
    actual = ROOT / paths.summary_file
    actual.parent.mkdir(parents=True, exist_ok=True)
    actual.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf8")
    return summary


def read_text_tail(path: Path, limit: int = 20000) -> str:
    actual = ROOT / path if not path.is_absolute() else path
    if not actual.exists():
        return ""
    text = actual.read_text(encoding="utf8", errors="replace")
    return text[-limit:]
```

- [ ] **Step 5: Implement CLI main**

Add:

```python
def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run Muninn LoCoMo benchmark with all scoring views.")
    parser.add_argument("--target", required=True)
    parser.add_argument("--top-k", type=int, default=8)
    parser.add_argument("--budget", type=int, default=0)
    parser.add_argument("--query-limit", type=int, default=8)
    parser.add_argument("--recall-mode", choices=["vector", "fts", "hybrid"], default="hybrid")
    parser.add_argument("--watermark-timeout-ms", type=int, default=7200000)
    parser.add_argument("--answerer", choices=["llm", "heuristic"], default="llm")
    parser.add_argument("--run-name")
    parser.add_argument("--no-keep-home", action="store_true")
    parser.add_argument("--no-kill-old", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    config = BuildConfig(
        target=resolve_target(args.target),
        top_k=args.top_k,
        budget=args.budget,
        query_limit=args.query_limit,
        recall_mode=args.recall_mode,
        watermark_timeout_ms=args.watermark_timeout_ms,
        answerer=args.answerer,
        keep_home=not args.no_keep_home,
        run_name=args.run_name,
    )
    paths = build_paths(config)
    try:
        check_preflight(config)
        if not args.no_kill_old:
            killed = kill_old_processes()
            if killed:
                print(f"[muninn-eval] killed old benchmark processes: {killed}", flush=True)
        print(json.dumps({
            "target": config.target.name,
            "data_file": str(config.target.data_file),
            "sample_ids": config.target.sample_ids,
            "out_file": str(paths.out_file),
            "progress_file": str(paths.progress_file),
            "home_dir": str(paths.home_dir),
        }, indent=2), flush=True)

        command, env = build_run_command(config, paths)
        run_result = run_command(command, env=env, phase="benchmark")
        if run_result.returncode != 0:
            progress = read_text_tail(paths.progress_file)
            failure = classify_failure(run_result.stderr, progress)
            write_summary(config, paths, status="failed", failure=failure, stderr=run_result.stderr, progress=progress)
            print(run_result.stdout, end="")
            print(run_result.stderr, end="", file=sys.stderr)
            return run_result.returncode

        for index, judge_command in enumerate(build_judge_commands(config, paths), start=1):
            judge = run_command(judge_command, phase=f"judge_{index}")
            if judge.returncode != 0:
                progress = read_text_tail(paths.progress_file)
                failure = classify_failure(judge.stderr + judge.stdout, progress)
                write_summary(config, paths, status="failed", failure=failure, stderr=judge.stderr + judge.stdout, progress=progress)
                print(judge.stdout, end="")
                print(judge.stderr, end="", file=sys.stderr)
                return judge.returncode

        samples = load_json_if_exists(paths.out_file) or []
        model_key = build_model_key(config)
        openviking = judge_items_by_key(paths.openviking_file, "openviking")
        honcho = judge_items_by_key(paths.honcho_file, "honcho")
        (ROOT / paths.badcases_file).write_text(
            build_badcases_report(samples, model_key, openviking, honcho),
            encoding="utf8",
        )
        summary = write_summary(config, paths, status="complete")
        print(json.dumps(summary["scores"], indent=2, ensure_ascii=False), flush=True)
        print(f"[muninn-eval] summary={paths.summary_file}", flush=True)
        print(f"[muninn-eval] badcases={paths.badcases_file}", flush=True)
        return 0
    except Exception as exc:
        failure = classify_failure(str(exc), read_text_tail(paths.progress_file))
        write_summary(config, paths, status="failed", failure=failure, stderr=repr(exc), progress=read_text_tail(paths.progress_file))
        raise


def build_model_key(config: BuildConfig) -> str:
    if config.budget > 0:
        return f"muninn_{config.recall_mode}_budget_{config.budget}_query_{config.query_limit}"
    return f"muninn_{config.recall_mode}_top_{config.top_k}"


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 6: Run tests**

Run:

```bash
python3 -m unittest benchmark.locomo.tests.test_run_muninn_eval
```

Expected: all tests pass.

- [ ] **Step 7: Run a dry preflight failure test manually**

Run:

```bash
python3 benchmark/locomo/scripts/run_muninn_eval.py --target missing
```

Expected: exits non-zero with `unsupported target: missing`.

- [ ] **Step 8: Commit runner execution**

Run:

```bash
git add benchmark/locomo/scripts/run_muninn_eval.py benchmark/locomo/tests/test_run_muninn_eval.py
git commit -m "feat: run locomo eval with judges"
```

---

### Task 4: Add Global Skill

**Files:**
- Create: `/Users/Nathan/.codex/skills/muninn-locomo-benchmark/SKILL.md`

- [ ] **Step 1: Create global skill directory**

Run with filesystem approval because the path is outside the repo writable root:

```bash
mkdir -p /Users/Nathan/.codex/skills/muninn-locomo-benchmark
```

Expected: directory exists.

- [ ] **Step 2: Write the skill body**

Create `/Users/Nathan/.codex/skills/muninn-locomo-benchmark/SKILL.md`:

```markdown
---
name: muninn-locomo-benchmark
description: Run Muninn LoCoMo benchmark targets, including three-small, conv-26, full, specified samples, QA scoring, OpenViking/Honcho judges, progress monitoring, and bad case summaries.
---

# Muninn LoCoMo Benchmark

Use this skill when the user asks to run Muninn LoCoMo tests, small samples, conv-26, full LoCoMo, specified conv samples, F1/recall, OpenViking/Honcho scoring, QA-only checks, or bad case analysis.

## Target Selection

Infer `--target` from the user request when clear:

- "三个测试集组装的新小样本", "新小样本", "three small" -> `three-small`
- "26", "conv-26", "完整 26 测试集" -> `conv-26`
- "全量", "full", "整个 locomo" -> `full`
- "跑 30", "conv-30" -> `sample:conv-30`
- "跑 26、30、41" -> `sample:conv-26,conv-30,conv-41`
- "session1+session2 小样本" -> `conv-26-sessions-1-2`

Ask one concise confirmation question only when the target is ambiguous.

## Default Runner

Prefer the repo runner. Do not hand-assemble `run.py` + judge commands unless the runner itself is broken.

```bash
source ~/.zprofile && python3 benchmark/locomo/scripts/run_muninn_eval.py \
  --target three-small \
  --top-k 8 \
  --budget 0 \
  --query-limit 8 \
  --recall-mode hybrid \
  --watermark-timeout-ms 7200000
```

All parameters are adjustable from the user request:

- `--top-k`
- `--budget`
- `--query-limit`
- `--recall-mode`
- `--watermark-timeout-ms`
- `--answerer`
- `--run-name`

Live runs use external LLM and embedding services. If sandboxed network fails with `fetch failed`, rerun with escalated execution and explain that external provider access is required.

## Required Output

After a run, report:

- F1 and recall.
- OpenViking score.
- Honcho score.
- Result JSON path.
- Progress JSONL path.
- Run home path.
- Bad cases report path.

If the run fails, report:

- Failure class from the summary JSON.
- The failed stage.
- The most relevant stderr/progress lines.
- The next concrete fix or retry action.

## Failure Classes

Use the runner summary first:

- `fetch_failed`: external LLM or embedding request failed.
- `watermark_pending`: extractor or observer backlog did not drain.
- `watchdog_or_optimize_stuck`: watchdog or Lance maintenance likely blocked progress.
- `qa_batch_stuck`: recall batch started but per-query progress stopped.
- `judge_stuck`: OpenViking or Honcho judge stopped progressing.
- `missing_data_or_config`: data file or `muninn.json` missing.
- `unknown`: inspect progress and stderr before guessing.

## Notes

- The runner kills only narrow LoCoMo benchmark processes before starting.
- Do not kill arbitrary Python or Node processes.
- Do not claim scores without reading the summary or result files.
- For quick reruns on an already imported home, use existing `qa_existing.py` only if the user explicitly asks for QA-only.
```

- [ ] **Step 3: Verify skill frontmatter**

Run:

```bash
python3 - <<'PY'
from pathlib import Path
p=Path('/Users/Nathan/.codex/skills/muninn-locomo-benchmark/SKILL.md')
text=p.read_text()
assert text.startswith('---\n')
assert 'name: muninn-locomo-benchmark' in text
assert 'description:' in text
print('ok')
PY
```

Expected: prints `ok`.

- [ ] **Step 4: Commit repo changes only**

Do not try to commit the global skill file because it is outside this repository. Commit only repository files already changed by previous tasks if there are unstaged repo changes:

```bash
git status --short
```

Expected: global skill file is not part of repo status.

---

### Task 5: Verify Runner Locally Without Live Providers

**Files:**
- Modify only if tests reveal bugs: `benchmark/locomo/scripts/run_muninn_eval.py`
- Modify only if tests reveal bugs: `benchmark/locomo/tests/test_run_muninn_eval.py`

- [ ] **Step 1: Run runner unit tests**

Run:

```bash
python3 -m unittest benchmark.locomo.tests.test_run_muninn_eval
```

Expected: pass.

- [ ] **Step 2: Run existing related tests**

Run:

```bash
python3 -m unittest benchmark.locomo.tests.test_llm_judges benchmark.locomo.tests.test_run benchmark.locomo.tests.test_slice
```

Expected: pass.

- [ ] **Step 3: Run core build only if runner imports changed shared code**

Run only if implementation touched package code outside `benchmark/locomo/scripts` and tests:

```bash
source ~/.zprofile && pnpm --filter @muninn/core build
```

Expected: pass.

- [ ] **Step 4: Commit verification fixes**

If this task required fixes, run:

```bash
git add benchmark/locomo/scripts/run_muninn_eval.py benchmark/locomo/tests/test_run_muninn_eval.py
git commit -m "test: cover locomo eval runner"
```

If there were no changes, do not create an empty commit.

---

### Task 6: Live Smoke Run

**Files:**
- No planned file changes.

- [ ] **Step 1: Run the three-small smoke**

Run with external network approval if needed:

```bash
source ~/.zprofile && python3 benchmark/locomo/scripts/run_muninn_eval.py \
  --target three-small \
  --top-k 8 \
  --budget 0 \
  --query-limit 8 \
  --recall-mode hybrid \
  --watermark-timeout-ms 7200000 \
  --run-name three-small-runner-smoke
```

Expected: either completes and writes all output files, or fails with a classified summary JSON.

- [ ] **Step 2: Inspect summary**

Run:

```bash
python3 - <<'PY'
import json
from pathlib import Path
p=Path('benchmark/locomo/out/three-small-runner-smoke.summary.json')
data=json.loads(p.read_text())
print(json.dumps({
  'status': data.get('status'),
  'failure': data.get('failure'),
  'scores': data.get('scores'),
  'paths': data.get('paths'),
}, indent=2, ensure_ascii=False))
PY
```

Expected: prints status, scores, and paths. If status is failed, `failure` is one of the defined failure classes.

- [ ] **Step 3: Inspect badcases**

Run:

```bash
sed -n '1,160p' benchmark/locomo/out/three-small-runner-smoke.badcases.md
```

Expected: readable Markdown with bad cases, or "No bad cases detected".

- [ ] **Step 4: Final status**

Report:

- command used
- summary path
- result path
- progress path
- run home
- F1/recall
- OpenViking score
- Honcho score
- failure class if failed

Do not claim live verification passed unless the runner exits `0` and the summary status is `complete`.

