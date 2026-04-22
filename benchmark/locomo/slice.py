from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class SliceResult:
    sample: dict[str, Any]
    summary: dict[str, Any]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-file", required=True, type=Path)
    parser.add_argument("--sample-id", required=True)
    parser.add_argument("--max-session", required=True, type=int)
    parser.add_argument("--out-file", required=True, type=Path)
    parser.add_argument("--summary-file", required=True, type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    result = build_slice(args.data_file, args.sample_id, args.max_session)
    write_slice(result, args.out_file, args.summary_file)
    print(json.dumps(result.summary, indent=2))


def build_slice(data_file: Path, sample_id: str, max_session: int) -> SliceResult:
    if max_session <= 0:
        raise ValueError("no QA rows remain after filtering: max_session must be positive")
    samples = json.loads(data_file.read_text(encoding="utf8"))
    source = next((item for item in samples if item.get("sample_id") == sample_id), None)
    if source is None:
        raise ValueError(f"LoCoMo sample not found: {sample_id} in {data_file}")

    conversation = source.get("conversation", {})
    retained_conversation: dict[str, Any] = {}
    for key in ("speaker_a", "speaker_b"):
        if key in conversation:
            retained_conversation[key] = conversation[key]

    retained_dialog_ids: list[str] = []
    retained_sessions: list[int] = []
    for session_no in range(1, max_session + 1):
        session_key = f"session_{session_no}"
        date_key = f"session_{session_no}_date_time"
        dialogs = conversation.get(session_key)
        if not isinstance(dialogs, list):
            continue
        retained_sessions.append(session_no)
        if date_key in conversation:
            retained_conversation[date_key] = conversation[date_key]
        retained_conversation[session_key] = dialogs
        retained_dialog_ids.extend(
            str(dialog.get("dia_id", ""))
            for dialog in dialogs
            if dialog.get("dia_id")
        )

    retained_id_set = set(retained_dialog_ids)
    qas = [
        qa
        for qa in source.get("qa", [])
        if qa_evidence_contained(qa, retained_id_set)
    ]
    if not qas:
        raise ValueError(
            f"no QA rows remain after filtering sample_id={sample_id} max_session={max_session}"
        )

    sample = {
        "sample_id": source["sample_id"],
        "conversation": retained_conversation,
        "qa": qas,
    }
    if "observation" in source:
        observation = slice_session_map(source["observation"], retained_sessions)
        if observation:
            sample["observation"] = observation
    if "session_summary" in source:
        summary = slice_session_map(source["session_summary"], retained_sessions)
        if summary:
            sample["session_summary"] = summary

    category_counts: dict[str, int] = {}
    for qa in qas:
        key = str(qa.get("category"))
        category_counts[key] = category_counts.get(key, 0) + 1

    summary = {
        "source_path": str(data_file),
        "source_sha256": sha256_file(data_file),
        "sample_id": sample_id,
        "max_session": max_session,
        "retained_sessions": retained_sessions,
        "retained_dialog_ids": retained_dialog_ids,
        "turn_count": len(retained_dialog_ids),
        "qa_count": len(qas),
        "category_counts": dict(sorted(category_counts.items())),
    }
    return SliceResult(sample=sample, summary=summary)


def qa_evidence_contained(qa: dict[str, Any], retained_ids: set[str]) -> bool:
    evidence = qa.get("evidence")
    return (
        isinstance(evidence, list)
        and bool(evidence)
        and all(str(item) in retained_ids for item in evidence)
    )


def slice_session_map(value: Any, retained_sessions: list[int]) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    prefixes = tuple(f"session_{session_no}_" for session_no in retained_sessions)
    return {
        key: item
        for key, item in value.items()
        if key.startswith(prefixes)
    }


def write_slice(result: SliceResult, out_file: Path, summary_file: Path) -> None:
    out_file.parent.mkdir(parents=True, exist_ok=True)
    summary_file.parent.mkdir(parents=True, exist_ok=True)
    enriched_summary = {
        **result.summary,
        "output_path": str(out_file),
        "summary_path": str(summary_file),
    }
    out_file.write_text(f"{json.dumps([result.sample], indent=2)}\n", encoding="utf8")
    summary_file.write_text(f"{json.dumps(enriched_summary, indent=2)}\n", encoding="utf8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


if __name__ == "__main__":
    main()
