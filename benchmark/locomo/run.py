from __future__ import annotations

import argparse
import copy
import sys
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory

if __package__ is None or __package__ == "":
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from benchmark.common.muninn_bridge import MuninnBridge
from benchmark.locomo.dataset import iter_target_samples, load_samples, parse_modes
from benchmark.locomo.heuristics import build_prediction, build_query_candidates
from benchmark.locomo.scoring import build_stats, write_results


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-file", required=True, type=Path)
    parser.add_argument("--out-file", required=True, type=Path)
    parser.add_argument("--modes", default="dialog,observation,summary")
    parser.add_argument("--top-k", default=5, type=int)
    parser.add_argument("--sample-id", default=None)
    parser.add_argument("--limit-questions", default=None, type=int)
    parser.add_argument("--keep-home", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    modes = parse_modes(args.modes)
    bridge = MuninnBridge()
    samples = load_samples(args.data_file)
    selected = iter_target_samples(samples, args.sample_id)
    results = []
    model_key_by_mode: dict[str, str] = {}

    for sample in selected:
        sample_result = {
            "sample_id": sample["sample_id"],
            "qa": copy.deepcopy(sample["qa"]),
        }
        qas = sample_result["qa"]
        if args.limit_questions is not None:
            qas = qas[: args.limit_questions]
            sample_result["qa"] = qas

        for mode in modes:
            model_key = f"muninn_{mode}_top_{args.top_k}"
            model_key_by_mode[mode] = model_key
            prediction_key = f"{model_key}_prediction"
            home_dir = prepare_home(bridge, sample["sample_id"], mode, args.keep_home)
            try:
                bridge.import_sample(args.data_file, sample["sample_id"], mode, home_dir.path)
                batch_hits = collect_batch_hits(bridge, qas, args.top_k, home_dir.path)
                for qa_index, qa in enumerate(qas):
                    hits = batch_hits[qa_index]
                    qa[prediction_key] = build_prediction(qa["question"], int(qa["category"]), hits)
                    qa[f"{prediction_key}_context"] = [hit.source_id for hit in hits]
            finally:
                if home_dir.tmpdir is not None:
                    home_dir.tmpdir.cleanup()

        results.append(sample_result)

    stats = build_stats(results, model_key_by_mode)
    write_results(args.out_file, results, stats)


@dataclass
class ManagedHome:
    path: Path
    tmpdir: TemporaryDirectory[str] | None = None


def prepare_home(
    bridge: MuninnBridge,
    sample_id: str,
    mode: str,
    keep_home: bool,
) -> ManagedHome:
    if keep_home:
        path = ManagedHome(
            Path("benchmark") / "locomo" / ".runs" / f"{sample_id}_{mode}"
        )
    else:
        tmpdir = TemporaryDirectory(prefix=f"muninn-locomo-{sample_id}-{mode}-")
        path = ManagedHome(Path(tmpdir.name), tmpdir=tmpdir)
    bridge.reset_home(path.path)
    return path


def collect_batch_hits(
    bridge: MuninnBridge,
    qas: list[dict[str, object]],
    top_k: int,
    home_dir: Path,
):
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
        by_source_id = {}
        for key in candidate_keys:
            for hit in batch_results.get(key, []):
                if hit.source_id and hit.source_id not in by_source_id:
                    by_source_id[hit.source_id] = hit
            if len(by_source_id) >= top_k:
                break
        merged_results[qa_index] = list(by_source_id.values())[:top_k]
    return merged_results


if __name__ == "__main__":
    main()
