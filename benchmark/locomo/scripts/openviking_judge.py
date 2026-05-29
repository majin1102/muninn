from __future__ import annotations

import argparse
import json
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
import sys
from typing import Any, Iterable

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from benchmark.locomo.answering import (
    extract_codex_stream_text,
    extract_responses_text,
    load_answerer_config,
    load_codex_access_token,
    normalize_api_style,
    normalize_chat_completions_url,
    normalize_codex_responses_url,
    read_with_retries,
)


@dataclass(frozen=True)
class JudgeItem:
    sample_id: str
    qa_index: int
    category: int
    question: str
    gold_answer: str
    generated_answer: str
    adversarial_answer: str | None = None


def build_accuracy_prompt(*, question: str, gold_answer: str, response: str) -> str:
    return f"""
    Your task is to label an answer to a question as 'CORRECT' or 'WRONG'. You will be given the following data:
        (1) a question (posed by one user to another user),
        (2) a 'gold' (ground truth) answer,
        (3) a generated answer
    which you will score as CORRECT/WRONG.

    The point of the question is to ask about something one user should know about the other user based on their prior conversations.
    The gold answer will usually be a concise and short answer that includes the referenced topic, for example:
    Question: Do you remember what I got the last time I went to Hawaii?
    Gold answer: A shell necklace
    The generated answer might be much longer, but you should be generous with your grading - as long as it touches on the same topic as the gold answer, it should be counted as CORRECT.

    For time related questions, the gold answer will be a specific date, month, year, etc. The generated answer might be much longer or use relative time references (like "last Tuesday" or "next month"), but you should be generous with your grading - as long as it refers to the same date or time period as the gold answer, it should be counted as CORRECT. Even if the format differs (e.g., "May 7th" vs "7 May"), consider it CORRECT if it's the same date.

    Now it's time for the real question:
    Question: {question}
    Gold answer: {gold_answer}
    Generated answer: {response}

    First, provide a short (one sentence) explanation of your reasoning, then finish with CORRECT or WRONG.
    Do NOT include both CORRECT and WRONG in your response, or it will break the evaluation script.

    Respond with JSON only: {{"is_correct": "CORRECT" or "WRONG", "reasoning": "your explanation"}}
    """


def build_system_prompt() -> str:
    return "You are an expert grader that determines if answers to questions match a gold standard answer"


def iter_judge_items(samples: list[dict[str, Any]], prediction_key: str | None) -> Iterable[JudgeItem]:
    for sample in samples:
        sample_id = str(sample.get("sample_id") or "")
        qa_list = sample.get("qa")
        if not isinstance(qa_list, list):
            continue
        for index, qa in enumerate(qa_list):
            if not isinstance(qa, dict) or qa.get("category") == 5:
                continue
            key = prediction_key or first_prediction_key(qa)
            if not key:
                continue
            yield JudgeItem(
                sample_id=sample_id,
                qa_index=index,
                category=int(qa.get("category") or 0),
                question=str(qa.get("question") or ""),
                gold_answer=str(qa.get("answer") or ""),
                generated_answer=str(qa.get(key) or "").strip(),
                adversarial_answer=optional_str(qa.get("adversarial_answer")),
            )


def first_prediction_key(qa: dict[str, Any]) -> str | None:
    for key in qa:
        if key.endswith("_prediction") and not key.endswith("heuristic_prediction"):
            return key
    return None


def optional_str(value: Any) -> str | None:
    return value if isinstance(value, str) and value.strip() else None


def parse_judge_response(raw: str) -> tuple[bool, str]:
    start = raw.find("{")
    end = raw.rfind("}")
    if start < 0 or end < start:
        raise ValueError(f"judge response did not contain JSON: {raw}")
    parsed = json.loads(raw[start : end + 1])
    result = str(parsed.get("is_correct") or "WRONG").strip().upper()
    return result == "CORRECT", str(parsed.get("reasoning") or "")


def judge_item(item: JudgeItem, config: dict[str, Any]) -> dict[str, Any]:
    raw = call_llm(
        config,
        system=build_system_prompt(),
        prompt=build_accuracy_prompt(
            question=item.question,
            gold_answer=item.gold_answer,
            response=item.generated_answer,
        ),
    )
    correct, reasoning = parse_judge_response(raw)
    return {
        "sample_id": item.sample_id,
        "qa_index": item.qa_index,
        "category": item.category,
        "question": item.question,
        "gold_answer": item.gold_answer,
        "generated_answer": item.generated_answer,
        "adversarial_answer": item.adversarial_answer,
        "result": "CORRECT" if correct else "WRONG",
        "reasoning": reasoning,
    }


def call_llm(config: dict[str, Any], *, system: str, prompt: str) -> str:
    provider = str(config.get("provider") or "").strip()
    if provider == "mock":
        return '{"is_correct":"CORRECT","reasoning":"mock"}'
    if provider == "openai-codex":
        return call_openai_codex(config, system=system, prompt=prompt)
    if provider == "openai":
        return call_openai(config, system=system, prompt=prompt)
    raise ValueError(f"unsupported judge provider: {provider}")


def call_openai(config: dict[str, Any], *, system: str, prompt: str) -> str:
    api_key = str(config.get("apiKey") or "").strip()
    if not api_key:
        raise ValueError("judge requires apiKey for openai provider")
    api_style = normalize_api_style(config.get("api"))
    model = str(config.get("model") or "gpt-5.4")
    if api_style == "chat_completions":
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0,
        }
        base_url = str(config.get("baseUrl") or "https://api.openai.com/v1/chat/completions")
        url = normalize_chat_completions_url(base_url)
    else:
        payload = {
            "model": model,
            "input": [
                {"role": "system", "content": [{"type": "input_text", "text": system}]},
                {"role": "user", "content": [{"type": "input_text", "text": prompt}]},
            ],
        }
        url = str(config.get("baseUrl") or "https://api.openai.com/v1/responses")
    raw = read_with_retries(
        lambda: urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf8"),
            headers={
                "authorization": f"Bearer {api_key}",
                "content-type": "application/json",
            },
            method="POST",
        ),
        "OpenViking judge request",
    )
    return extract_text(json.loads(raw), api_style)


def call_openai_codex(config: dict[str, Any], *, system: str, prompt: str) -> str:
    token = load_codex_access_token()
    base_url = str(config.get("baseUrl") or "https://chatgpt.com/backend-api")
    payload = {
        "model": str(config.get("model") or "gpt-5.4"),
        "instructions": system,
        "store": False,
        "stream": True,
        "input": [{"role": "user", "content": [{"type": "input_text", "text": prompt}]}],
    }
    raw = read_with_retries(
        lambda: urllib.request.Request(
            normalize_codex_responses_url(base_url),
            data=json.dumps(payload).encode("utf8"),
            headers={
                "authorization": f"Bearer {token}",
                "content-type": "application/json",
            },
            method="POST",
        ),
        "OpenViking openai-codex judge request",
    )
    text = extract_codex_stream_text(raw)
    if not text:
        raise RuntimeError("OpenViking judge response did not contain text")
    return text


def extract_text(payload: dict[str, Any], api_style: str) -> str:
    if api_style == "chat_completions":
        choices = payload.get("choices")
        if isinstance(choices, list) and choices:
            message = choices[0].get("message") if isinstance(choices[0], dict) else None
            text = message.get("content") if isinstance(message, dict) else None
            if isinstance(text, str) and text.strip():
                return text
    else:
        text = payload.get("output_text")
        if isinstance(text, str) and text.strip():
            return text
        extracted = extract_responses_text(payload)
        if extracted:
            return extracted
    raise RuntimeError("judge response did not contain text")


def summarize(source: str, items: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(items)
    correct = sum(1 for item in items if item["result"] == "CORRECT")
    by_category: dict[str, dict[str, Any]] = {}
    for item in items:
        bucket = by_category.setdefault(str(item["category"]), {"total": 0, "correct": 0})
        bucket["total"] += 1
        if item["result"] == "CORRECT":
            bucket["correct"] += 1
    for bucket in by_category.values():
        bucket["accuracy"] = round(bucket["correct"] / bucket["total"], 4) if bucket["total"] else 0.0
    return {
        "source": source,
        "standard": "openviking_locomo_accuracy",
        "excluded_categories": [5],
        "items": items,
        "accuracy": {
            "correct": correct,
            "total": total,
            "accuracy": round(correct / total, 4) if total else 0.0,
        },
        "category": by_category,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Score LoCoMo answers with OpenViking's LoCoMo accuracy judge.")
    parser.add_argument("input_result", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--prediction-key")
    parser.add_argument("--home", type=Path, default=Path.cwd())
    parser.add_argument("--parallel", type=int, default=5)
    args = parser.parse_args()

    samples = json.loads(args.input_result.read_text(encoding="utf8"))
    config = load_answerer_config(args.home)
    items = list(iter_judge_items(samples, args.prediction_key))
    judged: list[dict[str, Any] | None] = [None] * len(items)
    with ThreadPoolExecutor(max_workers=max(1, args.parallel)) as executor:
        futures = {
            executor.submit(judge_item, item, config): index
            for index, item in enumerate(items)
        }
        for count, future in enumerate(as_completed(futures), start=1):
            judged[futures[future]] = future.result()
            if count == 1 or count % 10 == 0:
                print(f"[openviking_judge] {count}/{len(items)}", flush=True)
            time.sleep(0.01)
    summary = summarize(str(args.input_result), [item for item in judged if item is not None])
    args.output.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf8")
    print(json.dumps(summary["accuracy"], indent=2), flush=True)


if __name__ == "__main__":
    main()
