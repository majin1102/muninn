from __future__ import annotations

import json
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from benchmark.common.muninn_bridge import RecallHit
from benchmark.locomo.answering import (
    build_openai_payload,
    build_answer_context,
    build_qa_trace,
    load_answerer_config,
    run_llm_answerer,
)
from benchmark.locomo.scoring import score_qa


class AnsweringTests(unittest.TestCase):
    def test_answer_context_includes_related_memories_and_sessions(self) -> None:
        hit = RecallHit(
            memory_id="observing:3",
            evidence_ids=["D1:3"],
            date_time="1:56 pm on 8 May, 2023",
            title="Support group",
            summary="Wide summary",
            detail="Wide detail",
            matched_text="Caroline attended an LGBTQ support group on 7 May 2023.",
            references=[
                {
                    "memory_id": "session:9",
                    "source_id": "D1:3",
                    "date_time": "1:56 pm on 8 May, 2023",
                    "text": 'Caroline said: "I went to the LGBTQ support group yesterday."',
                }
            ],
        )

        context = build_answer_context(
            question="When did Caroline go to the support group?",
            category=2,
            hits=[hit],
            expand_references=False,
        )

        self.assertIn("Related Memories:", context)
        self.assertIn("MEMORY: Caroline attended an LGBTQ support group on 7 May 2023.", context)
        self.assertIn("Related Sessions:", context)
        self.assertIn('SESSION D1:3', context)
        self.assertIn('TEXT: Caroline said: "I went to the LGBTQ support group yesterday."', context)
        self.assertIn("DATE: 1:56 pm on 8 May, 2023", context)
        self.assertIn("MEMORY_ID: observing:3", context)
        self.assertNotIn("compute dates", context.lower())
        self.assertNotIn("Wide detail", context)

    def test_answer_context_can_expand_direct_references(self) -> None:
        hit = RecallHit(
            memory_id="observing:3",
            evidence_ids=["D1:3"],
            date_time="1:56 pm on 8 May, 2023",
            title="Support group",
            summary="Wide summary",
            detail="Wide detail",
            matched_text="Caroline attended an LGBTQ support group on 7 May 2023.",
            references=[
                {
                    "memory_id": "session:9",
                    "source_id": "D1:3",
                    "date_time": "1:56 pm on 8 May, 2023",
                    "text": "Caroline: I went to the LGBTQ support group yesterday.",
                }
            ],
        )

        context = build_answer_context(
            question="When did Caroline go to the support group?",
            category=2,
            hits=[hit],
            expand_references=True,
        )

        self.assertIn("SESSION D1:3", context)
        self.assertIn("TEXT: Caroline: I went to the LGBTQ support group yesterday.", context)

    def test_build_qa_trace_records_context_hits_predictions_and_scores(self) -> None:
        qa = {
            "question": "When did Caroline go to the support group?",
            "category": 2,
            "answer": "7 May 2023",
            "evidence": ["D1:3"],
            "adversarial_answer": "8 May 2023",
            "muninn_top_5_prediction": "7 May 2023",
            "muninn_top_5_heuristic_prediction": "8 May 2023",
            "muninn_top_5_memory_clarity_score": 8,
            "muninn_top_5_memory_clarity_reason": "The memory states the exact date.",
            "muninn_top_5_prediction_context": ["D1:3"],
            "muninn_top_5_hits": [
                {
                    "memory_id": "observing:3",
                    "matched_text": "Caroline attended an LGBTQ support group on 7 May 2023.",
                    "evidence_ids": ["D1:3"],
                    "date_time": "1:56 pm on 8 May, 2023",
                    "title": "Support group",
                }
            ],
            "muninn_top_5_answer_context": "Question: When did Caroline go to the support group?",
        }

        trace = build_qa_trace(
            sample_id="sample-a",
            qa_index=0,
            qa=qa,
            query_candidates=["support group"],
            prediction_key="muninn_top_5_prediction",
            heuristic_key="muninn_top_5_heuristic_prediction",
        )

        scored = score_qa(qa, "muninn_top_5_prediction")
        self.assertEqual(trace["sample_id"], "sample-a")
        self.assertEqual(trace["query_candidates"], ["support group"])
        self.assertEqual(trace["hits"][0]["matched_text"], "Caroline attended an LGBTQ support group on 7 May 2023.")
        self.assertEqual(trace["heuristic_prediction"], "8 May 2023")
        self.assertEqual(trace["memory_clarity_score"], 8)
        self.assertEqual(trace["memory_clarity_reason"], "The memory states the exact date.")
        self.assertEqual(trace["f1"], round(scored.f1, 4))
        self.assertEqual(trace["recall"], 1.0)

    def test_load_answerer_config_uses_observer_llm_and_redacts_nothing_in_memory(self) -> None:
        with TemporaryDirectory() as tmpdir:
            home = Path(tmpdir)
            config = {
                "observer": {"name": "locomo-observer", "llm": "seed"},
                "llm": {
                    "seed": {
                        "provider": "mock",
                        "model": "doubao-seed",
                        "apiKey": "secret",
                    }
                },
            }
            (home / "muninn.json").write_text(json.dumps(config), encoding="utf8")
            loaded = load_answerer_config(home)

        self.assertEqual(loaded["provider"], "mock")
        self.assertEqual(loaded["model"], "doubao-seed")
        self.assertEqual(loaded["apiKey"], "secret")

    def test_llm_answerer_mock_returns_json_answer(self) -> None:
        result = run_llm_answerer(
            question="When did Caroline go to the support group?",
            category=2,
            answer_context="MATCHED_MEMORY: Caroline attended on 7 May 2023.",
            config={"provider": "mock", "model": "mock-answerer"},
        )

        self.assertEqual(result["answer"], "Mock answer")
        self.assertEqual(result["memory_clarity_score"], 1)
        self.assertIn("mock", result["memory_clarity_reason"].lower())

    def test_openai_payload_uses_concise_memory_grounded_answer_prompt(self) -> None:
        payload = build_openai_payload(
            api_style="chat_completions",
            model="mock-model",
            question="What is Caroline's identity?",
            category=1,
            answer_context="Related Memories:\n- MEMORY: Caroline found the support meaningful.",
        )
        user_prompt = payload["messages"][1]["content"]

        self.assertIn("Answer based on Related Memories and Related Sessions", user_prompt)
        self.assertIn("Use the shortest direct answer", user_prompt)
        self.assertIn("reasonable inference", user_prompt)
        self.assertIn("subjective or interpretive", user_prompt)
        self.assertIn("Not mentioned in the conversation", user_prompt)
        self.assertNotIn("Identity inference rule", user_prompt)

    def test_load_answerer_config_fails_without_observer_llm(self) -> None:
        with TemporaryDirectory() as tmpdir:
            home = Path(tmpdir)
            (home / "muninn.json").write_text('{"observer":{"name":"locomo-observer"},"llm":{}}', encoding="utf8")

            with self.assertRaisesRegex(ValueError, "observer.llm"):
                load_answerer_config(home)


if __name__ == "__main__":
    unittest.main()
