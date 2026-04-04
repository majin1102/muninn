from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


VALID_MODES = ("dialog", "observation", "summary")


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


def parse_modes(raw: str) -> list[str]:
    modes = [mode.strip() for mode in raw.split(",") if mode.strip()]
    if not modes:
        raise ValueError("at least one LoCoMo mode is required")

    invalid = [mode for mode in modes if mode not in VALID_MODES]
    if invalid:
        valid = ", ".join(VALID_MODES)
        bad = ", ".join(invalid)
        raise ValueError(f"unsupported LoCoMo modes: {bad}. Expected one or more of: {valid}")

    seen: set[str] = set()
    ordered: list[str] = []
    for mode in modes:
        if mode in seen:
            continue
        seen.add(mode)
        ordered.append(mode)
    return ordered
