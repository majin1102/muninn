from __future__ import annotations

import argparse
import copy
import json
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
from benchmark.locomo.dataset import iter_target_samples, load_samples
from benchmark.locomo.heuristics import build_prediction, build_query_candidates
from benchmark.locomo.report import build_error_report, write_report
from benchmark.locomo.scoring import build_stats, write_results


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-file", required=True, type=Path)
    parser.add_argument("--out-file", required=True, type=Path)
    parser.add_argument("--progress-file", default=None, type=Path)
    parser.add_argument("--top-k", default=5, type=int)
    parser.add_argument("--sample-id", default=None)
    parser.add_argument("--limit-questions", default=None, type=int)
    parser.add_argument("--keep-home", action="store_true")
    return parser.parse_args()


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
    reporter.emit(
        "run_start",
        data_file=args.data_file,
        out_file=args.out_file,
        progress_file=args.progress_file,
        sample_count=len(selected),
        top_k=args.top_k,
        keep_home=args.keep_home,
        limit_questions=args.limit_questions,
        sample_filter=args.sample_id,
    )

    model_key = build_model_key(args.top_k)
    try:
        results = []
        for sample in selected:
            sample_started_at = monotonic()
            sample_result = {
                "sample_id": sample["sample_id"],
                "qa": copy.deepcopy(sample["qa"]),
            }
            qas = sample_result["qa"]
            if args.limit_questions is not None:
                qas = qas[: args.limit_questions]
                sample_result["qa"] = qas

            reporter.emit(
                "sample_start",
                sample_id=sample["sample_id"],
                qa_count=len(qas),
            )

            try:
                run_unit(
                    bridge,
                    args,
                    reporter,
                    sample,
                    qas,
                    model_key,
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

            results.append(sample_result)
            reporter.emit(
                "sample_complete",
                sample_id=sample["sample_id"],
                qa_count=len(qas),
                elapsed_s=round(monotonic() - sample_started_at, 4),
            )

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


def build_model_key(top_k: int) -> str:
    return f"muninn_top_{top_k}"


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


def run_unit(
    bridge: MuninnBridge,
    args: argparse.Namespace,
    reporter: ProgressReporter,
    sample: dict[str, object],
    qas: list[dict[str, object]],
    model_key: str,
) -> None:
    stage_started_at = monotonic()
    sample_id = str(sample["sample_id"])
    prediction_key = f"{model_key}_prediction"
    query_count = count_query_candidates(qas)
    home_dir = prepare_home(bridge, sample_id, args.keep_home)

    reporter.emit(
        "unit_start",
        sample_id=sample_id,
        qa_count=len(qas),
        query_candidate_count=query_count,
        home_dir=home_dir.path,
    )

    try:
        run_phase(
            reporter,
            "import_sample",
            lambda: bridge.import_sample(
                args.data_file,
                sample_id,
                home_dir.path,
            ),
            sample_id=sample_id,
            qa_count=len(qas),
            query_candidate_count=query_count,
            home_dir=home_dir.path,
        )
        batch_hits = run_phase(
            reporter,
            "recall_batch",
            lambda: collect_batch_hits(
                bridge,
                qas,
                args.top_k,
                home_dir.path,
            ),
            sample_id=sample_id,
            qa_count=len(qas),
            query_candidate_count=query_count,
            top_k=args.top_k,
            home_dir=home_dir.path,
        )
        run_phase(
            reporter,
            "build_predictions",
            lambda: apply_predictions(qas, batch_hits, prediction_key),
            sample_id=sample_id,
            qa_count=len(qas),
            top_k=args.top_k,
        )
        reporter.emit(
            "unit_complete",
            sample_id=sample_id,
            qa_count=len(qas),
            query_candidate_count=query_count,
            elapsed_s=round(monotonic() - stage_started_at, 4),
        )
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
    finally:
        if home_dir.tmpdir is not None:
            home_dir.tmpdir.cleanup()


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
) -> None:
    for qa_index, qa in enumerate(qas):
        hits = batch_hits[qa_index]
        qa[prediction_key] = build_prediction(str(qa["question"]), int(qa["category"]), hits)
        context_ids: list[str] = []
        seen: set[str] = set()
        for hit in hits:
            for evidence_id in hit.evidence_ids:
                if evidence_id in seen:
                    continue
                seen.add(evidence_id)
                context_ids.append(evidence_id)
        qa[f"{prediction_key}_context"] = context_ids


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
                if len(hits) >= top_k:
                    break
            if len(hits) >= top_k:
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
