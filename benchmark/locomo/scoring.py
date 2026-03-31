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


def evaluate_question_answering(qas: list[dict[str, Any]], prediction_key: str) -> tuple[list[float], list[float]]:
    all_scores: list[float] = []
    all_recall: list[float] = []
    context_key = f"{prediction_key}_context"

    for qa in qas:
        prediction = str(qa.get(prediction_key, "")).strip()
        category = int(qa["category"])
        if category in {2, 3, 4}:
            answer = str(qa.get("answer", "")).split(";")[0].strip()
            score = f1_score(prediction, answer)
        elif category == 1:
            answer = str(qa.get("answer", "")).strip()
            score = multi_answer_f1(prediction, answer)
        elif category == 5:
            lowered = prediction.lower()
            score = 1.0 if ("not mentioned" in lowered or "no information available" in lowered) else 0.0
        else:
            raise ValueError(f"unsupported category: {category}")

        contexts = qa.get(context_key, [])
        evidence = qa.get("evidence", [])
        if contexts and evidence:
            if contexts[0].startswith("S"):
                sessions = {context[1:] for context in contexts}
                recall = sum(ev.split(":")[0][1:] in sessions for ev in evidence) / len(evidence)
            else:
                recall = sum(ev in contexts for ev in evidence) / len(evidence)
        else:
            recall = 1.0

        all_scores.append(score)
        all_recall.append(recall)

    return all_scores, all_recall


def build_stats(
    samples: list[dict[str, Any]],
    model_key_by_mode: dict[str, str],
) -> dict[str, Any]:
    stats: dict[str, Any] = {"modes": {}}
    for mode, model_key in model_key_by_mode.items():
        prediction_key = f"{model_key}_prediction"
        flat_qas = [qa for sample in samples for qa in sample["qa"] if prediction_key in qa]
        scores, recall = evaluate_question_answering(flat_qas, prediction_key)

        category_scores: dict[str, list[float]] = defaultdict(list)
        category_recall: dict[str, list[float]] = defaultdict(list)
        for qa, score_value, recall_value in zip(flat_qas, scores, recall):
            category = str(qa["category"])
            category_scores[category].append(score_value)
            category_recall[category].append(recall_value)

        stats["modes"][mode] = {
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
    return stats


def write_results(out_file: Path, samples: list[dict[str, Any]], stats: dict[str, Any]) -> None:
    out_file.parent.mkdir(parents=True, exist_ok=True)
    out_file.write_text(f"{json.dumps(samples, indent=2)}\n", encoding="utf8")
    stats_file = out_file.with_name(f"{out_file.stem}_stats.json")
    stats_file.write_text(f"{json.dumps(stats, indent=2)}\n", encoding="utf8")
