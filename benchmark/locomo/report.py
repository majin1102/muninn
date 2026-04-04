from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from benchmark.locomo.scoring import score_qa

MAX_EXAMPLES = 10


def build_error_report(
    samples: list[dict[str, Any]],
    model_key_by_pipeline: dict[str, dict[str, str]],
) -> dict[str, Any]:
    pipelines: dict[str, Any] = {}
    scored_by_pipeline: dict[str, dict[str, dict[tuple[str, int], dict[str, Any]]]] = {}

    for pipeline, model_key_by_mode in sorted(model_key_by_pipeline.items()):
        pipeline_report = {"modes": {}}
        scored_by_pipeline[pipeline] = {}
        for mode, model_key in sorted(model_key_by_mode.items()):
            prediction_key = f"{model_key}_prediction"
            rows = _score_rows(samples, prediction_key)
            scored_by_pipeline[pipeline][mode] = {
                (row["sample_id"], row["qa_index"]): row for row in rows
            }
            pipeline_report["modes"][mode] = {
                "model_key": model_key,
                "qa_count": len(rows),
                "top_recall_misses": _top_recall_misses(rows),
                "top_extraction_misses": _top_extraction_misses(rows),
                "top_adversarial_conflicts": _top_adversarial_conflicts(rows),
            }
        pipelines[pipeline] = pipeline_report

    report: dict[str, Any] = {"pipelines": pipelines}
    oracle_rows = scored_by_pipeline.get("oracle", {})
    generated_rows = scored_by_pipeline.get("generated", {})
    shared_modes = sorted(set(oracle_rows) & set(generated_rows))
    if shared_modes:
        report["oracle_vs_generated_delta"] = {
            "modes": {
                mode: _build_mode_delta(
                    oracle_rows[mode],
                    generated_rows[mode],
                )
                for mode in shared_modes
            }
        }
    return report


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


def _build_mode_delta(
    oracle_rows: dict[tuple[str, int], dict[str, Any]],
    generated_rows: dict[tuple[str, int], dict[str, Any]],
) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    shared_keys = sorted(set(oracle_rows) & set(generated_rows))
    for sample_id, qa_index in shared_keys:
        oracle = oracle_rows[(sample_id, qa_index)]
        generated = generated_rows[(sample_id, qa_index)]
        rows.append(
            {
                "sample_id": sample_id,
                "qa_index": qa_index,
                "question": oracle["question"],
                "category": oracle["category"],
                "oracle_prediction": oracle["prediction"],
                "generated_prediction": generated["prediction"],
                "oracle_f1": oracle["f1"],
                "generated_f1": generated["f1"],
                "f1_delta": round(generated["f1"] - oracle["f1"], 4),
                "oracle_recall": oracle["recall"],
                "generated_recall": generated["recall"],
                "recall_delta": round(generated["recall"] - oracle["recall"], 4),
                "oracle_contexts": oracle["contexts"],
                "generated_contexts": generated["contexts"],
            }
        )
    rows.sort(
        key=lambda row: (
            row["f1_delta"],
            row["recall_delta"],
            row["sample_id"],
            row["qa_index"],
        )
    )
    return {
        "qa_count": len(shared_keys),
        "top_deltas": rows[:MAX_EXAMPLES],
    }
