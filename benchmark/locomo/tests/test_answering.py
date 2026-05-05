from __future__ import annotations

import json
import os
import unittest
from base64 import urlsafe_b64encode
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from benchmark.common.muninn_bridge import RecallHit
from benchmark.locomo.answering import (
    build_openai_payload,
    build_answer_context,
    build_qa_trace,
    load_answerer_config,
    run_llm_answerer,
)
from benchmark.locomo.scoring import score_qa


def base64_url_json(value: dict[str, object]) -> str:
    return urlsafe_b64encode(json.dumps(value).encode("utf8")).decode("utf8").rstrip("=")


def make_jwt(exp: int = 4_102_444_800) -> str:
    return f"{base64_url_json({'alg': 'none'})}.{base64_url_json({'exp': exp})}.signature"


class AnsweringTests(unittest.TestCase):
    def test_answer_context_includes_related_memories_only(self) -> None:
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
        self.assertIn("DATE: 1:56 pm on 8 May, 2023", context)
        self.assertIn("MEMORY_ID: observing:3", context)
        self.assertNotIn("Related Sessions:", context)
        self.assertNotIn('SESSION D1:3', context)
        self.assertNotIn('TEXT: Caroline said: "I went to the LGBTQ support group yesterday."', context)
        self.assertNotIn("compute dates", context.lower())
        self.assertNotIn("Wide detail", context)

    def test_answer_context_does_not_expand_direct_references(self) -> None:
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

        self.assertIn("MEMORY: Caroline attended an LGBTQ support group on 7 May 2023.", context)
        self.assertNotIn("SESSION D1:3", context)
        self.assertNotIn("TEXT: Caroline: I went to the LGBTQ support group yesterday.", context)

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

    def test_llm_answerer_openai_codex_uses_codex_cli_auth(self) -> None:
        captured = {}

        class FakeResponse:
            def __enter__(self) -> "FakeResponse":
                return self

            def __exit__(self, *args: object) -> None:
                return None

            def read(self) -> bytes:
                return (
                    "data: "
                    + json.dumps({
                        "type": "response.output_text.delta",
                        "delta": json.dumps({
                            "answer": "7 May 2023",
                            "memory_clarity_score": 9,
                            "memory_clarity_reason": "The memory states the date.",
                        }),
                    })
                    + "\n\ndata: [DONE]\n\n"
                ).encode("utf8")

        def fake_urlopen(request, timeout):  # type: ignore[no-untyped-def]
            captured["url"] = request.full_url
            captured["timeout"] = timeout
            captured["headers"] = dict(request.header_items())
            captured["body"] = json.loads(request.data.decode("utf8"))
            return FakeResponse()

        previous_codex_home = os.environ.get("CODEX_HOME")
        with TemporaryDirectory() as tmpdir:
            codex_home = Path(tmpdir)
            (codex_home / "auth.json").write_text(
                json.dumps({
                    "auth_mode": "chatgpt",
                    "tokens": {"access_token": make_jwt()},
                }),
                encoding="utf8",
            )
            os.environ["CODEX_HOME"] = str(codex_home)
            try:
                with patch("urllib.request.urlopen", fake_urlopen):
                    result = run_llm_answerer(
                        question="When did Caroline go to the support group?",
                        category=2,
                        answer_context="MEMORY: Caroline attended on 7 May 2023.",
                        config={"provider": "openai-codex", "model": "gpt-5.4-mini"},
                    )
            finally:
                if previous_codex_home is None:
                    os.environ.pop("CODEX_HOME", None)
                else:
                    os.environ["CODEX_HOME"] = previous_codex_home

        self.assertEqual(result["answer"], "7 May 2023")
        self.assertEqual(result["memory_clarity_score"], 9)
        self.assertEqual(captured["url"], "https://chatgpt.com/backend-api/codex/responses")
        self.assertEqual(captured["timeout"], 120)
        self.assertIn("Bearer ", captured["headers"]["Authorization"])
        self.assertEqual(captured["body"]["model"], "gpt-5.4-mini")
        self.assertEqual(captured["body"]["instructions"], "You answer LoCoMo benchmark questions using only the provided Muninn memory context. Return JSON only with answer, memory_clarity_score, and memory_clarity_reason.")
        self.assertEqual(captured["body"]["store"], False)
        self.assertEqual(captured["body"]["stream"], True)
        self.assertEqual(captured["body"]["input"][0]["role"], "user")

    def test_openai_payload_uses_concise_memory_grounded_answer_prompt(self) -> None:
        payload = build_openai_payload(
            api_style="chat_completions",
            model="mock-model",
            question="What is Caroline's identity?",
            category=1,
            answer_context="Related Memories:\n- MEMORY: Caroline found the support meaningful.",
        )
        user_prompt = payload["messages"][1]["content"]

        self.assertIn("Answer based on Related Memories", user_prompt)
        self.assertNotIn("Related Memories and Related Sessions", user_prompt)
        self.assertIn("Use the shortest direct answer", user_prompt)
        self.assertIn("For dates, years, names, places, or short phrases", user_prompt)
        self.assertIn("output only the factual span itself", user_prompt)
        self.assertIn("reasonable inference", user_prompt)
        self.assertIn("subjective or interpretive", user_prompt)
        self.assertIn("Not mentioned in the conversation", user_prompt)
        self.assertNotIn("Identity inference rule", user_prompt)

    def test_openai_payload_does_not_add_locomo_approximate_date_instruction(self) -> None:
        payload = build_openai_payload(
            api_style="chat_completions",
            model="mock-model",
            question="When did Caroline go to the LGBTQ support group?",
            category=2,
            answer_context="Related Memories:\n- MEMORY: Caroline attended on 7 May 2023.",
        )
        user_prompt = payload["messages"][1]["content"]

        self.assertIn("Question: When did Caroline go to the LGBTQ support group?", user_prompt)
        self.assertNotIn("Use DATE of CONVERSATION to answer with an approximate date", user_prompt)

    def test_load_answerer_config_fails_without_observer_llm(self) -> None:
        with TemporaryDirectory() as tmpdir:
            home = Path(tmpdir)
            (home / "muninn.json").write_text('{"observer":{"name":"locomo-observer"},"llm":{}}', encoding="utf8")

            with self.assertRaisesRegex(ValueError, "observer.llm"):
                load_answerer_config(home)


if __name__ == "__main__":
    unittest.main()
