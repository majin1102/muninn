from __future__ import annotations

import re
import string
from collections import Counter
from typing import Iterable

from benchmark.common.muninn_bridge import RecallHit


STOPWORDS = {
    "a",
    "an",
    "and",
    "are",
    "did",
    "do",
    "does",
    "for",
    "from",
    "had",
    "has",
    "have",
    "her",
    "his",
    "in",
    "is",
    "it",
    "of",
    "on",
    "she",
    "the",
    "their",
    "they",
    "to",
    "was",
    "what",
    "when",
    "where",
    "which",
    "who",
    "why",
}

DATE_PATTERN = re.compile(r"\b\d{1,2}:\d{2}\s*[ap]m on \d{1,2}\s+[A-Za-z]+,\s+\d{4}\b", re.IGNORECASE)
SENTENCE_SPLIT = re.compile(r"[\n.!?;]+")
PHRASE_SPLIT = re.compile(r"[,/]")


def build_prediction(question: str, category: int, hits: list[RecallHit]) -> str:
    if not hits:
        return "Not mentioned in the conversation" if category == 5 else ""

    if category == 2:
        date_answer = best_date_answer(question, hits)
        if date_answer:
            return date_answer

    candidates = ranked_candidates(question, hits)
    if category == 5:
        if not candidates or candidates[0][1] < 1.5:
            return "Not mentioned in the conversation"
        return clean_answer(candidates[0][0])

    if category in {1, 3}:
        top_chunks = []
        for text, score in candidates[:3]:
            if score < 1.0:
                continue
            top_chunks.append(clean_answer(text))
        unique = dedupe_preserving_order(top_chunks)
        if unique:
            return ", ".join(unique[:3])

    if candidates:
        return clean_answer(candidates[0][0])

    return clean_answer(best_context_text(hits[0]))


def build_query_candidates(question: str) -> list[str]:
    raw_tokens = re.findall(r"[A-Za-z0-9']+", question)
    significant = [token.lower() for token in raw_tokens if token.lower() not in STOPWORDS]
    candidates: list[str] = []

    max_window = min(3, len(significant))
    for window in range(max_window, 0, -1):
        for index in range(0, len(significant) - window + 1):
            phrase = " ".join(significant[index:index + window]).strip()
            if len(phrase) >= 4:
                candidates.append(phrase)

    full_question = question.strip().rstrip("?")
    if full_question:
        candidates.append(full_question)

    return dedupe_preserving_order(candidates)


def best_date_answer(question: str, hits: list[RecallHit]) -> str | None:
    _ = question
    for hit in hits:
      candidate = extract_date(hit.date_time)
      if candidate:
          return candidate
      match = DATE_PATTERN.search(best_context_text(hit))
      if match:
          return extract_date(match.group(0))
    return None


def extract_date(value: str) -> str | None:
    match = re.search(r"(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})", value)
    if not match:
        return None
    day, month, year = match.groups()
    return f"{int(day)} {month} {year}"


def ranked_candidates(question: str, hits: list[RecallHit]) -> list[tuple[str, float]]:
    question_tokens = set(query_tokens(question))
    ranked: list[tuple[str, float]] = []
    for hit_index, hit in enumerate(hits):
        for fragment in candidate_fragments(hit):
            score = candidate_score(fragment, question_tokens, hit_index)
            if score > 0:
                ranked.append((fragment, score))
    ranked.sort(key=lambda item: item[1], reverse=True)
    return ranked


def candidate_fragments(hit: RecallHit) -> list[str]:
    fragments = []
    for raw in filter(None, [hit.summary, hit.detail]):
        for sentence in SENTENCE_SPLIT.split(raw):
            sentence = sentence.strip()
            if not sentence:
                continue
            fragments.append(sentence)
            for phrase in PHRASE_SPLIT.split(sentence):
                phrase = phrase.strip()
                if len(phrase) >= 3:
                    fragments.append(phrase)
    if hit.date_time:
        fragments.append(hit.date_time)
    return dedupe_preserving_order(fragments)


def candidate_score(fragment: str, question_tokens: set[str], hit_index: int) -> float:
    fragment_tokens = set(query_tokens(fragment))
    if not fragment_tokens:
        return 0.0
    overlap = len(question_tokens & fragment_tokens)
    if overlap == 0:
        return 0.0
    length_penalty = max(0.0, (len(fragment.split()) - 10) * 0.08)
    position_bonus = max(0.0, 0.6 - (hit_index * 0.1))
    return overlap + position_bonus - length_penalty


def query_tokens(text: str) -> list[str]:
    lowered = text.lower().translate(str.maketrans("", "", string.punctuation))
    return [token for token in lowered.split() if token and token not in STOPWORDS]


def best_context_text(hit: RecallHit) -> str:
    return hit.summary or hit.detail or hit.title or ""


def clean_answer(text: str) -> str:
    text = text.replace("Prompt:", "").replace("Response:", "").strip()
    text = re.sub(r"\s+", " ", text)
    return text.strip(" -:")


def dedupe_preserving_order(values: Iterable[str]) -> list[str]:
    seen: Counter[str] = Counter()
    output = []
    for value in values:
        normalized = value.strip().lower()
        if not normalized or seen[normalized]:
            continue
        seen[normalized] += 1
        output.append(value.strip())
    return output
