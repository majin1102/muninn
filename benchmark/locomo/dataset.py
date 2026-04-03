from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass
class LocomoQuestion:
    question: str
    category: int
    evidence: list[str]
    answer: str | None = None
    adversarial_answer: str | None = None


def load_samples(data_file: Path) -> list[dict[str, Any]]:
    return json.loads(data_file.read_text(encoding="utf8"))


def iter_target_samples(
    samples: list[dict[str, Any]],
    sample_id: str | None,
) -> list[dict[str, Any]]:
    if sample_id is None:
        return samples
    return [sample for sample in samples if sample["sample_id"] == sample_id]
