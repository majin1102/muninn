from __future__ import annotations

import unittest
from pathlib import Path

from benchmark.locomo.run import (
    build_import_sample,
    build_trace,
    count_dialogs,
    ensure_selected_samples,
    load_gateway_routes,
    max_evidence_session,
    merge_import_manifests,
    parse_args,
    run_home_name,
)


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
        self.assertEqual(args.top_k, 3)
        self.assertEqual(args.budget, 400)
        self.assertEqual(args.query_limit, 8)
        self.assertEqual(args.recall_mode, "hybrid")

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
            ]
        )

        self.assertEqual(args.mode, "benchmark")
        self.assertEqual(args.answerer, "heuristic")

    def test_run_home_name_uses_sample_for_single_and_out_file_for_multiple(self) -> None:
        self.assertEqual(
            run_home_name([{"sample_id": "conv-26"}], Path("benchmark/locomo/out/one.json")),
            "conv-26",
        )
        self.assertEqual(
            run_home_name(
                [{"sample_id": "conv-26"}, {"sample_id": "conv-30"}],
                Path("benchmark/locomo/out/conv-26-30.json"),
            ),
            "conv-26-30",
        )

    def test_merge_import_manifests_combines_turns(self) -> None:
        merged = merge_import_manifests([
            {
                "sample_id": "conv-26",
                "baseline_extracting_epoch": 1,
                "baseline_committed_epoch": 1,
                "turns": [{"turn_id": "turn:1", "source_id": "D1:1", "sample_id": "conv-26"}],
            },
            {
                "sample_id": "conv-30",
                "baseline_extracting_epoch": 4,
                "baseline_committed_epoch": 4,
                "turns": [{"turn_id": "turn:2", "source_id": "D1:1", "sample_id": "conv-30"}],
            },
        ])

        self.assertEqual(merged["sample_id"], "conv-26+conv-30")
        self.assertEqual(merged["baseline_extracting_epoch"], 1)
        self.assertEqual([turn["sample_id"] for turn in merged["turns"]], ["conv-26", "conv-30"])

    def test_build_import_sample_keeps_sessions_needed_by_selected_qas(self) -> None:
        sample = {
            "sample_id": "conv-a",
            "conversation": {
                "speaker_a": "Caroline",
                "speaker_b": "Melanie",
                "session_1_date_time": "1:00 pm on 8 May, 2023",
                "session_1": [
                    {"dia_id": "D1:1", "speaker": "Caroline", "text": "I joined a support group."},
                    {"dia_id": "D1:2", "speaker": "Melanie", "text": "How did it help?"},
                ],
                "session_2_date_time": "1:00 pm on 9 May, 2023",
                "session_2": [
                    {"dia_id": "D2:1", "speaker": "Caroline", "text": "I researched counseling programs."},
                ],
                "session_3_date_time": "1:00 pm on 10 May, 2023",
                "session_3": [
                    {"dia_id": "D3:1", "speaker": "Melanie", "text": "I finished a painting."},
                ],
            },
            "observation": {
                "session_1_observation": {"Caroline": [["Caroline joined a support group.", "D1:1"]]},
                "session_2_observation": {"Caroline": [["Caroline researched counseling programs.", "D2:1"]]},
                "session_3_observation": {"Melanie": [["Melanie finished a painting.", "D3:1"]]},
            },
            "session_summary": {
                "session_1_summary": "Caroline joined a support group.",
                "session_2_summary": "Caroline researched counseling programs.",
                "session_3_summary": "Melanie finished a painting.",
            },
        }
        qas = [
            {
                "question": "What did Caroline join?",
                "answer": "support group",
                "evidence": ["D1:1"],
                "category": 4,
            },
        ]

        sliced = build_import_sample(sample, qas)

        self.assertEqual(count_dialogs(sliced), 2)
        self.assertIn("session_1", sliced["conversation"])
        self.assertNotIn("session_2", sliced["conversation"])
        self.assertEqual(sliced["qa"], qas)
        self.assertIn("session_1_observation", sliced["observation"])
        self.assertNotIn("session_2_observation", sliced["observation"])

    def test_build_import_sample_keeps_complete_prefix_sessions(self) -> None:
        sample = {
            "sample_id": "conv-a",
            "conversation": {
                "session_1": [{"dia_id": "D1:1", "speaker": "A", "text": "one"}],
                "session_2": [{"dia_id": "D2:1", "speaker": "A", "text": "two"}],
                "session_3": [{"dia_id": "D3:1", "speaker": "A", "text": "three"}],
            },
            "qa": [],
        }

        sliced = build_import_sample(sample, [{"evidence": ["D2:1"]}])

        self.assertEqual(count_dialogs(sliced), 2)
        self.assertIn("session_1", sliced["conversation"])
        self.assertIn("session_2", sliced["conversation"])
        self.assertNotIn("session_3", sliced["conversation"])

    def test_max_evidence_session_reads_dialog_ids(self) -> None:
        self.assertEqual(max_evidence_session([{"evidence": ["D1:2", "D3:4"]}]), 3)

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
                    "memory_id": "turn:1",
                    "matched_text": "Caroline is interested in counseling.",
                }],
            }],
        }

        trace = build_trace([sample], "muninn_top_5", gateway_routes_by_sample={
            "conv-a": {
                "turn:1": [{
                    "threadId": "turn:1",
                    "turnIds": ["turn:11"],
                    "content": "Caroline is interested in counseling.",
                    "reason": "This continues the career thread.",
                }],
            },
        })

        self.assertEqual(
            trace["samples"][0]["qa"][0]["hits"][0]["gateway_routes"][0]["content"],
            "Caroline is interested in counseling.",
        )

    def test_load_gateway_routes_groups_routes_by_target_thread_id(self) -> None:
        path = Path("/tmp/muninn-gateway-routes-test.jsonl")
        self.addCleanup(lambda: path.unlink(missing_ok=True))
        path.write_text(
            '{"extractionEpoch":2,"sessionFragments":[{"threadId":"turn:1","turnIds":["turn:11"],"content":"Caroline is interested in counseling.","reason":"This continues the career thread."}]}\n',
            encoding="utf8",
        )

        routes = load_gateway_routes(path)

        self.assertEqual(routes["turn:1"][0]["content"], "Caroline is interested in counseling.")


if __name__ == "__main__":
    unittest.main()
