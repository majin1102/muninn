from __future__ import annotations

import json
import re
import string
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class ScoredQA:
    question: str
    category: int
    prediction: str
    recall: float
    f1: float
    evidence: list[str]
    contexts: list[str]
    adversarial_answer: str | None
    adversarial_match: bool


def _as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    return [value]


def _normalize_optional_answer(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text if text else None


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


def is_negative_answer(prediction: str) -> bool:
    lowered = prediction.lower()
    return "not mentioned" in lowered or "no information available" in lowered


def score_qa(qa: dict[str, Any], prediction_key: str) -> ScoredQA:
    prediction = str(qa.get(prediction_key, "")).strip()
    category = int(qa["category"])

    context_key = f"{prediction_key}_context"
    contexts = [str(context) for context in _as_list(qa.get(context_key, []))]
    evidence = [str(item) for item in _as_list(qa.get("evidence", []))]
    if contexts and evidence:
        if contexts and all(context.startswith("S") for context in contexts):
            recall = _summary_recall(contexts, evidence)
        else:
            recall = sum(ev in contexts for ev in evidence) / len(evidence)
    elif evidence:
        recall = 0.0
    else:
        recall = 1.0

    adversarial_answer = _normalize_optional_answer(qa.get("adversarial_answer"))
    adversarial_match = bool(
        adversarial_answer
        and normalize_answer(prediction) == normalize_answer(adversarial_answer)
    )

    if category in {2, 3, 4}:
        answer = str(qa.get("answer", "")).split(";")[0].strip()
        score = f1_score(prediction, answer)
    elif category == 1:
        answer = str(qa.get("answer", "")).strip()
        score = multi_answer_f1(prediction, answer)
    elif category == 5:
        score = 1.0 if is_negative_answer(prediction) and recall == 0.0 and not adversarial_match else 0.0
    else:
        raise ValueError(f"unsupported category: {category}")

    return ScoredQA(
        question=str(qa.get("question", "")),
        category=category,
        prediction=prediction,
        recall=recall,
        f1=score,
        evidence=evidence,
        contexts=contexts,
        adversarial_answer=adversarial_answer,
        adversarial_match=adversarial_match,
    )


def _summary_recall(contexts: list[str], evidence: list[str]) -> float:
    summary_sessions = {
        context[1:]
        for context in contexts
        if context.startswith("S") and len(context) > 1
    }
    if not summary_sessions:
        return 0.0

    evidence_sessions = {
        session_id
        for item in evidence
        if (session_id := evidence_session_id(item)) is not None
    }
    if not evidence_sessions:
        return 0.0

    hits = summary_sessions & evidence_sessions
    if not hits:
        return 0.0

    precision = len(hits) / len(summary_sessions)
    recall = len(hits) / len(evidence_sessions)
    return (2 * precision * recall) / (precision + recall)


def evidence_session_id(evidence_id: str) -> str | None:
    if ":" not in evidence_id:
        return None
    prefix = evidence_id.split(":", 1)[0]
    if len(prefix) <= 1:
        return None
    return prefix[1:]


def score_qas(qas: list[dict[str, Any]], prediction_key: str) -> list[ScoredQA]:
    return [score_qa(qa, prediction_key) for qa in qas]


def evaluate_question_answering(qas: list[dict[str, Any]], prediction_key: str) -> tuple[list[float], list[float]]:
    rows = score_qas(qas, prediction_key)
    return [row.f1 for row in rows], [row.recall for row in rows]


def summarize_question_answering(
    qas: list[dict[str, Any]],
    prediction_key: str,
    model_key: str,
) -> dict[str, Any]:
    rows = score_qas(qas, prediction_key)
    category_scores: dict[str, list[float]] = defaultdict(list)
    category_recall: dict[str, list[float]] = defaultdict(list)
    for row, qa in zip(rows, qas):
        category = str(qa["category"])
        category_scores[category].append(row.f1)
        category_recall[category].append(row.recall)

    scores = [row.f1 for row in rows]
    recall = [row.recall for row in rows]
    return {
        "model_key": model_key,
        "qa_count": len(rows),
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


def build_stats(samples: list[dict[str, Any]], model_key: str) -> dict[str, Any]:
    prediction_key = f"{model_key}_prediction"
    flat_qas = [qa for sample in samples for qa in sample["qa"] if prediction_key in qa]
    return summarize_question_answering(flat_qas, prediction_key, model_key)


def write_results(out_file: Path, samples: list[dict[str, Any]], stats: dict[str, Any]) -> None:
    out_file.parent.mkdir(parents=True, exist_ok=True)
    out_file.write_text(f"{json.dumps(samples, indent=2)}\n", encoding="utf8")
    stats_file = out_file.with_name(f"{out_file.stem}_stats.json")
    stats_file.write_text(f"{json.dumps(stats, indent=2)}\n", encoding="utf8")
