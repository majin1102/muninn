from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from benchmark.common.muninn_bridge import RecallHit
from benchmark.locomo.heuristics import build_prediction, build_query_candidates, extract_date
from benchmark.locomo.report import build_error_report, write_report
from benchmark.locomo.run import apply_predictions
from benchmark.locomo.scoring import build_stats, evaluate_question_answering, f1_score, write_results


class ScoringTests(unittest.TestCase):
    def test_extract_date_normalizes_locomo_datetime(self) -> None:
        self.assertEqual(extract_date("1:56 pm on 8 May, 2023"), "8 May 2023")

    def test_build_prediction_prefers_date_for_category_two(self) -> None:
        hit = RecallHit(
            memory_id="turn:1",
            detail="Caroline attended a support group on 8 May 2023.",
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
                    "muninn_top_5_prediction": "Not mentioned in the conversation",
                    "muninn_top_5_prediction_context": ["D2:1"],
                }
            ],
            "muninn_top_5_prediction",
        )
        self.assertEqual(scores, [1.0])
        self.assertEqual(recall, [0.0])

    def test_category_five_accepts_locomo_choice_a_as_negative_answer(self) -> None:
        scores, recall = evaluate_question_answering(
            [
                {
                    "category": 5,
                    "question": "What did Caroline realize after the race?",
                    "adversarial_answer": "self-care is important",
                    "evidence": ["D2:3"],
                    "muninn_top_5_prediction": "a",
                    "muninn_top_5_prediction_context": ["D2:3"],
                },
                {
                    "category": 5,
                    "question": "What did Caroline realize after the race?",
                    "adversarial_answer": "self-care is important",
                    "evidence": ["D2:3"],
                    "muninn_top_5_prediction": "(a)",
                    "muninn_top_5_prediction_context": ["D2:3"],
                },
            ],
            "muninn_top_5_prediction",
        )
        self.assertEqual(scores, [1.0, 1.0])
        self.assertEqual(recall, [1.0, 1.0])

    def test_category_five_allows_negative_answer_when_context_hits_adversarial_evidence(self) -> None:
        scores, recall = evaluate_question_answering(
            [
                {
                    "category": 5,
                    "question": "What did Caroline realize after the race?",
                    "evidence": ["D2:3"],
                    "muninn_top_5_prediction": "Not mentioned in the conversation",
                    "muninn_top_5_prediction_context": ["D2:3"],
                }
            ],
            "muninn_top_5_prediction",
        )
        self.assertEqual(scores, [1.0])
        self.assertEqual(recall, [1.0])

    def test_category_five_penalizes_adversarial_answer_matches(self) -> None:
        scores, recall = evaluate_question_answering(
            [
                {
                    "category": 5,
                    "question": "What did Caroline realize after the race?",
                    "adversarial_answer": "No information available",
                    "evidence": [],
                    "muninn_top_5_prediction": "No information available",
                    "muninn_top_5_prediction_context": [],
                }
            ],
            "muninn_top_5_prediction",
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
                    "muninn_top_5_prediction": "8 May 2023",
                    "muninn_top_5_prediction_context": [],
                }
            ],
            "muninn_top_5_prediction",
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
                    "muninn_top_5_prediction": "LGBTQ support group",
                    "muninn_top_5_prediction_context": ["S1"],
                }
            ],
            "muninn_top_5_prediction",
        )
        self.assertEqual(scores, [1.0])
        self.assertEqual(recall, [2 / 3])

    def test_query_builder_passes_the_original_question_through(self) -> None:
        question = "What support group did Caroline join?"

        self.assertEqual(build_query_candidates(question), [question])

    def test_apply_predictions_records_top_hit_diagnostics(self) -> None:
        qas = [
            {
                "question": "When did Caroline go to the support group?",
                "category": 2,
                "answer": "8 May 2023",
                "evidence": ["D1:3"],
            }
        ]
        hits = [
            RecallHit(
                memory_id="turn:1",
                detail="Caroline went to the support group on 8 May 2023.",
            )
        ]

        apply_predictions(qas, {0: hits}, "muninn_top_5_prediction")

        self.assertEqual(qas[0]["muninn_top_5_prediction"], "8 May 2023")
        self.assertEqual(qas[0]["muninn_top_5_prediction_context"], [])
        self.assertEqual(qas[0]["muninn_top_5_hits"][0]["memory_id"], "turn:1")
        self.assertEqual(qas[0]["muninn_top_5_hits"][0]["detail"], "Caroline went to the support group on 8 May 2023.")
        self.assertNotIn("title", qas[0]["muninn_top_5_hits"][0])
        self.assertNotIn("summary", qas[0]["muninn_top_5_hits"][0])
        self.assertNotIn("date_time", qas[0]["muninn_top_5_hits"][0])
        self.assertIn("matched_text", qas[0]["muninn_top_5_hits"][0])
        self.assertNotIn("evidence_ids", qas[0]["muninn_top_5_hits"][0])
        self.assertNotIn("references", qas[0]["muninn_top_5_hits"][0])

    def test_summary_contexts_are_scored_more_strictly_than_session_hits(self) -> None:
        scores, recall = evaluate_question_answering(
            [
                {
                    "category": 4,
                    "question": "What support group did Caroline join?",
                    "answer": "LGBTQ support group",
                    "evidence": ["D1:1"],
                    "muninn_top_5_prediction": "LGBTQ support group",
                    "muninn_top_5_prediction_context": ["S1", "S2"],
                }
            ],
            "muninn_top_5_prediction",
        )
        self.assertAlmostEqual(scores[0], 1.0)
        self.assertAlmostEqual(recall[0], 2 / 3)

    def test_single_entry_stats_and_report(self) -> None:
        samples = [
            {
                "sample_id": "sample-1",
                "qa": [
                    {
                        "question": "When did Caroline go to the support group?",
                        "category": 2,
                        "answer": "8 May 2023",
                        "evidence": ["D1:3"],
                        "muninn_top_5_prediction": "8 May 2023",
                        "muninn_top_5_prediction_context": ["D1:3"],
                    },
                    {
                        "question": "What did Caroline realize after the race?",
                        "category": 5,
                        "evidence": ["D2:3"],
                        "muninn_top_5_prediction": "Not mentioned in the conversation",
                        "muninn_top_5_prediction_context": ["D9:1"],
                    },
                ],
            }
        ]

        stats = build_stats(samples, "muninn_top_5")
        self.assertEqual(stats["model_key"], "muninn_top_5")
        self.assertEqual(stats["qa_count"], 2)
        self.assertAlmostEqual(stats["average_f1"], 1.0)
        self.assertNotIn("average_recall", stats)
        self.assertNotIn("category_recall", stats)

        report = build_error_report(samples, "muninn_top_5")
        self.assertEqual(report["model_key"], "muninn_top_5")
        self.assertEqual(report["qa_count"], 2)
        self.assertEqual(report["top_answer_misses"], [])

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
                        "muninn_top_5_prediction": "red tea",
                        "muninn_top_5_prediction_context": ["D3:1"],
                    }
                ],
            }
        ]
        adversarial_report = build_error_report(
            adversarial_samples,
            "muninn_top_5",
        )
        self.assertEqual(
            adversarial_report["top_adversarial_conflicts"][0]["sample_id"],
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
