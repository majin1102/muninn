from __future__ import annotations

import re
from collections import Counter
from typing import Iterable


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
