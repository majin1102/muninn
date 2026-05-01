from __future__ import annotations

import unittest
from pathlib import Path

from benchmark.locomo.run import build_trace, ensure_selected_samples, load_gateway_routes, parse_args


class RunTests(unittest.TestCase):
    def test_raises_when_explicit_sample_id_is_missing(self) -> None:
        data_file = Path("/tmp/mini-locomo.json")

        with self.assertRaisesRegex(
            ValueError,
            "LoCoMo sample not found: missing-sample in /tmp/mini-locomo.json",
        ):
            ensure_selected_samples([], "missing-sample", data_file)

    def test_allows_empty_selection_when_no_sample_filter_is_set(self) -> None:
        ensure_selected_samples([], None, Path("/tmp/mini-locomo.json"))

    def test_parse_args_defaults_to_diagnostic_llm_flow(self) -> None:
        args = parse_args(
            [
                "--data-file",
                "data.json",
                "--out-file",
                "out.json",
            ]
        )

        self.assertEqual(args.mode, "diagnostic")
        self.assertEqual(args.answerer, "llm")
        self.assertFalse(args.expand_references)

    def test_parse_args_accepts_benchmark_heuristic_flow(self) -> None:
        args = parse_args(
            [
                "--data-file",
                "data.json",
                "--out-file",
                "out.json",
                "--mode",
                "benchmark",
                "--answerer",
                "heuristic",
                "--expand-references",
            ]
        )

        self.assertEqual(args.mode, "benchmark")
        self.assertEqual(args.answerer, "heuristic")
        self.assertTrue(args.expand_references)

    def test_build_trace_includes_gateway_routes_when_available(self) -> None:
        sample = {
            "sample_id": "conv-a",
            "qa": [{
                "question": "What did Caroline pursue?",
                "answer": "counseling",
                "category": 3,
                "evidence": [],
                "muninn_top_5_prediction": "counseling",
                "muninn_top_5_heuristic_prediction": "counseling",
                "muninn_top_5_hits": [{
                    "memory_id": "observing:1",
                    "matched_text": "Caroline is interested in counseling.",
                    "evidence_ids": ["D1:11"],
                    "references": [],
                }],
            }],
        }

        trace = build_trace([sample], "muninn_top_5", gateway_routes_by_sample={
            "conv-a": {
                "observing:1": [{
                    "turnId": "session:11",
                    "targetThreadId": "observing:1",
                    "newThreadTitle": None,
                    "sourceSlice": "Caroline is interested in counseling.",
                    "rationale": "This continues the career thread.",
                }],
            },
        })

        self.assertEqual(
            trace["samples"][0]["qa"][0]["hits"][0]["gateway_routes"][0]["sourceSlice"],
            "Caroline is interested in counseling.",
        )

    def test_load_gateway_routes_groups_routes_by_target_thread_id(self) -> None:
        path = Path("/tmp/muninn-gateway-routes-test.jsonl")
        self.addCleanup(lambda: path.unlink(missing_ok=True))
        path.write_text(
            '{"observingEpoch":2,"routes":[{"turnId":"session:11","targetThreadId":"observing:1","sourceSlice":"Caroline is interested in counseling.","rationale":"This continues the career thread."}]}\n',
            encoding="utf8",
        )

        routes = load_gateway_routes(path)

        self.assertEqual(routes["observing:1"][0]["sourceSlice"], "Caroline is interested in counseling.")


if __name__ == "__main__":
    unittest.main()
