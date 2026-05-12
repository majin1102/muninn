from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-file", required=True, type=Path)
    parser.add_argument("--sample-id", required=True)
    parser.add_argument("--runs-dir", default=Path("benchmark") / "locomo" / ".runs", type=Path)
    parser.add_argument("--out-dir", default=Path("benchmark") / "locomo" / "out", type=Path)
    parser.add_argument("--budgets", default="220,300,400,500")
    parser.add_argument("--query-limit", default=8, type=int)
    parser.add_argument("--recall-mode", choices=["vector", "fts", "hybrid"], default="hybrid")
    parser.add_argument("--limit-questions", default=None, type=int)
    parser.add_argument("--answerer", choices=["llm", "heuristic"], default="llm")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    budgets = [int(value.strip()) for value in args.budgets.split(",") if value.strip()]
    args.out_dir.mkdir(parents=True, exist_ok=True)

    for budget in budgets:
        stem = f"{args.sample_id}-qa-budget{budget}-query{args.query_limit}"
        command = [
            sys.executable,
            "benchmark/locomo/qa_existing.py",
            "--data-file",
            str(args.data_file),
            "--runs-dir",
            str(args.runs_dir),
            "--sample-id",
            args.sample_id,
            "--budget",
            str(budget),
            "--query-limit",
            str(args.query_limit),
            "--recall-mode",
            args.recall_mode,
            "--answerer",
            args.answerer,
            "--out-file",
            str(args.out_dir / f"{stem}.real.json"),
            "--progress-file",
            str(args.out_dir / f"{stem}.progress.jsonl"),
        ]
        if args.limit_questions is not None:
            command.extend(["--limit-questions", str(args.limit_questions)])
        print(f"[qa-budget-grid] running budget={budget} query_limit={args.query_limit}", flush=True)
        subprocess.run(command, check=True)


if __name__ == "__main__":
    main()
