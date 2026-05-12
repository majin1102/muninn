from __future__ import annotations

import argparse
import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
import sys
from typing import Any, Iterable

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from benchmark.locomo.scripts.openviking_judge import call_llm, first_prediction_key, optional_str
from benchmark.locomo.answering import load_answerer_config


@dataclass(frozen=True)
class JudgeItem:
    sample_id: str
    qa_index: int
    category: int
    question: str
    expected_answer: str
    actual_response: str
    evidence: list[str]
    evidence_context: str | None
    adversarial_answer: str | None = None


def build_system_prompt(context: str | None) -> str:
    return f"""You are evaluating whether a synthesized answer adequately addresses a query about a user based on available conclusions.
## EVIDENCE CONTEXT
{context if context else "No evidence provided."}
## EVALUATION CONTEXT
You will evaluate:
1. **Query**: The specific question asked about the user
2. **Synthesized Answer**: The response generated from available conclusions
3. **Gold Standard Answer**: The expected/correct answer
## EVALUATION CRITERIA
Judge the synthesized answer as SUFFICIENT or INSUFFICIENT based on:
### Content Completeness
- Does the answer address what the query is asking?
- Are all key aspects of the gold answer covered (even if phrased differently)?
- Is critical information missing that would change the answer's usefulness?
### Semantic Accuracy
- Are any factual errors or contradictions present?
## ACCEPTABLE DIFFERENCES
The following differences are ACCEPTABLE and should NOT result in INSUFFICIENT:
- Different phrasing or word choice that still conveys the same or very similar meaning, especially in cases where the question is tentative or open-ended.
- Additional relevant context beyond the gold answer (including evidence supplied above). This includes the case where the synthesized answer is longer and more detailed than the gold answer, potentially even including additional information that is not explicitly stated in the gold answer but is still broadly relevant to the query. Do NOT penalize the synthesized answer for including additional information that is not explicitly stated in the gold answer.
- **The synthesized answer explicitly includes the full gold answer text (even if surrounded by additional or unrelated details).  If the gold answer appears within the synthesized answer, you MUST mark the answer as SUFFICIENT.**
- More detailed explanations of reasoning or evidence
- Appropriate confidence qualifiers (e.g., "likely", "probably") when warranted
- Differences in length, with the synthesized answer being longer and even more circuitous or indirect in its addressing of the query, as long as it conveys the same meaning
- Minor format or structure variations
## EVIDENCE-GOLD ANSWER CONSISTENCY CHECK
It is possible for the gold answers to be wrong. Sometimes it may not be fully supported by or follow logically from the evidence messages, instead constituting a guess or assumption. Additionally, the gold answers are generated automatically based on the limited set of evidence messages provided above, whereas if additional context were to be taken into account, the answer might be different. In these cases, we must not penalize the synthesized answer for not being exactly the same as the gold answer.
Before deciding, verify whether the gold answer logically and necessarily follows from the supplied evidence context. If you identify a mismatch or missing logical link **and** the synthesized answer acknowledges this uncertainty or provides a more cautious, evidence-grounded explanation (optionally leveraging additional context beyond the ground truth evidence above), treat the synthesized answer as SUFFICIENT even when it diverges in wording or conclusion from the gold answer.  In short:
* If the gold answer over-claims beyond what the evidence shows, do **not** penalize a synthesized answer that appropriately qualifies the claim or offers a plausible alternative consistent with evidence.
* This includes the case where the synthesized answer is ambivalent or uncertain about the answer, as long as it provides sufficient evidence to support not providing a definitive, categorical answer.
* If the synthesized answer clearly explains the gap and gives a better-supported conclusion, mark it SUFFICIENT.
## UNACCEPTABLE DIFFERENCES
The following DO warrant an INSUFFICIENT rating:
- Irreconcilable errors or contradictions with the gold answer **and** the evidence context
- Missing information central to answering the query, such that its absence would change the meaning of the answer
- Does not address the question being asked
## YOUR TASK
First, analyze what the query is asking **and** how well both answers are supported by the evidence context.
Then, provide 2 brief 2-3 sentence arguments for both SUFFICIENT and INSUFFICIENT:
**Arguments for SUFFICIENT:**
- List reasons why the synthesized answer adequately addresses the query
- Note what key information from the gold answer is present or why deviations are justified by the evidence
- Note whether the gold answer is wrong or not necessarily true given the evidence above
**Arguments for INSUFFICIENT:**
- List reasons why the synthesized answer fails to address the question.

Based on weighing these arguments, provide 2-3 sentences to determine if the synthesized answer is sufficient. In your weighing, consider whether the synthesized answer might be a better answer than the gold answer given the evidence above.
Finally, set is_sufficient to true if sufficient or false if insufficient.
Your response MUST be a valid JSON object with EXACTLY these keys:
  - arguments_for_sufficient (string)
  - arguments_for_insufficient (string)
  - final_reasoning (string)
  - is_sufficient (boolean)
Return ONLY this JSON object and nothing else."""


def build_user_prompt(*, question: str, answer: str, response: str) -> str:
    return f"""Query: {question}
Gold Answer: {answer}
Synthesized Answer: {response}"""


def iter_judge_items(
    samples: list[dict[str, Any]],
    prediction_key: str | None,
    conversations: dict[str, dict[str, Any]],
) -> Iterable[JudgeItem]:
    for sample in samples:
        sample_id = str(sample.get("sample_id") or "")
        qa_list = sample.get("qa")
        if not isinstance(qa_list, list):
            continue
        conversation = conversations.get(sample_id, {})
        for index, qa in enumerate(qa_list):
            if not isinstance(qa, dict) or qa.get("category") == 5:
                continue
            key = prediction_key or first_prediction_key(qa)
            if not key:
                continue
            evidence = [str(value) for value in qa.get("evidence") or [] if isinstance(value, str)]
            yield JudgeItem(
                sample_id=sample_id,
                qa_index=index,
                category=int(qa.get("category") or 0),
                question=str(qa.get("question") or ""),
                expected_answer=str(qa.get("answer") or ""),
                actual_response=str(qa.get(key) or "").strip(),
                evidence=evidence,
                evidence_context=get_evidence_context(conversation, evidence),
                adversarial_answer=optional_str(qa.get("adversarial_answer")),
            )


def load_conversations(data_file: Path | None) -> dict[str, dict[str, Any]]:
    if data_file is None:
        return {}
    data = json.loads(data_file.read_text(encoding="utf8"))
    conversations: dict[str, dict[str, Any]] = {}
    for sample in data:
        if not isinstance(sample, dict):
            continue
        sample_id = str(sample.get("sample_id") or "")
        conversation = sample.get("conversation")
        if sample_id and isinstance(conversation, dict):
            conversations[sample_id] = conversation
    return conversations


def get_evidence_context(conversation: dict[str, Any], evidence_ids: list[str]) -> str | None:
    if not conversation or not evidence_ids:
        return None
    all_messages = extract_all_messages(conversation)
    dia_id_to_msg = {msg["dia_id"]: msg for msg in all_messages if msg.get("dia_id")}
    lines: list[str] = []
    for evidence_id in evidence_ids:
        msg = dia_id_to_msg.get(evidence_id)
        if not msg:
            continue
        text = msg["text"]
        if msg.get("blip_caption"):
            text = f"{text} [Image: {msg['blip_caption']}]"
        lines.append(f"[{evidence_id}] {msg['speaker']}: {text}")
    return "\n".join(lines) if lines else None


def extract_all_messages(conversation: dict[str, Any]) -> list[dict[str, str]]:
    messages: list[dict[str, str]] = []
    session_keys = sorted(
        [key for key in conversation if key.startswith("session_") and key.split("_")[-1].isdigit()],
        key=lambda key: int(key.split("_")[-1]),
    )
    for session_key in session_keys:
        session = conversation.get(session_key)
        if not isinstance(session, list):
            continue
        for msg in session:
            if not isinstance(msg, dict):
                continue
            item = {
                "speaker": str(msg.get("speaker") or ""),
                "text": str(msg.get("text") or ""),
                "dia_id": str(msg.get("dia_id") or ""),
            }
            if msg.get("blip_caption"):
                item["blip_caption"] = str(msg.get("blip_caption"))
            messages.append(item)
    return messages


def parse_judge_response(raw: str) -> dict[str, Any]:
    start = raw.find("{")
    end = raw.rfind("}")
    if start < 0 or end < start:
        raise ValueError(f"judge response did not contain JSON: {raw}")
    parsed = json.loads(raw[start : end + 1])
    return {
        "passed": bool(parsed.get("is_sufficient", False)),
        "reasoning": str(parsed.get("final_reasoning") or ""),
        "arguments_for_sufficient": str(parsed.get("arguments_for_sufficient") or ""),
        "arguments_for_insufficient": str(parsed.get("arguments_for_insufficient") or ""),
    }


def judge_item(item: JudgeItem, config: dict[str, Any]) -> dict[str, Any]:
    raw = call_llm(
        config,
        system=build_system_prompt(item.evidence_context),
        prompt=build_user_prompt(
            question=item.question,
            answer=item.expected_answer,
            response=item.actual_response,
        ),
    )
    judged = parse_judge_response(raw)
    return {
        "sample_id": item.sample_id,
        "qa_index": item.qa_index,
        "category": item.category,
        "question": item.question,
        "gold_answer": item.expected_answer,
        "generated_answer": item.actual_response,
        "evidence": item.evidence,
        "evidence_context": item.evidence_context,
        "adversarial_answer": item.adversarial_answer,
        **judged,
    }


def summarize(source: str, items: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(items)
    passed = sum(1 for item in items if item["passed"])
    by_category: dict[str, dict[str, Any]] = {}
    for item in items:
        bucket = by_category.setdefault(str(item["category"]), {"total": 0, "passed": 0})
        bucket["total"] += 1
        if item["passed"]:
            bucket["passed"] += 1
    for bucket in by_category.values():
        bucket["accuracy"] = round(bucket["passed"] / bucket["total"], 4) if bucket["total"] else 0.0
    return {
        "source": source,
        "standard": "honcho_locomo_sufficient",
        "excluded_categories": [5],
        "items": items,
        "accuracy": {
            "passed": passed,
            "total": total,
            "accuracy": round(passed / total, 4) if total else 0.0,
        },
        "category": by_category,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Score LoCoMo answers with Honcho's LoCoMo sufficiency judge.")
    parser.add_argument("input_result", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--data-file", type=Path)
    parser.add_argument("--prediction-key")
    parser.add_argument("--home", type=Path, default=Path.cwd())
    parser.add_argument("--parallel", type=int, default=5)
    args = parser.parse_args()

    samples = json.loads(args.input_result.read_text(encoding="utf8"))
    conversations = load_conversations(args.data_file)
    config = load_answerer_config(args.home)
    items = list(iter_judge_items(samples, args.prediction_key, conversations))
    judged: list[dict[str, Any] | None] = [None] * len(items)
    with ThreadPoolExecutor(max_workers=max(1, args.parallel)) as executor:
        futures = {
            executor.submit(judge_item, item, config): index
            for index, item in enumerate(items)
        }
        for count, future in enumerate(as_completed(futures), start=1):
            judged[futures[future]] = future.result()
            if count == 1 or count % 10 == 0:
                print(f"[honcho_judge] {count}/{len(items)}", flush=True)
            time.sleep(0.01)
    summary = summarize(str(args.input_result), [item for item in judged if item is not None])
    args.output.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf8")
    print(json.dumps(summary["accuracy"], indent=2), flush=True)


if __name__ == "__main__":
    main()
