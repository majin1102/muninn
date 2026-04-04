from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from benchmark.locomo.scoring import score_qa

MAX_EXAMPLES = 10


def build_error_report(
    samples: list[dict[str, Any]],
    model_key: str,
) -> dict[str, Any]:
    prediction_key = f"{model_key}_prediction"
    rows = _score_rows(samples, prediction_key)
    return {
        "model_key": model_key,
        "qa_count": len(rows),
        "top_recall_misses": _top_recall_misses(rows),
        "top_extraction_misses": _top_extraction_misses(rows),
        "top_adversarial_conflicts": _top_adversarial_conflicts(rows),
    }


def write_report(out_file: Path, report: dict[str, Any]) -> None:
    report_file = out_file.with_name(f"{out_file.stem}_report.json")
    report_file.parent.mkdir(parents=True, exist_ok=True)
    report_file.write_text(f"{json.dumps(report, indent=2)}\n", encoding="utf8")


def _score_rows(
    samples: list[dict[str, Any]],
    prediction_key: str,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for sample in samples:
        sample_id = str(sample.get("sample_id", ""))
        for qa_index, qa in enumerate(sample.get("qa", [])):
            if prediction_key not in qa:
                continue
            scored = score_qa(qa, prediction_key)
            rows.append(
                {
                    "sample_id": sample_id,
                    "qa_index": qa_index,
                    "question": scored.question,
                    "category": scored.category,
                    "prediction": scored.prediction,
                    "f1": round(scored.f1, 4),
                    "recall": round(scored.recall, 4),
                    "evidence": scored.evidence,
                    "contexts": scored.contexts,
                    "adversarial_answer": scored.adversarial_answer,
                    "adversarial_match": scored.adversarial_match,
                }
            )
    return rows


def _top_recall_misses(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    misses = [
        row
        for row in rows
        if row["evidence"] and row["recall"] < 1.0
    ]
    misses.sort(
        key=lambda row: (
            row["recall"],
            row["f1"],
            row["sample_id"],
            row["qa_index"],
        )
    )
    return misses[:MAX_EXAMPLES]


def _top_extraction_misses(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    misses = [
        row
        for row in rows
        if row["evidence"] and row["recall"] >= 0.999 and row["f1"] < 1.0
    ]
    misses.sort(
        key=lambda row: (
            row["f1"],
            -row["recall"],
            row["sample_id"],
            row["qa_index"],
        )
    )
    return misses[:MAX_EXAMPLES]


def _top_adversarial_conflicts(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    conflicts = [
        row
        for row in rows
        if row["adversarial_answer"] and row["adversarial_match"]
    ]
    conflicts.sort(
        key=lambda row: (
            row["recall"],
            row["f1"],
            row["sample_id"],
            row["qa_index"],
        )
    )
    return conflicts[:MAX_EXAMPLES]
