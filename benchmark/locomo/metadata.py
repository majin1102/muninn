from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


SECRET_KEYS = {"apikey", "api_key", "token", "secret", "password", "authorization"}


def build_run_metadata(
    *,
    run_name: str,
    data_file: Path,
    out_file: Path,
    top_k: int,
    started_at: str,
    completed_at: str,
) -> dict[str, Any]:
    config_path = active_config_path()
    config = read_json_object(config_path)
    observer = config.get("observer", {}) if isinstance(config.get("observer"), dict) else {}
    observer_ref = observer.get("llm")
    observer_llm = {}
    if isinstance(observer_ref, str) and isinstance(config.get("llm"), dict):
        observer_llm = config["llm"].get(observer_ref, {}) or {}
    semantic_index = config.get("semanticIndex", {})
    embedding = semantic_index.get("embedding", {}) if isinstance(semantic_index, dict) else {}
    return {
        "run_name": run_name,
        "data_file": str(data_file),
        "out_file": str(out_file),
        "top_k": top_k,
        "started_at": started_at,
        "completed_at": completed_at,
        "config_path": str(config_path),
        "observer": {
            "name": observer.get("name"),
            "provider": observer_llm.get("provider") if isinstance(observer_llm, dict) else None,
            "model": observer_llm.get("model") if isinstance(observer_llm, dict) else None,
        },
        "embedding": {
            "provider": embedding.get("provider") if isinstance(embedding, dict) else None,
            "model": embedding.get("model") if isinstance(embedding, dict) else None,
            "dimensions": embedding.get("dimensions") if isinstance(embedding, dict) else None,
        },
        "config": redact(config),
    }


def write_run_metadata(out_file: Path, metadata: dict[str, Any]) -> Path:
    metadata_file = out_file.with_name(f"{out_file.stem}_metadata.json")
    metadata_file.parent.mkdir(parents=True, exist_ok=True)
    metadata_file.write_text(f"{json.dumps(metadata, indent=2)}\n", encoding="utf8")
    return metadata_file


def active_config_path() -> Path:
    home = os.environ.get("MUNINN_HOME")
    if home and home.strip():
        return Path(home) / "muninn.json"
    return Path.home() / ".muninn" / "muninn.json"


def read_json_object(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    value = json.loads(path.read_text(encoding="utf8"))
    return value if isinstance(value, dict) else {}


def redact(value: Any) -> Any:
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, dict):
        output: dict[str, Any] = {}
        for key, item in value.items():
            if key.lower() in SECRET_KEYS:
                output[key] = "<redacted>"
            else:
                output[key] = redact(item)
        return output
    return value
