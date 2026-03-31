from __future__ import annotations

import unittest

from benchmark.common.munnai_bridge import RecallHit
from benchmark.locomo.heuristics import build_prediction, build_query_candidates, extract_date
from benchmark.locomo.scoring import evaluate_question_answering, f1_score


class ScoringTests(unittest.TestCase):
    def test_extract_date_normalizes_locomo_datetime(self) -> None:
        self.assertEqual(extract_date("1:56 pm on 8 May, 2023"), "8 May 2023")

    def test_build_prediction_prefers_date_for_category_two(self) -> None:
        hit = RecallHit(
            memory_id="SESSION:1",
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
                    "munnai_dialog_top_5_prediction": "Not mentioned in the conversation",
                    "munnai_dialog_top_5_prediction_context": ["D2:1"],
                }
            ],
            "munnai_dialog_top_5_prediction",
        )
        self.assertEqual(scores, [1.0])
        self.assertEqual(recall, [0.0])

    def test_f1_score_handles_token_overlap(self) -> None:
        self.assertGreater(f1_score("mental health", "health"), 0.0)

    def test_query_builder_emits_searchable_phrases(self) -> None:
        self.assertIn(
            "support group",
            build_query_candidates("What support group did Caroline join?"),
        )


if __name__ == "__main__":
    unittest.main()
