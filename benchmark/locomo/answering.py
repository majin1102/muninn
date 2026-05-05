from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from base64 import urlsafe_b64decode
from pathlib import Path
from typing import Any

from benchmark.common.muninn_bridge import RecallHit
from benchmark.locomo.scoring import score_qa


SYSTEM_PROMPT = (
    "You answer LoCoMo benchmark questions using only the provided Muninn "
    "memory context. Return JSON only with answer, memory_clarity_score, "
    "and memory_clarity_reason."
)
MIN_CODEX_TOKEN_TTL_SECONDS = 24 * 60 * 60


def build_answer_context(
    *,
    question: str,
    category: int,
    hits: list[RecallHit],
    expand_references: bool,
) -> str:
    lines = [
        f"Question: {question}",
        f"Category: {category}",
        "Related Memories:",
    ]
    if not hits:
        lines.append("- No related memories were retrieved.")
        return "\n".join(lines)

    for index, hit in enumerate(hits, start=1):
        lines.extend(
            [
                f"- HIT {index}",
                f"  DATE: {hit.date_time or '(unknown)'}",
                f"  MEMORY_ID: {hit.memory_id}",
                f"  MEMORY: {hit.matched_text or hit.summary or hit.detail or hit.title or ''}",
                f"  EVIDENCE_IDS: {', '.join(hit.evidence_ids) if hit.evidence_ids else '(none)'}",
            ]
        )

    return "\n".join(lines)


def build_qa_trace(
    *,
    sample_id: str,
    qa_index: int,
    qa: dict[str, Any],
    query_candidates: list[str],
    prediction_key: str,
    heuristic_key: str,
    gateway_routes: dict[str, list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    scored = score_qa(qa, prediction_key)
    hits = list(qa.get(f"{prediction_key.removesuffix('_prediction')}_hits", []))
    if gateway_routes:
        for hit in hits:
            memory_id = str(hit.get("memory_id", ""))
            routes = gateway_routes.get(memory_id)
            if routes:
                hit["gateway_routes"] = routes
    return {
        "sample_id": sample_id,
        "qa_index": qa_index,
        "question": scored.question,
        "category": scored.category,
        "gold_answer": qa.get("answer"),
        "evidence": scored.evidence,
        "query_candidates": query_candidates,
        "hits": hits,
        "answer_context": qa.get(f"{prediction_key.removesuffix('_prediction')}_answer_context", ""),
        "prediction": scored.prediction,
        "heuristic_prediction": qa.get(heuristic_key, ""),
        "memory_clarity_score": qa.get(f"{prediction_key.removesuffix('_prediction')}_memory_clarity_score"),
        "memory_clarity_reason": qa.get(f"{prediction_key.removesuffix('_prediction')}_memory_clarity_reason"),
        "answer_elapsed_s": qa.get(f"{prediction_key.removesuffix('_prediction')}_answer_elapsed_s"),
        "f1": round(scored.f1, 4),
        "recall": round(scored.recall, 4),
        "adversarial_answer": scored.adversarial_answer,
        "adversarial_match": scored.adversarial_match,
    }


def load_answerer_config(home: Path) -> dict[str, Any]:
    config_path = home / "muninn.json"
    config = json.loads(config_path.read_text(encoding="utf8"))
    observer = config.get("observer") if isinstance(config, dict) else None
    if not isinstance(observer, dict) or not isinstance(observer.get("llm"), str):
        raise ValueError("LoCoMo LLM answerer requires observer.llm in muninn.json")
    llms = config.get("llm")
    llm = llms.get(observer["llm"]) if isinstance(llms, dict) else None
    if not isinstance(llm, dict):
        raise ValueError(f"LoCoMo LLM answerer requires llm.{observer['llm']} in muninn.json")
    provider = llm.get("provider")
    if not isinstance(provider, str) or not provider.strip():
        raise ValueError(f"LoCoMo LLM answerer requires llm.{observer['llm']}.provider in muninn.json")
    return dict(llm)


def run_llm_answerer(
    *,
    question: str,
    category: int,
    answer_context: str,
    config: dict[str, Any],
) -> dict[str, Any]:
    provider = str(config.get("provider", "")).strip()
    if provider == "mock":
        return {
            "answer": "Mock answer",
            "memory_clarity_score": 1,
            "memory_clarity_reason": "Mock answerer did not evaluate memory clarity.",
        }
    if provider == "openai-codex":
        return run_openai_codex_answerer(
            question=question,
            category=category,
            answer_context=answer_context,
            config=config,
        )
    if provider != "openai":
        raise ValueError(f"unsupported LoCoMo answerer provider: {provider}")

    api_key = str(config.get("apiKey", "")).strip()
    if not api_key:
        raise ValueError("LoCoMo LLM answerer requires apiKey for openai provider")
    api_style = normalize_api_style(config.get("api"))
    base_url = str(
        config.get("baseUrl")
        or (
            "https://api.openai.com/v1/chat/completions"
            if api_style == "chat_completions"
            else "https://api.openai.com/v1/responses"
        )
    )
    payload = build_openai_payload(
        api_style=api_style,
        model=str(config.get("model") or "gpt-5.4-mini"),
        question=question,
        category=category,
        answer_context=answer_context,
    )
    request = urllib.request.Request(
        normalize_chat_completions_url(base_url) if api_style == "chat_completions" else base_url,
        data=json.dumps(payload).encode("utf8"),
        headers={
            "authorization": f"Bearer {api_key}",
            "content-type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            raw = response.read().decode("utf8")
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf8", errors="replace")
        raise RuntimeError(f"LoCoMo answerer request failed with status {error.code}: {detail}") from error
    return extract_answer(json.loads(raw), api_style)


def run_openai_codex_answerer(
    *,
    question: str,
    category: int,
    answer_context: str,
    config: dict[str, Any],
) -> dict[str, Any]:
    token = load_codex_access_token()
    base_url = str(config.get("baseUrl") or "https://chatgpt.com/backend-api")
    payload = build_openai_payload(
        api_style="responses",
        model=str(config.get("model") or "gpt-5.4"),
        question=question,
        category=category,
        answer_context=answer_context,
    )
    payload["instructions"] = SYSTEM_PROMPT
    payload["store"] = False
    payload["stream"] = True
    payload["input"] = [
        item
        for item in payload["input"]
        if isinstance(item, dict) and item.get("role") != "system"
    ]
    request = urllib.request.Request(
        normalize_codex_responses_url(base_url),
        data=json.dumps(payload).encode("utf8"),
        headers={
            "authorization": f"Bearer {token}",
            "content-type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            raw = response.read().decode("utf8")
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf8", errors="replace")
        raise RuntimeError(f"LoCoMo openai-codex answerer request failed with status {error.code}: {detail}") from error
    text = extract_codex_stream_text(raw)
    if not text:
        raise RuntimeError("LoCoMo openai-codex answerer response did not contain text")
    return parse_answer_text(text)


def load_codex_access_token(now: float | None = None) -> str:
    auth_path = resolve_codex_home() / "auth.json"
    try:
        auth = json.loads(auth_path.read_text(encoding="utf8"))
    except OSError as error:
        raise RuntimeError(f"Could not read Codex CLI auth at {auth_path}. Run `codex login`. {error}") from error
    except json.JSONDecodeError as error:
        raise RuntimeError(f"Codex CLI auth at {auth_path} is invalid JSON: {error}") from error
    if not isinstance(auth, dict):
        raise RuntimeError(f"Codex CLI auth at {auth_path} must be a JSON object.")
    if auth.get("auth_mode") != "chatgpt":
        raise RuntimeError("Codex CLI auth must use ChatGPT login. Run `codex login` and sign in with ChatGPT.")
    tokens = auth.get("tokens")
    access_token = tokens.get("access_token") if isinstance(tokens, dict) else None
    if not isinstance(access_token, str) or not access_token.strip():
        raise RuntimeError("Codex CLI auth is missing tokens.access_token. Run `codex login` again.")
    expires_at = jwt_expiry_seconds(access_token.strip())
    if expires_at is None:
        raise RuntimeError("Codex CLI auth token is not a JWT with an exp claim. Run `codex login` again.")
    current = now if now is not None else time.time()
    if expires_at - current < MIN_CODEX_TOKEN_TTL_SECONDS:
        raise RuntimeError("Codex CLI auth token expires within 24 hours. Run `codex login` again before starting the benchmark.")
    return access_token.strip()


def resolve_codex_home() -> Path:
    configured = os.environ.get("CODEX_HOME", "").strip()
    if not configured:
        return Path.home() / ".codex"
    if configured == "~":
        return Path.home()
    if configured.startswith("~/"):
        return Path.home() / configured[2:]
    return Path(configured).resolve()


def jwt_expiry_seconds(token: str) -> float | None:
    parts = token.split(".")
    if len(parts) != 3 or not parts[1]:
        return None
    padded = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        payload = json.loads(urlsafe_b64decode(padded.encode("utf8")).decode("utf8"))
    except (ValueError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    exp = payload.get("exp")
    return float(exp) if isinstance(exp, (int, float)) else None


def build_openai_payload(
    *,
    api_style: str,
    model: str,
    question: str,
    category: int,
    answer_context: str,
) -> dict[str, Any]:
    user_prompt = (
        f"{answer_context}\n\n"
        f"Question: {question}\n"
        f"Category: {category}\n"
        "Answer based on Related Memories. "
        "Use the shortest direct answer that answers the question; put evidence and reasoning in memory_clarity_reason. "
        "For dates, years, names, places, or short phrases, output only the factual span itself with no prepositions or full sentence. "
        "If the question is subjective or interpretive, a reasonable inference is allowed when supported by the memory context. "
        "If the memory context is insufficient, answer \"Not mentioned in the conversation\". "
        "Rate memory_clarity_score from 1 to 10 based on the clarity of the memory evidence. "
        "Return JSON only: {\"answer\":\"...\",\"memory_clarity_score\":1,\"memory_clarity_reason\":\"...\"}."
    )
    if api_style == "chat_completions":
        return {
            "model": model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
        }
    return {
        "model": model,
        "input": [
            {"role": "system", "content": [{"type": "input_text", "text": SYSTEM_PROMPT}]},
            {"role": "user", "content": [{"type": "input_text", "text": user_prompt}]},
        ],
    }


def extract_answer(payload: dict[str, Any], api_style: str) -> dict[str, Any]:
    if api_style == "chat_completions":
        choices = payload.get("choices")
        if not isinstance(choices, list) or not choices:
            raise RuntimeError("LoCoMo answerer response did not contain choices")
        message = choices[0].get("message") if isinstance(choices[0], dict) else None
        raw = message.get("content") if isinstance(message, dict) else None
    else:
        raw = payload.get("output_text")
        if not isinstance(raw, str) or not raw.strip():
            raw = extract_responses_text(payload)
    if not isinstance(raw, str) or not raw.strip():
        raise RuntimeError("LoCoMo answerer response did not contain text")
    return parse_answer_text(raw)


def extract_responses_text(payload: dict[str, Any]) -> str:
    output = payload.get("output")
    fragments: list[str] = []
    if isinstance(output, list):
        for item in output:
            if not isinstance(item, dict):
                continue
            content = item.get("content")
            if not isinstance(content, list):
                continue
            for fragment in content:
                if isinstance(fragment, dict) and fragment.get("type") == "output_text":
                    text = fragment.get("text")
                    if isinstance(text, str) and text.strip():
                        fragments.append(text)
    return "\n\n".join(fragments)


def parse_answer_text(raw: str) -> dict[str, Any]:
    text = raw.strip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return {"answer": text, "memory_clarity_score": None, "memory_clarity_reason": ""}
    if isinstance(parsed, dict) and isinstance(parsed.get("answer"), str):
        return {
            "answer": parsed["answer"].strip(),
            "memory_clarity_score": normalize_clarity_score(parsed.get("memory_clarity_score")),
            "memory_clarity_reason": str(parsed.get("memory_clarity_reason") or "").strip(),
        }
    return {"answer": text, "memory_clarity_score": None, "memory_clarity_reason": ""}


def normalize_clarity_score(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return min(10, max(1, value))
    if isinstance(value, float):
        return min(10, max(1, round(value)))
    if isinstance(value, str) and value.strip().isdigit():
        return min(10, max(1, int(value.strip())))
    return None


def normalize_api_style(api: Any) -> str:
    return "chat_completions" if api in {"openai-completions", "chat_completions", "chat-completions"} else "responses"


def normalize_chat_completions_url(base_url: str) -> str:
    return base_url if base_url.endswith("/chat/completions") else f"{base_url.rstrip('/')}/chat/completions"


def normalize_codex_responses_url(base_url: str) -> str:
    resolved = base_url.rstrip("/")
    if resolved in {
        "https://chatgpt.com/backend-api",
        "https://chatgpt.com/backend-api/responses",
    }:
        return "https://chatgpt.com/backend-api/codex/responses"
    return resolved if resolved.endswith("/responses") else f"{resolved}/responses"


def extract_codex_stream_text(raw: str) -> str:
    fragments: list[str] = []
    completed: dict[str, Any] | None = None
    for event in parse_sse_events(raw):
        event_type = event.get("type")
        if isinstance(event_type, str) and event_type.endswith("output_text.delta"):
            delta = event.get("delta")
            if isinstance(delta, str):
                fragments.append(delta)
        if event_type == "response.completed":
            response = event.get("response")
            if isinstance(response, dict):
                completed = response
    if completed is not None:
        text = extract_responses_text(completed)
        if text:
            return text
    return "".join(fragments).strip()


def parse_sse_events(raw: str) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for chunk in raw.split("\n\n"):
        data = "\n".join(
            line[len("data:") :].strip()
            for line in chunk.splitlines()
            if line.startswith("data:")
        ).strip()
        if not data or data == "[DONE]":
            continue
        parsed = json.loads(data)
        if isinstance(parsed, dict):
            events.append(parsed)
    return events
