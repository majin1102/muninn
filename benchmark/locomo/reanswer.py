from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

if __package__ is None or __package__ == "":
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from benchmark.common.muninn_bridge import RecallHit
from benchmark.locomo.answering import load_answerer_config
from benchmark.locomo.report import build_error_report, write_report
from benchmark.locomo.run import apply_predictions, build_model_key, build_trace, write_trace
from benchmark.locomo.scoring import build_stats, write_results


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--trace-file", required=True, type=Path)
    parser.add_argument("--home", required=True, type=Path)
    parser.add_argument("--out-file", required=True, type=Path)
    parser.add_argument("--top-k", default=3, type=int)
    parser.add_argument("--expand-references", action="store_true")
    return parser.parse_args(argv)


def main() -> None:
    args = parse_args()
    trace = json.loads(args.trace_file.read_text(encoding="utf8"))
    result = reanswer_trace(
        trace=trace,
        home=args.home,
        top_k=args.top_k,
        expand_references=args.expand_references,
    )
    write_results(args.out_file, result["samples"], result["stats"])
    write_report(args.out_file, result["report"])
    write_trace(args.out_file, result["trace"])


def reanswer_trace(
    *,
    trace: dict[str, Any],
    home: Path,
    top_k: int,
    expand_references: bool,
) -> dict[str, Any]:
    model_key = build_model_key(top_k)
    prediction_key = f"{model_key}_prediction"
    heuristic_key = f"{model_key}_heuristic_prediction"
    samples = samples_from_trace(trace)
    answerer_config = load_answerer_config(home)

    for sample in samples:
        qas = sample["qa"]
        batch_hits = {
            index: [hit_from_trace(item) for item in qa.get("hits", [])]
            for index, qa in enumerate(qas)
        }
        apply_predictions(
            qas,
            batch_hits,
            prediction_key,
            heuristic_key=heuristic_key,
            answerer="llm",
            answerer_config=answerer_config,
            expand_references=expand_references,
        )

    stats = build_stats(samples, model_key)
    return {
        "samples": samples,
        "stats": stats,
        "report": build_error_report(samples, model_key),
        "trace": build_trace(samples, model_key),
    }


def samples_from_trace(trace: dict[str, Any]) -> list[dict[str, Any]]:
    samples: list[dict[str, Any]] = []
    for sample in trace.get("samples", []):
        if not isinstance(sample, dict):
            continue
        qas = [qa_from_trace(item) for item in sample.get("qa", []) if isinstance(item, dict)]
        samples.append({
            "sample_id": str(sample.get("sample_id", "")),
            "qa": qas,
        })
    return samples


def qa_from_trace(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "question": row.get("question", ""),
        "category": row.get("category"),
        "answer": row.get("gold_answer", ""),
        "evidence": row.get("evidence", []),
        "adversarial_answer": row.get("adversarial_answer"),
        "hits": row.get("hits", []),
    }


def hit_from_trace(row: dict[str, Any]) -> RecallHit:
    return RecallHit(
        memory_id=str(row.get("memory_id", "")),
        evidence_ids=[str(value) for value in row.get("evidence_ids", [])],
        detail=row.get("detail"),
        matched_text=str(row.get("matched_text") or ""),
        references=row.get("references") or [],
    )


if __name__ == "__main__":
    main()
