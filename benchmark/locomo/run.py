from __future__ import annotations

import argparse
import copy
import json
import os
import re
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory

if __package__ is None or __package__ == "":
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from benchmark.common.muninn_bridge import MuninnBridge, RecallHit
from benchmark.locomo.dataset import iter_target_samples, load_samples
from benchmark.locomo.heuristics import build_query_candidates
from benchmark.locomo.scoring import annotate_qa_result, build_stats, write_results


SYSTEM_PROMPT = """You answer questions about a remembered conversation.
Use only the provided context.
Keep the answer short and direct.
If the context does not contain the answer, say "Not mentioned in the conversation"."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-file", required=True, type=Path)
    parser.add_argument("--out-file", required=True, type=Path)
    parser.add_argument("--qa-model", required=True)
    parser.add_argument("--top-k", default=5, type=int)
    parser.add_argument("--sample-id", default=None)
    parser.add_argument("--limit-questions", default=None, type=int)
    parser.add_argument("--keep-home", action="store_true")
    parser.add_argument("--openai-base-url", default=os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"))
    parser.add_argument("--openai-api-key", default=os.environ.get("OPENAI_API_KEY"))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not args.openai_api_key:
        raise SystemExit("OPENAI_API_KEY or --openai-api-key is required")

    bridge = MuninnBridge()
    samples = load_samples(args.data_file)
    selected = iter_target_samples(samples, args.sample_id)
    results = []
    model_key = build_model_key(args.qa_model, args.top_k)

    for sample in selected:
        sample_result = {
            "sample_id": sample["sample_id"],
            "qa": copy.deepcopy(sample["qa"]),
        }
        qas = sample_result["qa"]
        if args.limit_questions is not None:
            qas = qas[: args.limit_questions]
            sample_result["qa"] = qas

        home_dir = prepare_home(bridge, sample["sample_id"], args.keep_home)
        try:
            bridge.import_sample(args.data_file, sample["sample_id"], home_dir.path)
            batch_hits = collect_batch_hits(bridge, qas, args.top_k, home_dir.path)
            for qa_index, qa in enumerate(qas):
                hits = batch_hits[qa_index]
                prediction = answer_question(
                    question=str(qa["question"]),
                    category=int(qa["category"]),
                    hits=hits,
                    model=args.qa_model,
                    base_url=args.openai_base_url,
                    api_key=args.openai_api_key,
                )
                annotate_qa_result(
                    qa,
                    model_key,
                    prediction,
                    merge_evidence_ids(hits),
                )
        finally:
            if home_dir.tmpdir is not None:
                home_dir.tmpdir.cleanup()

        results.append(sample_result)

    stats = build_stats(results, model_key)
    write_results(args.out_file, results, stats)


@dataclass
class ManagedHome:
    path: Path
    tmpdir: TemporaryDirectory[str] | None = None


def prepare_home(
    bridge: MuninnBridge,
    sample_id: str,
    keep_home: bool,
) -> ManagedHome:
    if keep_home:
        path = ManagedHome(Path("benchmark") / "locomo" / ".runs" / sample_id)
    else:
        tmpdir = TemporaryDirectory(prefix=f"muninn-locomo-{sample_id}-")
        path = ManagedHome(Path(tmpdir.name), tmpdir=tmpdir)
    bridge.reset_home(path.path)
    return path


def collect_batch_hits(
    bridge: MuninnBridge,
    qas: list[dict[str, object]],
    top_k: int,
    home_dir: Path,
) -> dict[int, list[RecallHit]]:
    queries = []
    ordered_candidates: dict[int, list[str]] = {}
    for index, qa in enumerate(qas):
        question = str(qa["question"])
        candidate_keys = []
        for candidate_index, query in enumerate(build_query_candidates(question)):
            key = f"{index}:{candidate_index}"
            candidate_keys.append(key)
            queries.append({"key": key, "query": query, "limit": top_k})
        ordered_candidates[index] = candidate_keys

    batch_results = bridge.recall_batch(queries, home_dir)
    merged_results = {}
    for qa_index, candidate_keys in ordered_candidates.items():
        by_memory_id = {}
        for key in candidate_keys:
            for hit in batch_results.get(key, []):
                if hit.memory_id not in by_memory_id:
                    by_memory_id[hit.memory_id] = hit
            if len(by_memory_id) >= top_k:
                break
        merged_results[qa_index] = list(by_memory_id.values())[:top_k]
    return merged_results


def merge_evidence_ids(hits: list[RecallHit]) -> list[str]:
    merged: list[str] = []
    seen = set()
    for hit in hits:
        for evidence_id in hit.evidence_ids:
            if evidence_id in seen:
                continue
            seen.add(evidence_id)
            merged.append(evidence_id)
    return merged


def answer_question(
    question: str,
    category: int,
    hits: list[RecallHit],
    model: str,
    base_url: str,
    api_key: str,
) -> str:
    prompt = build_user_prompt(question, category, hits)
    response = call_openai_chat(
        model=model,
        base_url=base_url,
        api_key=api_key,
        system_prompt=SYSTEM_PROMPT,
        user_prompt=prompt,
    )
    return response.strip()


def build_user_prompt(question: str, category: int, hits: list[RecallHit]) -> str:
    instructions = [
        "Answer using only the context below.",
        "If the answer is missing, reply exactly: Not mentioned in the conversation.",
    ]
    if category == 1:
        instructions.append("If the answer has multiple items, return a comma-separated list.")
    elif category == 2:
        instructions.append("If the answer is a date, return it in the format D Month YYYY.")
    elif category == 5:
        instructions.append("Only answer with Not mentioned in the conversation when the fact is absent.")

    context_blocks = []
    for index, hit in enumerate(hits, start=1):
        fields = [f"Context {index}:"]
        if hit.date_time:
            fields.append(f"Date: {hit.date_time}")
        if hit.title:
            fields.append(f"Title: {hit.title}")
        if hit.summary:
            fields.append(f"Summary: {hit.summary}")
        if hit.detail:
            fields.append(f"Detail: {hit.detail}")
        context_blocks.append("\n".join(fields))

    context = "\n\n".join(context_blocks) if context_blocks else "No relevant context was recalled."
    return (
        f"{chr(10).join(instructions)}\n\n"
        f"Question: {question}\n\n"
        f"{context}\n\n"
        "Answer:"
    )


def call_openai_chat(
    model: str,
    base_url: str,
    api_key: str,
    system_prompt: str,
    user_prompt: str,
) -> str:
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0,
    }
    request = urllib.request.Request(
        url=f"{base_url.rstrip('/')}/chat/completions",
        data=json.dumps(payload).encode("utf8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request) as response:
            raw = response.read().decode("utf8")
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf8", errors="replace")
        raise RuntimeError(f"QA model request failed ({error.code}): {body}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"QA model request failed: {error}") from error

    data = json.loads(raw)
    choices = data.get("choices", [])
    if not choices:
        raise RuntimeError(f"QA model returned no choices: {raw}")
    message = choices[0].get("message", {})
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        text_parts = [
            item.get("text", "")
            for item in content
            if isinstance(item, dict) and item.get("type") in {None, "text"}
        ]
        joined = "".join(text_parts).strip()
        if joined:
            return joined
    raise RuntimeError(f"QA model returned unsupported content: {raw}")


def build_model_key(model: str, top_k: int) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", model.lower()).strip("_") or "qa"
    return f"muninn_qa_{slug}_top_{top_k}"


if __name__ == "__main__":
    main()
