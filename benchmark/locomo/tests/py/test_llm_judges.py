from __future__ import annotations

import unittest

from benchmark.locomo.scripts.honcho_judge import build_system_prompt as build_honcho_system_prompt
from benchmark.locomo.scripts.honcho_judge import iter_judge_items as iter_honcho_items
from benchmark.locomo.scripts.openviking_judge import build_accuracy_prompt
from benchmark.locomo.scripts.openviking_judge import iter_judge_items as iter_openviking_items


class LlmJudgeScriptTests(unittest.TestCase):
    def test_openviking_prompt_matches_lenient_accuracy_standard(self) -> None:
        prompt = build_accuracy_prompt(
            question="When did Caroline go?",
            gold_answer="7 May 2023",
            response="May 7th, with extra context.",
        )

        self.assertIn("touches on the same topic", prompt)
        self.assertIn("be generous with your grading", prompt)
        self.assertIn("Even if the format differs", prompt)
        self.assertIn("May 7th", prompt)
        self.assertNotIn("missing required set members", prompt)

    def test_openviking_skips_category_5_by_default(self) -> None:
        samples = [{
            "sample_id": "conv-a",
            "qa": [
                {
                    "question": "Known?",
                    "answer": "yes",
                    "category": 1,
                    "muninn_prediction": "yes",
                },
                {
                    "question": "Adversarial?",
                    "answer": "wrong option",
                    "category": 5,
                    "muninn_prediction": "Not mentioned in the conversation",
                },
            ],
        }]

        items = list(iter_openviking_items(samples, prediction_key=None))

        self.assertEqual(len(items), 1)
        self.assertEqual(items[0].question, "Known?")

    def test_honcho_prompt_uses_evidence_based_sufficiency_standard(self) -> None:
        prompt = build_honcho_system_prompt("[D1:1] Alice: I moved to Boston.")

        self.assertIn("## EVIDENCE CONTEXT", prompt)
        self.assertIn("SUFFICIENT or INSUFFICIENT", prompt)
        self.assertIn("gold answer appears within the synthesized answer", prompt)
        self.assertIn("gold answers to be wrong", prompt)
        self.assertNotIn("COVERED", prompt)
        self.assertNotIn("PARTIAL", prompt)
        self.assertNotIn("MISSING", prompt)

    def test_honcho_skips_category_5_by_default(self) -> None:
        samples = [{
            "sample_id": "conv-a",
            "qa": [
                {
                    "question": "Known?",
                    "answer": "yes",
                    "category": 1,
                    "evidence": ["D1:1"],
                    "muninn_prediction": "yes",
                },
                {
                    "question": "Adversarial?",
                    "answer": "wrong option",
                    "category": 5,
                    "evidence": ["D1:2"],
                    "muninn_prediction": "Not mentioned in the conversation",
                },
            ],
        }]

        items = list(iter_honcho_items(samples, prediction_key=None, conversations={}))

        self.assertEqual(len(items), 1)
        self.assertEqual(items[0].question, "Known?")


if __name__ == "__main__":
    unittest.main()
