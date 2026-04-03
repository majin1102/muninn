from __future__ import annotations

import json
import re
import string
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


def normalize_answer(value: str) -> str:
    value = value.replace(",", "")
    lowered = value.lower()
    lowered = re.sub(r"\b(a|an|the|and)\b", " ", lowered)
    lowered = "".join(ch for ch in lowered if ch not in string.punctuation)
    return " ".join(lowered.split())


def f1_score(prediction: str, ground_truth: str) -> float:
    prediction_tokens = normalize_answer(prediction).split()
    ground_truth_tokens = normalize_answer(ground_truth).split()
    if not prediction_tokens or not ground_truth_tokens:
        return 0.0
    common = Counter(prediction_tokens) & Counter(ground_truth_tokens)
    num_same = sum(common.values())
    if num_same == 0:
        return 0.0
    precision = num_same / len(prediction_tokens)
    recall = num_same / len(ground_truth_tokens)
    return (2 * precision * recall) / (precision + recall)


def multi_answer_f1(prediction: str, ground_truth: str) -> float:
    prediction_items = [item.strip() for item in prediction.split(",") if item.strip()]
    ground_truth_items = [item.strip() for item in ground_truth.split(",") if item.strip()]
    if not prediction_items or not ground_truth_items:
        return 0.0
    return sum(
        max(f1_score(candidate, truth) for candidate in prediction_items)
        for truth in ground_truth_items
    ) / len(ground_truth_items)


def score_prediction(qa: dict[str, Any], prediction: str) -> float:
    prediction = prediction.strip()
    category = int(qa["category"])
    if category in {2, 3, 4}:
        answer = str(qa.get("answer", "")).split(";")[0].strip()
        return f1_score(prediction, answer)
    if category == 1:
        answer = str(qa.get("answer", "")).strip()
        return multi_answer_f1(prediction, answer)
    if category == 5:
        lowered = prediction.lower()
        return 1.0 if ("not mentioned" in lowered or "no information available" in lowered) else 0.0
    raise ValueError(f"unsupported category: {category}")


def score_recall(recalled_evidence_ids: list[str], evidence: list[str]) -> float:
    if not evidence:
        return 1.0
    if not recalled_evidence_ids:
        return 0.0
    if recalled_evidence_ids[0].startswith("S"):
        recalled_sessions = {context[1:] for context in recalled_evidence_ids}
        return sum(ev.split(":")[0][1:] in recalled_sessions for ev in evidence) / len(evidence)
    return sum(ev in recalled_evidence_ids for ev in evidence) / len(evidence)


def annotate_qa_result(
    qa: dict[str, Any],
    model_key: str,
    prediction: str,
    recalled_evidence_ids: list[str],
) -> None:
    qa[f"{model_key}_prediction"] = prediction
    qa[f"{model_key}_f1"] = round(score_prediction(qa, prediction), 4)
    qa[f"{model_key}_recall"] = round(score_recall(recalled_evidence_ids, qa.get("evidence", [])), 4)


def build_stats(samples: list[dict[str, Any]], model_key: str) -> dict[str, Any]:
    f1_key = f"{model_key}_f1"
    recall_key = f"{model_key}_recall"
    flat_qas = [qa for sample in samples for qa in sample["qa"] if f1_key in qa]

    category_scores: dict[str, list[float]] = defaultdict(list)
    category_recall: dict[str, list[float]] = defaultdict(list)

    for qa in flat_qas:
        category = str(qa["category"])
        score_value = float(qa.get(f1_key, 0.0))
        recall_value = float(qa.get(recall_key, 0.0))
        category_scores[category].append(score_value)
        category_recall[category].append(recall_value)

    scores = [float(qa.get(f1_key, 0.0)) for qa in flat_qas]
    recall = [float(qa.get(recall_key, 0.0)) for qa in flat_qas]

    return {
        "model_key": model_key,
        "qa_count": len(flat_qas),
        "average_f1": round(sum(scores) / len(scores), 4) if scores else 0.0,
        "average_recall": round(sum(recall) / len(recall), 4) if recall else 0.0,
        "category_f1": {
            category: round(sum(values) / len(values), 4)
            for category, values in sorted(category_scores.items())
        },
        "category_recall": {
            category: round(sum(values) / len(values), 4)
            for category, values in sorted(category_recall.items())
        },
    }


def write_results(out_file: Path, samples: list[dict[str, Any]], stats: dict[str, Any]) -> None:
    out_file.parent.mkdir(parents=True, exist_ok=True)
    out_file.write_text(f"{json.dumps(samples, indent=2)}\n", encoding="utf8")
    stats_file = out_file.with_name(f"{out_file.stem}_stats.json")
    stats_file.write_text(f"{json.dumps(stats, indent=2)}\n", encoding="utf8")
