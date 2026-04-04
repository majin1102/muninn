from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from benchmark.common.muninn_bridge import RecallHit
from benchmark.locomo.heuristics import build_prediction, build_query_candidates, extract_date
from benchmark.locomo.report import build_error_report, write_report
from benchmark.locomo.scoring import build_stats, evaluate_question_answering, f1_score, write_results


class ScoringTests(unittest.TestCase):
    def test_extract_date_normalizes_locomo_datetime(self) -> None:
        self.assertEqual(extract_date("1:56 pm on 8 May, 2023"), "8 May 2023")

    def test_build_prediction_prefers_date_for_category_two(self) -> None:
        hit = RecallHit(
            memory_id="session:1",
            source_id="D1:3",
            mode="dialog",
            session_no=1,
            date_time="1:56 pm on 8 May, 2023",
            title="LOCOMO dialog D1:3",
            summary="Caroline attended a support group recently.",
            detail="Response: 1:56 pm on 8 May, 2023",
        )
        self.assertEqual(
            build_prediction("When did Caroline go to the support group?", 2, [hit]),
            "8 May 2023",
        )

    def test_category_five_requires_not_mentioned_string(self) -> None:
        scores, recall = evaluate_question_answering(
            [
                {
                    "category": 5,
                    "question": "What did Caroline realize after the race?",
                    "evidence": ["D2:3"],
                    "muninn_dialog_top_5_prediction": "Not mentioned in the conversation",
                    "muninn_dialog_top_5_prediction_context": ["D2:1"],
                }
            ],
            "muninn_dialog_top_5_prediction",
        )
        self.assertEqual(scores, [1.0])
        self.assertEqual(recall, [0.0])

    def test_category_five_fails_when_context_hits_evidence_even_with_negative_answer(self) -> None:
        scores, recall = evaluate_question_answering(
            [
                {
                    "category": 5,
                    "question": "What did Caroline realize after the race?",
                    "evidence": ["D2:3"],
                    "muninn_dialog_top_5_prediction": "Not mentioned in the conversation",
                    "muninn_dialog_top_5_prediction_context": ["D2:3"],
                }
            ],
            "muninn_dialog_top_5_prediction",
        )
        self.assertEqual(scores, [0.0])
        self.assertEqual(recall, [1.0])

    def test_category_five_penalizes_adversarial_answer_matches(self) -> None:
        scores, recall = evaluate_question_answering(
            [
                {
                    "category": 5,
                    "question": "What did Caroline realize after the race?",
                    "adversarial_answer": "No information available",
                    "evidence": [],
                    "muninn_dialog_top_5_prediction": "No information available",
                    "muninn_dialog_top_5_prediction_context": [],
                }
            ],
            "muninn_dialog_top_5_prediction",
        )
        self.assertEqual(scores, [0.0])
        self.assertEqual(recall, [1.0])

    def test_f1_score_handles_token_overlap(self) -> None:
        self.assertGreater(f1_score("mental health", "health"), 0.0)

    def test_recall_is_zero_when_evidence_exists_without_context_hits(self) -> None:
        scores, recall = evaluate_question_answering(
            [
                {
                    "category": 2,
                    "answer": "8 May 2023",
                    "evidence": ["D2:3"],
                    "muninn_dialog_top_5_prediction": "8 May 2023",
                    "muninn_dialog_top_5_prediction_context": [],
                }
            ],
            "muninn_dialog_top_5_prediction",
        )
        self.assertEqual(scores, [1.0])
        self.assertEqual(recall, [0.0])

    def test_summary_recall_uses_evidence_sessions_instead_of_raw_turn_count(self) -> None:
        scores, recall = evaluate_question_answering(
            [
                {
                    "category": 4,
                    "answer": "LGBTQ support group",
                    "evidence": ["D1:1", "D1:2", "D2:1"],
                    "muninn_summary_top_5_prediction": "LGBTQ support group",
                    "muninn_summary_top_5_prediction_context": ["S1"],
                }
            ],
            "muninn_summary_top_5_prediction",
        )
        self.assertEqual(scores, [1.0])
        self.assertEqual(recall, [2 / 3])

    def test_query_builder_emits_searchable_phrases(self) -> None:
        self.assertIn(
            "support group",
            build_query_candidates("What support group did Caroline join?"),
        )

    def test_summary_contexts_are_scored_more_strictly_than_session_hits(self) -> None:
        scores, recall = evaluate_question_answering(
            [
                {
                    "category": 4,
                    "question": "What support group did Caroline join?",
                    "answer": "LGBTQ support group",
                    "evidence": ["D1:1"],
                    "muninn_summary_top_5_prediction": "LGBTQ support group",
                    "muninn_summary_top_5_prediction_context": ["S1", "S2"],
                }
            ],
            "muninn_summary_top_5_prediction",
        )
        self.assertAlmostEqual(scores[0], 1.0)
        self.assertAlmostEqual(recall[0], 2 / 3)

    def test_pipeline_aware_stats_and_report(self) -> None:
        samples = [
            {
                "sample_id": "sample-1",
                "qa": [
                    {
                        "question": "When did Caroline go to the support group?",
                        "category": 2,
                        "answer": "8 May 2023",
                        "evidence": ["D1:3"],
                        "muninn_oracle_dialog_top_5_prediction": "8 May 2023",
                        "muninn_oracle_dialog_top_5_prediction_context": ["D1:3"],
                        "muninn_generated_dialog_top_5_prediction": "12 June 2024",
                        "muninn_generated_dialog_top_5_prediction_context": ["D1:3"],
                    },
                    {
                        "question": "What did Caroline realize after the race?",
                        "category": 5,
                        "evidence": ["D2:3"],
                        "muninn_oracle_dialog_top_5_prediction": "Not mentioned in the conversation",
                        "muninn_oracle_dialog_top_5_prediction_context": ["D2:3"],
                        "muninn_generated_dialog_top_5_prediction": "Not mentioned in the conversation",
                        "muninn_generated_dialog_top_5_prediction_context": ["D9:1"],
                    },
                ],
            }
        ]

        stats = build_stats(
            samples,
            {
                "oracle": {"dialog": "muninn_oracle_dialog_top_5"},
                "generated": {"dialog": "muninn_generated_dialog_top_5"},
            },
        )
        self.assertEqual(stats["pipelines"]["oracle"]["modes"]["dialog"]["model_key"], "muninn_oracle_dialog_top_5")
        self.assertEqual(stats["pipelines"]["generated"]["modes"]["dialog"]["qa_count"], 2)
        self.assertAlmostEqual(stats["pipelines"]["oracle"]["modes"]["dialog"]["average_f1"], 0.5)
        self.assertAlmostEqual(stats["pipelines"]["generated"]["modes"]["dialog"]["average_f1"], 0.5)
        self.assertAlmostEqual(stats["oracle_vs_generated_delta"]["modes"]["dialog"]["average_f1"], 0.0)
        self.assertAlmostEqual(stats["oracle_vs_generated_delta"]["modes"]["dialog"]["average_recall"], -0.5)

        report = build_error_report(
            samples,
            {
                "oracle": {"dialog": "muninn_oracle_dialog_top_5"},
                "generated": {"dialog": "muninn_generated_dialog_top_5"},
            },
        )
        dialog_report = report["pipelines"]["generated"]["modes"]["dialog"]
        self.assertEqual(dialog_report["model_key"], "muninn_generated_dialog_top_5")
        self.assertEqual(len(dialog_report["top_recall_misses"]), 1)
        self.assertEqual(dialog_report["top_recall_misses"][0]["sample_id"], "sample-1")
        self.assertEqual(len(dialog_report["top_extraction_misses"]), 1)
        self.assertEqual(dialog_report["top_extraction_misses"][0]["qa_index"], 0)
        self.assertEqual(dialog_report["top_adversarial_conflicts"], [])
        self.assertEqual(report["oracle_vs_generated_delta"]["modes"]["dialog"]["qa_count"], 2)
        self.assertEqual(
            report["oracle_vs_generated_delta"]["modes"]["dialog"]["top_deltas"][0]["sample_id"],
            "sample-1",
        )

        adversarial_samples = [
            {
                "sample_id": "sample-2",
                "qa": [
                    {
                        "question": "What color was the drink?",
                        "category": 4,
                        "answer": "blue tea",
                        "adversarial_answer": "red tea",
                        "evidence": ["D3:1"],
                        "muninn_oracle_dialog_top_5_prediction": "red tea",
                        "muninn_oracle_dialog_top_5_prediction_context": ["D3:1"],
                    }
                ],
            }
        ]
        adversarial_report = build_error_report(
            adversarial_samples,
            {
                "oracle": {"dialog": "muninn_oracle_dialog_top_5"},
            },
        )
        self.assertEqual(
            adversarial_report["pipelines"]["oracle"]["modes"]["dialog"]["top_adversarial_conflicts"][0]["sample_id"],
            "sample-2",
        )

        with TemporaryDirectory() as tmpdir:
            out_file = Path(tmpdir) / "results.json"
            write_results(out_file, samples, stats)
            write_report(out_file, report)
            self.assertTrue(out_file.exists())
            self.assertTrue(out_file.with_name("results_stats.json").exists())
            self.assertTrue(out_file.with_name("results_report.json").exists())


if __name__ == "__main__":
    unittest.main()
