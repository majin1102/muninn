from __future__ import annotations

import argparse
import copy
import json
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from time import monotonic
from typing import Any

if __package__ is None or __package__ == "":
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from benchmark.common.muninn_bridge import MuninnBridge, RecallHit
from benchmark.locomo.answering import build_answer_context, build_qa_trace, load_answerer_config, run_llm_answerer
from benchmark.locomo.dataset import iter_target_samples, load_samples
from benchmark.locomo.heuristics import build_prediction, build_query_candidates
from benchmark.locomo.metadata import build_run_metadata, write_run_metadata
from benchmark.locomo.report import build_error_report, write_report
from benchmark.locomo.scoring import build_stats, write_results


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-file", required=True, type=Path)
    parser.add_argument("--out-file", required=True, type=Path)
    parser.add_argument("--progress-file", default=None, type=Path)
    parser.add_argument("--top-k", default=3, type=int)
    parser.add_argument("--recall-mode", choices=["vector", "fts", "hybrid"], default="hybrid")
    parser.add_argument("--budget", default=400, type=int)
    parser.add_argument("--query-limit", default=8, type=int)
    parser.add_argument("--sample-id", default=None)
    parser.add_argument("--limit-questions", default=None, type=int)
    parser.add_argument("--keep-home", action="store_true")
    parser.add_argument("--home-dir", default=None, type=Path)
    parser.add_argument("--mode", choices=["diagnostic", "benchmark"], default="diagnostic")
    parser.add_argument("--answerer", choices=["llm", "heuristic"], default="llm")
    return parser.parse_args(argv)


def main() -> None:
    args = parse_args()
    if not args.data_file.exists():
        raise FileNotFoundError(
            f"LoCoMo data file not found: {args.data_file}. "
            "Run `sh benchmark/locomo/scripts/fetch-data.sh` to populate the default cache, "
            "or pass --data-file with a valid external LoCoMo JSON dataset."
        )

    bridge = MuninnBridge()
    samples = load_samples(args.data_file)
    selected = iter_target_samples(samples, args.sample_id)
    ensure_selected_samples(selected, args.sample_id, args.data_file)
    reporter = ProgressReporter(args.progress_file)
    reporter.start()

    run_started_at = monotonic()
    run_started_timestamp = utc_now()
    reporter.emit(
        "run_start",
        data_file=args.data_file,
        out_file=args.out_file,
        progress_file=args.progress_file,
        sample_count=len(selected),
        top_k=args.top_k,
        top_k_ignored=args.budget > 0,
        budget=args.budget,
        query_limit=args.query_limit,
        recall_mode=args.recall_mode,
        keep_home=args.keep_home,
        limit_questions=args.limit_questions,
        sample_filter=args.sample_id,
        mode=args.mode,
        answerer=args.answerer,
    )

    model_key = build_model_key(args.top_k, args.recall_mode, args.budget, args.query_limit)
    try:
        home_dir = prepare_home(
            bridge,
            run_home_name(selected, args.out_file),
            args.keep_home,
            home_dir=args.home_dir,
            prepared=os.environ.get("MUNINN_LOCOMO_HOME_PREPARED") == "1",
        )
        results = []
        gateway_routes_by_sample: dict[str, dict[str, list[dict[str, Any]]]] = {}
        manifests: list[dict[str, Any]] = []
        try:
            for sample in selected:
                sample_result = prepare_sample_result(sample, args.limit_questions)
                results.append(sample_result)
                manifests.append(import_unit(
                    bridge,
                    args,
                    reporter,
                    sample,
                    sample_result["qa"],
                    home_dir,
                ))
            write_combined_manifest(home_dir.path, merge_import_manifests(manifests))

            for sample, sample_result in zip(selected, results, strict=True):
                sample_started_at = monotonic()
                qas = sample_result["qa"]
                reporter.emit(
                    "sample_start",
                    sample_id=sample["sample_id"],
                    qa_count=len(qas),
                )

                try:
                    gateway_routes_by_sample[sample["sample_id"]] = run_qa_unit(
                        bridge,
                        args,
                        reporter,
                        sample,
                        qas,
                        model_key,
                        home_dir,
                    )
                except Exception as exc:
                    reporter.emit(
                        "sample_failed",
                        sample_id=sample["sample_id"],
                        qa_count=len(qas),
                        elapsed_s=round(monotonic() - sample_started_at, 4),
                        error_type=type(exc).__name__,
                        error=str(exc),
                    )
                    raise

                reporter.emit(
                    "sample_complete",
                    sample_id=sample["sample_id"],
                    qa_count=len(qas),
                    elapsed_s=round(monotonic() - sample_started_at, 4),
                )
        finally:
            if home_dir.tmpdir is not None:
                home_dir.tmpdir.cleanup()

        stats = run_phase(
            reporter,
            "aggregate_stats",
            lambda: build_stats(results, model_key),
        )
        report = run_phase(
            reporter,
            "aggregate_report",
            lambda: build_error_report(results, model_key),
        )
        run_phase(
            reporter,
            "write_outputs",
            lambda: write_results(args.out_file, results, stats),
            out_file=args.out_file,
        )
        run_phase(
            reporter,
            "write_report",
            lambda: write_report(args.out_file, report),
            out_file=args.out_file.with_name(f"{args.out_file.stem}_report.json"),
        )
        run_phase(
            reporter,
            "write_metadata",
            lambda: write_run_metadata(
                args.out_file,
                build_run_metadata(
                    run_name=args.out_file.stem,
                    data_file=args.data_file,
                    out_file=args.out_file,
                    top_k=args.top_k,
                    started_at=run_started_timestamp,
                    completed_at=utc_now(),
                    mode=args.mode,
                    answerer=args.answerer,
                    recall_mode=args.recall_mode,
                ),
            ),
            out_file=args.out_file.with_name(f"{args.out_file.stem}_metadata.json"),
        )
        run_phase(
            reporter,
            "write_trace",
            lambda: write_trace(
                args.out_file,
                build_trace(results, model_key, gateway_routes_by_sample),
            ),
            out_file=args.out_file.with_name(f"{args.out_file.stem}_trace.json"),
        )
        reporter.emit(
            "run_complete",
            out_file=args.out_file,
            progress_file=args.progress_file,
            sample_count=len(results),
            elapsed_s=round(monotonic() - run_started_at, 4),
        )
    except Exception as exc:
        reporter.emit(
            "run_failed",
            out_file=args.out_file,
            progress_file=args.progress_file,
            elapsed_s=round(monotonic() - run_started_at, 4),
            error_type=type(exc).__name__,
            error=str(exc),
        )
        raise
    finally:
        reporter.close()


def ensure_selected_samples(
    selected: list[dict[str, Any]],
    sample_id: str | None,
    data_file: Path,
) -> None:
    if sample_id is None or selected:
        return
    raise ValueError(
        f"LoCoMo sample not found: {sample_id} in {data_file}. "
        "Check that --sample-id matches a sample_id present in the dataset."
    )


def build_model_key(top_k: int, recall_mode: str = "hybrid", budget: int = 0, query_limit: int = 8) -> str:
    if budget > 0:
        return f"muninn_{recall_mode}_encoded_budget_{budget}_query_{query_limit}"
    return f"muninn_{recall_mode}_top_{top_k}"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


@dataclass
class ManagedHome:
    path: Path
    tmpdir: TemporaryDirectory[str] | None = None


class ProgressReporter:
    def __init__(self, progress_file: Path | None) -> None:
        self.progress_file = progress_file
        self._handle = None

    def start(self) -> None:
        if self.progress_file is None:
            return
        self.progress_file.parent.mkdir(parents=True, exist_ok=True)
        self._handle = self.progress_file.open("w", encoding="utf8")

    def close(self) -> None:
        if self._handle is None:
            return
        self._handle.close()
        self._handle = None

    def emit(self, event: str, **fields: Any) -> None:
        record = {
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "event": event,
        }
        record.update(
            {
                key: normalize_field(value)
                for key, value in fields.items()
                if value is not None
            }
        )
        print(format_progress_record(record), file=sys.stderr, flush=True)
        if self._handle is not None:
            self._handle.write(f"{json.dumps(record, ensure_ascii=True)}\n")
            self._handle.flush()


def prepare_home(
    bridge: MuninnBridge,
    name: str,
    keep_home: bool,
    home_dir: Path | None = None,
    prepared: bool = False,
) -> ManagedHome:
    if home_dir is not None:
        path = ManagedHome(home_dir)
    elif keep_home:
        path = ManagedHome(Path("benchmark") / "locomo" / ".runs" / name)
    else:
        tmpdir = TemporaryDirectory(prefix=f"muninn-locomo-{name}-")
        path = ManagedHome(Path(tmpdir.name), tmpdir=tmpdir)
    if not prepared:
        bridge.reset_home(path.path)
    return path


def run_home_name(samples: list[dict[str, Any]], out_file: Path) -> str:
    if len(samples) == 1:
        return str(samples[0]["sample_id"])
    return out_file.stem


def prepare_sample_result(sample: dict[str, Any], limit_questions: int | None) -> dict[str, Any]:
    sample_result = {
        "sample_id": sample["sample_id"],
        "qa": copy.deepcopy(sample["qa"]),
    }
    if limit_questions is not None:
        sample_result["qa"] = sample_result["qa"][:limit_questions]
    return sample_result


def import_unit(
    bridge: MuninnBridge,
    args: argparse.Namespace,
    reporter: ProgressReporter,
    sample: dict[str, object],
    qas: list[dict[str, object]],
    home_dir: ManagedHome,
) -> dict[str, Any]:
    stage_started_at = monotonic()
    sample_id = str(sample["sample_id"])
    query_count = count_query_candidates(qas)
    import_sample = build_import_sample(sample, qas)
    import_data_file = write_import_sample(home_dir.path, import_sample)

    reporter.emit(
        "import_unit_start",
        sample_id=sample_id,
        qa_count=len(qas),
        query_candidate_count=query_count,
        home_dir=home_dir.path,
        import_turn_count=count_dialogs(import_sample),
    )

    try:
        import_result = run_phase(
            reporter,
            "import_sample",
            lambda: bridge.import_sample(
                import_data_file,
                sample_id,
                home_dir.path,
            ),
            sample_id=sample_id,
            qa_count=len(qas),
            query_candidate_count=query_count,
            home_dir=home_dir.path,
            import_data_file=import_data_file,
            import_turn_count=count_dialogs(import_sample),
        )
        manifest_path = import_result.get("manifest_path") if isinstance(import_result, dict) else None
        if not isinstance(manifest_path, str):
            raise ValueError("import_sample did not return manifest_path")
        reporter.emit(
            "import_unit_complete",
            sample_id=sample_id,
            qa_count=len(qas),
            query_candidate_count=query_count,
            elapsed_s=round(monotonic() - stage_started_at, 4),
        )
        return read_import_manifest(Path(manifest_path))
    except Exception as exc:
        reporter.emit(
            "import_unit_failed",
            sample_id=sample_id,
            qa_count=len(qas),
            query_candidate_count=query_count,
            elapsed_s=round(monotonic() - stage_started_at, 4),
            home_dir=home_dir.path,
            error_type=type(exc).__name__,
            error=str(exc),
        )
        raise


def run_qa_unit(
    bridge: MuninnBridge,
    args: argparse.Namespace,
    reporter: ProgressReporter,
    sample: dict[str, object],
    qas: list[dict[str, object]],
    model_key: str,
    home_dir: ManagedHome,
) -> dict[str, list[dict[str, Any]]]:
    stage_started_at = monotonic()
    sample_id = str(sample["sample_id"])
    prediction_key = f"{model_key}_prediction"
    heuristic_key = f"{model_key}_heuristic_prediction"
    query_count = count_query_candidates(qas)

    reporter.emit(
        "unit_start",
        sample_id=sample_id,
        qa_count=len(qas),
        query_candidate_count=query_count,
        home_dir=home_dir.path,
    )

    try:
        batch_hits = run_phase(
            reporter,
            "recall_batch",
            lambda: collect_batch_hits(
                bridge,
                qas,
                args.top_k,
                home_dir.path,
                args.recall_mode,
                args.budget,
                args.query_limit,
                True,
                sample_id=sample_id,
            ),
            sample_id=sample_id,
            qa_count=len(qas),
            query_candidate_count=query_count,
            top_k=args.top_k,
            budget=args.budget,
            query_limit=args.query_limit,
            recall_mode=args.recall_mode,
            home_dir=home_dir.path,
        )
        run_phase(
            reporter,
            "build_predictions",
            lambda: apply_predictions(
                qas,
                batch_hits,
                prediction_key,
                heuristic_key=heuristic_key,
                answerer=args.answerer,
                answerer_config=load_answerer_config(home_dir.path) if args.answerer == "llm" else None,
                reporter=reporter,
                sample_id=sample_id,
            ),
            sample_id=sample_id,
            qa_count=len(qas),
            top_k=args.top_k,
            answerer=args.answerer,
        )
        reporter.emit(
            "unit_complete",
            sample_id=sample_id,
            qa_count=len(qas),
            query_candidate_count=query_count,
            elapsed_s=round(monotonic() - stage_started_at, 4),
        )
        return load_gateway_routes(home_dir.path / sample_id / "logs" / "locomo-gateway-trace.jsonl")
    except Exception as exc:
        reporter.emit(
            "unit_failed",
            sample_id=sample_id,
            qa_count=len(qas),
            query_candidate_count=query_count,
            elapsed_s=round(monotonic() - stage_started_at, 4),
            home_dir=home_dir.path,
            error_type=type(exc).__name__,
            error=str(exc),
        )
        raise


def build_import_sample(
    sample: dict[str, object],
    qas: list[dict[str, object]],
) -> dict[str, object]:
    conversation = sample.get("conversation")
    if not isinstance(conversation, dict):
        raise ValueError("LoCoMo sample is missing conversation")

    max_session = max_evidence_session(qas)
    if max_session is None:
        return {
            **sample,
            "qa": qas,
        }

    retained_conversation: dict[str, object] = {}
    for key in ("speaker_a", "speaker_b"):
        if key in conversation:
            retained_conversation[key] = conversation[key]

    retained_sessions: list[int] = []
    retained_dialog_ids: set[str] = set()
    for session_no in range(1, max_session + 1):
        session_key = f"session_{session_no}"
        date_key = f"session_{session_no}_date_time"
        dialogs = conversation.get(session_key)
        if not isinstance(dialogs, list):
            continue
        retained_sessions.append(session_no)
        retained_conversation[session_key] = dialogs
        if date_key in conversation:
            retained_conversation[date_key] = conversation[date_key]
        for dialog in dialogs:
            if isinstance(dialog, dict) and dialog.get("dia_id"):
                retained_dialog_ids.add(str(dialog["dia_id"]))

    return {
        "sample_id": sample["sample_id"],
        "conversation": retained_conversation,
        "qa": [
            qa
            for qa in qas
            if qa_evidence_contained(qa, retained_dialog_ids)
        ],
        **optional_session_maps(sample, retained_sessions),
    }


def write_import_sample(home_dir: Path, sample: dict[str, object]) -> Path:
    sample_id = str(sample.get("sample_id", "sample"))
    path = home_dir / f"locomo-import-{sample_id}.json"
    path.write_text(f"{json.dumps([sample], indent=2)}\n", encoding="utf8")
    return path


def read_import_manifest(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf8"))


def write_combined_manifest(home_dir: Path, manifest: dict[str, Any]) -> Path:
    path = home_dir / "locomo-manifest.json"
    path.write_text(f"{json.dumps(manifest, indent=2)}\n", encoding="utf8")
    return path


def merge_import_manifests(manifests: list[dict[str, Any]]) -> dict[str, Any]:
    if not manifests:
        return {"sample_id": "", "turns": []}
    sample_ids = [str(manifest.get("sample_id", "")) for manifest in manifests]
    turns = [
        turn
        for manifest in manifests
        for turn in manifest.get("turns", [])
        if isinstance(turn, dict)
    ]
    return {
        "sample_id": "+".join(sample_ids),
        "baseline_extracting_epoch": manifests[0].get("baseline_extracting_epoch"),
        "baseline_committed_epoch": manifests[0].get("baseline_committed_epoch"),
        "turns": turns,
    }


def max_evidence_session(qas: list[dict[str, object]]) -> int | None:
    max_session: int | None = None
    for qa in qas:
        evidence = qa.get("evidence")
        if not isinstance(evidence, list):
            continue
        for item in evidence:
            session_no = parse_dialog_session(str(item))
            if session_no is None:
                continue
            max_session = session_no if max_session is None else max(max_session, session_no)
    return max_session


def parse_dialog_session(dialog_id: str) -> int | None:
    if not dialog_id.startswith("D"):
        return None
    prefix = dialog_id.split(":", 1)[0]
    try:
        return int(prefix[1:])
    except ValueError:
        return None


def qa_evidence_contained(qa: dict[str, object], retained_ids: set[str]) -> bool:
    evidence = qa.get("evidence")
    return (
        isinstance(evidence, list)
        and bool(evidence)
        and all(str(item) in retained_ids for item in evidence)
    )


def optional_session_maps(
    sample: dict[str, object],
    retained_sessions: list[int],
) -> dict[str, object]:
    result: dict[str, object] = {}
    for key in ("observation", "session_summary"):
        value = sample.get(key)
        session_map = slice_session_map(value, retained_sessions)
        if session_map:
            result[key] = session_map
    return result


def slice_session_map(value: object, retained_sessions: list[int]) -> dict[str, object]:
    if not isinstance(value, dict):
        return {}
    prefixes = tuple(f"session_{session_no}_" for session_no in retained_sessions)
    return {
        str(key): item
        for key, item in value.items()
        if str(key).startswith(prefixes)
    }


def count_dialogs(sample: dict[str, object]) -> int:
    conversation = sample.get("conversation")
    if not isinstance(conversation, dict):
        return 0
    return sum(
        len(value)
        for key, value in conversation.items()
        if key.startswith("session_") and isinstance(value, list)
    )


def run_phase(
    reporter: ProgressReporter,
    phase: str,
    fn,
    **fields: Any,
):
    phase_started_at = monotonic()
    reporter.emit("phase_start", phase=phase, **fields)
    try:
        value = fn()
    except Exception as exc:
        reporter.emit(
            "phase_failed",
            phase=phase,
            elapsed_s=round(monotonic() - phase_started_at, 4),
            error_type=type(exc).__name__,
            error=str(exc),
            **fields,
        )
        raise
    reporter.emit(
        "phase_complete",
        phase=phase,
        elapsed_s=round(monotonic() - phase_started_at, 4),
        **fields,
    )
    return value


def apply_predictions(
    qas: list[dict[str, object]],
    batch_hits: dict[int, list[RecallHit]],
    prediction_key: str,
    *,
    heuristic_key: str | None = None,
    answerer: str = "heuristic",
    answerer_config: dict[str, Any] | None = None,
    reporter: ProgressReporter | None = None,
    sample_id: str | None = None,
) -> None:
    hit_key_prefix = prediction_key.removesuffix("_prediction")
    heuristic_key = heuristic_key or f"{hit_key_prefix}_heuristic_prediction"
    for qa_index, qa in enumerate(qas):
        if reporter is not None and (qa_index == 0 or (qa_index + 1) % 10 == 0 or qa_index + 1 == len(qas)):
            reporter.emit(
                "answer_progress",
                sample_id=sample_id,
                qa_index=qa_index + 1,
                qa_count=len(qas),
                answerer=answerer,
            )
        hits = batch_hits[qa_index]
        question = str(qa["question"])
        category = int(qa["category"])
        heuristic_prediction = build_prediction(question, category, hits)
        answer_context = build_answer_context(
            question=question,
            category=category,
            hits=hits,
        )
        qa[heuristic_key] = heuristic_prediction
        qa[f"{hit_key_prefix}_answer_context"] = answer_context
        if answerer == "llm":
            if answerer_config is None:
                raise ValueError("LLM answerer requires answerer_config")
            answer_started_at = monotonic()
            answer_result = run_llm_answerer(
                question=question,
                category=category,
                answer_context=answer_context,
                config=answerer_config,
                adversarial_answer=qa.get("adversarial_answer") if isinstance(qa.get("adversarial_answer"), str) else None,
            )
            qa[f"{hit_key_prefix}_answer_elapsed_s"] = round(monotonic() - answer_started_at, 4)
            qa[prediction_key] = answer_result["answer"]
            qa[f"{hit_key_prefix}_memory_clarity_score"] = answer_result.get("memory_clarity_score")
            qa[f"{hit_key_prefix}_memory_clarity_reason"] = answer_result.get("memory_clarity_reason")
        elif answerer == "heuristic":
            qa[prediction_key] = heuristic_prediction
            qa[f"{hit_key_prefix}_answer_elapsed_s"] = 0
            qa[f"{hit_key_prefix}_memory_clarity_score"] = None
            qa[f"{hit_key_prefix}_memory_clarity_reason"] = ""
        else:
            raise ValueError(f"unsupported answerer: {answerer}")
        qa[f"{prediction_key}_context"] = []
        qa[f"{hit_key_prefix}_hits"] = [
            {
                "memory_id": hit.memory_id,
                "matched_text": hit.matched_text,
                "detail": hit.detail,
                "observationRatio": hit.observation_ratio,
            }
            for hit in hits
        ]


def build_trace(
    samples: list[dict[str, Any]],
    model_key: str,
    gateway_routes_by_sample: dict[str, dict[str, list[dict[str, Any]]]] | None = None,
) -> dict[str, Any]:
    prediction_key = f"{model_key}_prediction"
    heuristic_key = f"{model_key}_heuristic_prediction"
    trace_samples = []
    for sample in samples:
        sample_id = str(sample.get("sample_id", ""))
        rows = []
        for qa_index, qa in enumerate(sample.get("qa", [])):
            if prediction_key not in qa:
                continue
            rows.append(
                build_qa_trace(
                    sample_id=sample_id,
                    qa_index=qa_index,
                    qa=qa,
                    query_candidates=build_query_candidates(str(qa.get("question", ""))),
                    prediction_key=prediction_key,
                    heuristic_key=heuristic_key,
                    gateway_routes=(gateway_routes_by_sample or {}).get(sample_id),
                )
            )
        trace_samples.append({"sample_id": sample_id, "qa": rows})
    return {"model_key": model_key, "samples": trace_samples}


def load_gateway_routes(path: Path | None) -> dict[str, list[dict[str, Any]]]:
    if path is None or not path.exists():
        return {}
    routes: dict[str, list[dict[str, Any]]] = {}
    for line in path.read_text(encoding="utf8").splitlines():
        if not line.strip():
            continue
        event = json.loads(line)
        for route in event.get("sessionFragments", []):
            route_key = route.get("threadId")
            if not route_key:
                continue
            routes.setdefault(str(route_key), []).append(
                {
                    "threadId": route.get("threadId"),
                    "turnIds": route.get("turnIds") or [],
                    "content": route.get("content"),
                    "reason": route.get("reason"),
                }
            )
    return routes


def write_trace(out_file: Path, trace: dict[str, Any]) -> Path:
    trace_file = out_file.with_name(f"{out_file.stem}_trace.json")
    trace_file.parent.mkdir(parents=True, exist_ok=True)
    trace_file.write_text(f"{json.dumps(trace, indent=2)}\n", encoding="utf8")
    return trace_file


def collect_batch_hits(
    bridge: MuninnBridge,
    qas: list[dict[str, object]],
    top_k: int,
    home_dir: Path,
    recall_mode: str = "hybrid",
    budget: int = 0,
    query_limit: int = 8,
    skip_watermark: bool = False,
    sample_id: str | None = None,
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

    batch_results = bridge.recall_batch(
        queries,
        home_dir,
        recall_mode,
        budget=budget,
        query_limit=query_limit,
        skip_watermark=skip_watermark,
        sample_id=sample_id,
    )
    merged_results: dict[int, list[RecallHit]] = {}
    for qa_index, candidate_keys in ordered_candidates.items():
        hits: list[RecallHit] = []
        seen_memory_ids: set[str] = set()
        for key in candidate_keys:
            for hit in batch_results.get(key, []):
                if hit.memory_id in seen_memory_ids:
                    continue
                seen_memory_ids.add(hit.memory_id)
                hits.append(hit)
                if budget > 0 or len(hits) >= top_k:
                    break
            if budget > 0 or len(hits) >= top_k:
                break
        merged_results[qa_index] = hits
    return merged_results


def count_query_candidates(qas: list[dict[str, object]]) -> int:
    return sum(len(build_query_candidates(str(qa["question"]))) for qa in qas)


def normalize_field(value: Any) -> Any:
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, tuple):
        return list(value)
    return value


def format_progress_record(record: dict[str, Any]) -> str:
    parts = ["[locomo]"]
    for key, value in record.items():
        rendered = json.dumps(value, ensure_ascii=True) if needs_json_encoding(value) else str(value)
        parts.append(f"{key}={rendered}")
    return " ".join(parts)


def needs_json_encoding(value: Any) -> bool:
    return isinstance(value, (dict, list, str)) and (" " in str(value) or isinstance(value, (dict, list)))


if __name__ == "__main__":
    main()
