from __future__ import annotations

import unittest

from benchmark.common.muninn_bridge import RecallHit
from benchmark.locomo.heuristics import build_query_candidates
from benchmark.locomo.run import build_model_key, build_user_prompt, merge_evidence_ids
from benchmark.locomo.scoring import annotate_qa_result, f1_score, score_recall


class ScoringTests(unittest.TestCase):
    def test_category_five_requires_not_mentioned_string(self) -> None:
        qa = {
            "category": 5,
            "question": "What did Caroline realize after the race?",
            "evidence": ["D2:3"],
        }
        annotate_qa_result(
            qa,
            "muninn_qa_test_top_5",
            "Not mentioned in the conversation",
            ["D2:1"],
        )
        self.assertEqual(qa["muninn_qa_test_top_5_f1"], 1.0)
        self.assertEqual(qa["muninn_qa_test_top_5_recall"], 0.0)

    def test_recall_is_zero_when_evidence_exists_without_hits(self) -> None:
        self.assertEqual(score_recall([], ["D2:3"]), 0.0)

    def test_recall_supports_summary_session_matching(self) -> None:
        self.assertEqual(score_recall(["S2"], ["D2:1", "D2:3"]), 1.0)

    def test_f1_score_handles_token_overlap(self) -> None:
        self.assertGreater(f1_score("mental health", "health"), 0.0)

    def test_query_builder_emits_searchable_phrases(self) -> None:
        self.assertIn(
            "support group",
            build_query_candidates("What support group did Caroline join?"),
        )

    def test_merge_evidence_ids_dedupes_and_preserves_order(self) -> None:
        hits = [
            RecallHit(
                memory_id="session:1",
                evidence_ids=["D1:1", "D1:2"],
                date_time="1:56 pm on 8 May, 2023",
                title=None,
                summary=None,
                detail=None,
            ),
            RecallHit(
                memory_id="observing:3",
                evidence_ids=["D1:2", "D2:1"],
                date_time=None,
                title=None,
                summary=None,
                detail=None,
            ),
        ]
        self.assertEqual(merge_evidence_ids(hits), ["D1:1", "D1:2", "D2:1"])

    def test_prompt_contains_context_but_not_hidden_evidence_ids(self) -> None:
        prompt = build_user_prompt(
            "What support group did Caroline join?",
            4,
            [
                RecallHit(
                    memory_id="session:1",
                    evidence_ids=["D1:1"],
                    date_time="1:56 pm on 8 May, 2023",
                    title="Conversation memory",
                    summary="Caroline: I joined an LGBTQ support group.",
                    detail="Prompt: Caroline: I joined an LGBTQ support group.\nResponse: Recorded.",
                )
            ],
        )
        self.assertIn("LGBTQ support group", prompt)
        self.assertNotIn("D1:1", prompt)

    def test_model_key_is_stable_and_sanitized(self) -> None:
        self.assertEqual(
            build_model_key("gpt-4.1-mini", 5),
            "muninn_qa_gpt_4_1_mini_top_5",
        )


if __name__ == "__main__":
    unittest.main()
