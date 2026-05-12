from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path
from time import monotonic
from typing import Any

if __package__ is None or __package__ == "":
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from benchmark.common.muninn_bridge import MuninnBridge, RecallHit
from benchmark.locomo.answering import build_answer_context, build_qa_trace, load_answerer_config, run_llm_answerer
from benchmark.locomo.dataset import iter_target_samples, load_samples
from benchmark.locomo.heuristics import build_prediction, build_query_candidates
from benchmark.locomo.report import build_error_report, write_report
from benchmark.locomo.run import (
    ProgressReporter,
    build_model_key,
    build_stats,
    build_trace,
    collect_batch_hits,
    ensure_selected_samples,
    load_gateway_routes,
    write_results,
    write_trace,
)
from benchmark.locomo.scoring import score_qa


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-file", required=True, type=Path)
    parser.add_argument("--out-file", required=True, type=Path)
    parser.add_argument("--progress-file", default=None, type=Path)
    parser.add_argument("--runs-dir", default=Path("benchmark") / "locomo" / ".runs", type=Path)
    parser.add_argument("--sample-id", action="append", default=[])
    parser.add_argument("--top-k", default=3, type=int)
    parser.add_argument("--recall-mode", choices=["vector", "fts", "hybrid"], default="hybrid")
    parser.add_argument("--budget", default=400, type=int)
    parser.add_argument("--query-limit", default=8, type=int)
    parser.add_argument("--limit-questions", default=None, type=int)
    parser.add_argument("--answerer", choices=["llm", "heuristic"], default="llm")
    parser.add_argument("--expand-references", action="store_true")
    return parser.parse_args(argv)


def main() -> None:
    args = parse_args()
    if not args.data_file.exists():
        raise FileNotFoundError(f"LoCoMo data file not found: {args.data_file}")

    bridge = MuninnBridge()
    samples = load_samples(args.data_file)
    selected = select_samples(samples, args.sample_id)
    ensure_selected_samples(selected, args.sample_id[0] if len(args.sample_id) == 1 else None, args.data_file)

    reporter = ProgressReporter(args.progress_file)
    reporter.start()
    started_at = monotonic()
    model_key = build_model_key(args.top_k, args.recall_mode, args.budget, args.query_limit)
    results: list[dict[str, Any]] = []
    gateway_routes_by_sample: dict[str, dict[str, list[dict[str, Any]]]] = {}

    try:
        reporter.emit(
            "qa_existing_start",
            data_file=args.data_file,
            out_file=args.out_file,
            progress_file=args.progress_file,
            runs_dir=args.runs_dir,
            sample_count=len(selected),
            samples=[sample["sample_id"] for sample in selected],
            top_k=args.top_k,
            top_k_ignored=args.budget > 0,
            budget=args.budget,
            query_limit=args.query_limit,
            recall_mode=args.recall_mode,
            limit_questions=args.limit_questions,
            answerer=args.answerer,
            expand_references=args.expand_references,
        )
        for sample in selected:
            sample_result, gateway_routes = run_sample(
                bridge=bridge,
                args=args,
                reporter=reporter,
                sample=sample,
                model_key=model_key,
            )
            results.append(sample_result)
            gateway_routes_by_sample[str(sample["sample_id"])] = gateway_routes
            write_partial_outputs(args.out_file, results, model_key, gateway_routes_by_sample)

        stats = build_stats(results, model_key)
        write_results(args.out_file, results, stats)
        write_report(args.out_file, build_error_report(results, model_key))
        write_trace(args.out_file, build_trace(results, model_key, gateway_routes_by_sample))
        reporter.emit(
            "qa_existing_complete",
            out_file=args.out_file,
            sample_count=len(results),
            elapsed_s=round(monotonic() - started_at, 4),
            stats=stats,
        )
    except Exception as exc:
        if results:
            write_partial_outputs(args.out_file, results, model_key, gateway_routes_by_sample)
        reporter.emit(
            "qa_existing_failed",
            out_file=args.out_file,
            elapsed_s=round(monotonic() - started_at, 4),
            completed_sample_count=len(results),
            error_type=type(exc).__name__,
            error=str(exc),
        )
        raise
    finally:
        reporter.close()


def select_samples(samples: list[dict[str, Any]], sample_ids: list[str]) -> list[dict[str, Any]]:
    if not sample_ids:
        return samples
    selected: list[dict[str, Any]] = []
    for sample_id in sample_ids:
        selected.extend(iter_target_samples(samples, sample_id))
    return selected


def run_sample(
    *,
    bridge: MuninnBridge,
    args: argparse.Namespace,
    reporter: ProgressReporter,
    sample: dict[str, Any],
    model_key: str,
) -> tuple[dict[str, Any], dict[str, list[dict[str, Any]]]]:
    sample_id = str(sample["sample_id"])
    home = args.runs_dir / sample_id
    if not home.exists():
        raise FileNotFoundError(f"existing LoCoMo run home not found: {home}")

    qas = copy.deepcopy(sample["qa"])
    if args.limit_questions is not None:
        qas = qas[: args.limit_questions]

    sample_result = {"sample_id": sample_id, "qa": qas}
    prediction_key = f"{model_key}_prediction"
    heuristic_key = f"{model_key}_heuristic_prediction"

    sample_started_at = monotonic()
    reporter.emit(
        "sample_qa_start",
        sample_id=sample_id,
        home_dir=home,
        qa_count=len(qas),
    )

    batch_hits = collect_batch_hits(
        bridge,
        qas,
        args.top_k,
        home,
        args.recall_mode,
        args.budget,
        args.query_limit,
        True,
    )
    answerer_config = load_answerer_config(home) if args.answerer == "llm" else None
    for qa_index, qa in enumerate(qas):
        answer_one(
            qa=qa,
            qa_index=qa_index,
            qa_count=len(qas),
            batch_hits=batch_hits,
            prediction_key=prediction_key,
            heuristic_key=heuristic_key,
            answerer=args.answerer,
            answerer_config=answerer_config,
            expand_references=args.expand_references,
            reporter=reporter,
            sample_id=sample_id,
        )

    stats = build_stats([sample_result], model_key)
    reporter.emit(
        "sample_qa_complete",
        sample_id=sample_id,
        qa_count=len(qas),
        elapsed_s=round(monotonic() - sample_started_at, 4),
        stats=stats,
    )
    gateway_routes = load_gateway_routes(home / "locomo-gateway-trace.jsonl")
    return sample_result, gateway_routes


def answer_one(
    *,
    qa: dict[str, Any],
    qa_index: int,
    qa_count: int,
    batch_hits: dict[int, list[RecallHit]],
    prediction_key: str,
    heuristic_key: str,
    answerer: str,
    answerer_config: dict[str, Any] | None,
    expand_references: bool,
    reporter: ProgressReporter,
    sample_id: str,
) -> None:
    hit_key_prefix = prediction_key.removesuffix("_prediction")
    question = str(qa["question"])
    category = int(qa["category"])
    hits = batch_hits[qa_index]
    reporter.emit(
        "qa_start",
        sample_id=sample_id,
        qa_index=qa_index + 1,
        qa_count=qa_count,
        category=category,
        question=question,
        gold_answer=qa.get("answer"),
        evidence=qa.get("evidence"),
        hit_count=len(hits),
        top_hits=render_top_hits(hits),
    )

    heuristic_prediction = build_prediction(question, category, hits)
    answer_context = build_answer_context(
        question=question,
        category=category,
        hits=hits,
        expand_references=expand_references,
    )
    qa[heuristic_key] = heuristic_prediction
    qa[f"{hit_key_prefix}_answer_context"] = answer_context
    if answerer == "llm":
        if answerer_config is None:
            raise ValueError("LLM answerer requires answerer_config")
        answer_result = run_llm_answerer(
            question=question,
            category=category,
            answer_context=answer_context,
            config=answerer_config,
            adversarial_answer=qa.get("adversarial_answer") if isinstance(qa.get("adversarial_answer"), str) else None,
        )
        qa[prediction_key] = answer_result["answer"]
        qa[f"{hit_key_prefix}_memory_clarity_score"] = answer_result.get("memory_clarity_score")
        qa[f"{hit_key_prefix}_memory_clarity_reason"] = answer_result.get("memory_clarity_reason")
    else:
        qa[prediction_key] = heuristic_prediction
        qa[f"{hit_key_prefix}_memory_clarity_score"] = None
        qa[f"{hit_key_prefix}_memory_clarity_reason"] = ""

    qa[f"{prediction_key}_context"] = context_ids(hits)
    qa[f"{hit_key_prefix}_hits"] = serialize_hits(hits)
    scored = score_qa(qa, prediction_key)
    trace = build_qa_trace(
        sample_id=sample_id,
        qa_index=qa_index,
        qa=qa,
        query_candidates=build_query_candidates(question),
        prediction_key=prediction_key,
        heuristic_key=heuristic_key,
    )
    reporter.emit(
        "qa_scored",
        sample_id=sample_id,
        qa_index=qa_index + 1,
        qa_count=qa_count,
        category=category,
        question=scored.question,
        gold_answer=qa.get("answer"),
        prediction=scored.prediction,
        f1=round(scored.f1, 4),
        recall=round(scored.recall, 4),
        evidence=scored.evidence,
        contexts=scored.contexts,
        memory_clarity_score=qa.get(f"{hit_key_prefix}_memory_clarity_score"),
        memory_clarity_reason=qa.get(f"{hit_key_prefix}_memory_clarity_reason"),
        top_hits=render_top_hits(hits),
        trace=trace,
    )
    print_qa_block(
        sample_id=sample_id,
        qa_index=qa_index,
        qa_count=qa_count,
        scored=scored,
        gold_answer=qa.get("answer"),
        clarity=qa.get(f"{hit_key_prefix}_memory_clarity_score"),
        clarity_reason=qa.get(f"{hit_key_prefix}_memory_clarity_reason"),
        hits=hits,
    )


def context_ids(hits: list[RecallHit]) -> list[str]:
    output: list[str] = []
    seen: set[str] = set()
    for hit in hits:
        for evidence_id in hit.evidence_ids:
            if evidence_id in seen:
                continue
            seen.add(evidence_id)
            output.append(evidence_id)
    return output


def serialize_hits(hits: list[RecallHit]) -> list[dict[str, Any]]:
    return [
        {
            "memory_id": hit.memory_id,
            "matched_text": hit.matched_text,
            "detail": hit.detail,
            "observationRatio": hit.observation_ratio,
            "evidence_ids": hit.evidence_ids,
            "references": hit.references,
        }
        for hit in hits
    ]


def render_top_hits(hits: list[RecallHit], limit: int = 3) -> list[dict[str, Any]]:
    return [
        {
            "memory_id": hit.memory_id,
            "evidence_ids": hit.evidence_ids,
            "matched_text": hit.detail or hit.matched_text or "",
        }
        for hit in hits[:limit]
    ]


def print_qa_block(
    *,
    sample_id: str,
    qa_index: int,
    qa_count: int,
    scored,
    gold_answer: Any,
    clarity: Any,
    clarity_reason: Any,
    hits: list[RecallHit],
) -> None:
    print(
        "\n".join(
            [
                "",
                f"[locomo-qa] {sample_id} {qa_index + 1}/{qa_count} f1={scored.f1:.4f} recall={scored.recall:.4f} clarity={clarity}",
                f"Q: {scored.question}",
                f"Gold: {gold_answer}",
                f"Answer: {scored.prediction}",
                f"Evidence: {', '.join(scored.evidence) if scored.evidence else '(none)'}",
                f"Contexts: {', '.join(scored.contexts) if scored.contexts else '(none)'}",
                f"Clarity reason: {clarity_reason or ''}",
                "Top hits:",
                *[
                    f"  - {hit.memory_id} evidence={hit.evidence_ids} text={(hit.detail or hit.matched_text or '')[:240]}"
                    for hit in hits[:3]
                ],
            ]
        ),
        file=sys.stderr,
        flush=True,
    )


def write_partial_outputs(
    out_file: Path,
    samples: list[dict[str, Any]],
    model_key: str,
    gateway_routes_by_sample: dict[str, dict[str, list[dict[str, Any]]]],
) -> None:
    out_file.parent.mkdir(parents=True, exist_ok=True)
    partial_file = out_file.with_name(f"{out_file.stem}.partial.json")
    partial_file.write_text(f"{json.dumps(samples, indent=2)}\n", encoding="utf8")
    stats = build_stats(samples, model_key)
    stats_file = out_file.with_name(f"{out_file.stem}.partial_stats.json")
    stats_file.write_text(f"{json.dumps(stats, indent=2)}\n", encoding="utf8")
    trace_file = out_file.with_name(f"{out_file.stem}.partial_trace.json")
    trace_file.write_text(
        f"{json.dumps(build_trace(samples, model_key, gateway_routes_by_sample), indent=2)}\n",
        encoding="utf8",
    )


if __name__ == "__main__":
    main()
