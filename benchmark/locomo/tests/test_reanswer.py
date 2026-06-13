from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from benchmark.locomo.reanswer import reanswer_trace


class ReanswerTests(unittest.TestCase):
    def test_reanswer_trace_reuses_existing_hits_without_recall(self) -> None:
        trace = {
            "model_key": "muninn_hybrid_top_5",
            "samples": [
                {
                    "sample_id": "sample-a",
                    "qa": [
                        {
                            "question": "What is Caroline's identity?",
                            "category": 1,
                            "gold_answer": "Transgender woman",
                            "evidence": ["D1:5"],
                            "hits": [
                                {
                                    "memory_id": "turn:5",
                                    "matched_text": "Caroline found the support group personally meaningful.",
                                    "detail": "Caroline found the support group personally meaningful.",
                                }
                            ],
                        }
                    ],
                }
            ],
        }

        with TemporaryDirectory() as tmpdir:
            home = Path(tmpdir)
            (home / "muninn.json").write_text(
                json.dumps({
                    "observer": {"name": "test-observer", "llmProvider": "mock"},
                    "providers": {"llm": {"mock": {"type": "mock", "model": "mock-answerer"}}},
                }),
                encoding="utf8",
            )
            result = reanswer_trace(
                trace=trace,
                home=home,
                top_k=5,
            )

        qa = result["samples"][0]["qa"][0]
        self.assertEqual(qa["muninn_hybrid_top_5_prediction"], "Mock answer")
        self.assertEqual(qa["muninn_hybrid_top_5_prediction_context"], [])
        self.assertEqual(qa["muninn_hybrid_top_5_hits"][0]["matched_text"], "Caroline found the support group personally meaningful.")
        self.assertEqual(result["stats"]["qa_count"], 1)
        self.assertEqual(result["trace"]["samples"][0]["qa"][0]["prediction"], "Mock answer")


if __name__ == "__main__":
    unittest.main()
