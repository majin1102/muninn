from __future__ import annotations

import json
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
BRIDGE_PACKAGE_NAME = "@muninn/benchmark-locomo"
BRIDGE_DIST = REPO_ROOT / "benchmark" / "locomo" / "dist" / "bridge.js"


class BridgeError(RuntimeError):
    """Raised when the Node bridge exits unsuccessfully."""


@dataclass
class RecallHit:
    memory_id: str
    source_id: str
    mode: str
    session_no: int
    date_time: str
    title: str | None
    summary: str | None
    detail: str | None


class MuninnBridge:
    def __init__(self, repo_root: Path | None = None) -> None:
        self.repo_root = repo_root or REPO_ROOT

    def ensure_built(self) -> None:
        if BRIDGE_DIST.exists():
            return
        self._run_process(
            [
                "pnpm",
                "--filter",
                BRIDGE_PACKAGE_NAME,
                "build",
            ]
        )

    def reset_home(self, home: Path) -> dict[str, Any]:
        return self._run_json("reset-home", muninn_home=str(home))

    def import_sample(
        self,
        data_file: Path,
        sample_id: str,
        mode: str,
        muninn_home: Path,
    ) -> dict[str, Any]:
        return self._run_json(
            "import-sample",
            data_file=str(data_file),
            sample_id=sample_id,
            mode=mode,
            muninn_home=str(muninn_home),
        )

    def recall(
        self,
        query: str,
        limit: int,
        muninn_home: Path,
    ) -> list[RecallHit]:
        payload = self._run_json(
            "recall",
            query=query,
            limit=str(limit),
            muninn_home=str(muninn_home),
        )
        hits = []
        for item in payload["hits"]:
            hits.append(
                RecallHit(
                    memory_id=item["memory_id"],
                    source_id=item["source_id"],
                    mode=item["mode"],
                    session_no=int(item["session_no"]),
                    date_time=item["date_time"],
                    title=item.get("title"),
                    summary=item.get("summary"),
                    detail=item.get("detail"),
                )
            )
        return hits

    def recall_batch(
        self,
        queries: list[dict[str, Any]],
        muninn_home: Path,
    ) -> dict[str, list[RecallHit]]:
        with tempfile.NamedTemporaryFile(
            "w",
            suffix=".json",
            delete=False,
            encoding="utf8",
        ) as handle:
            json.dump(queries, handle)
            query_file = Path(handle.name)

        try:
            payload = self._run_json(
                "recall-batch",
                queries_file=str(query_file),
                muninn_home=str(muninn_home),
            )
        finally:
            query_file.unlink(missing_ok=True)

        results: dict[str, list[RecallHit]] = {}
        for key, items in payload["results"].items():
            results[key] = [
                RecallHit(
                    memory_id=item["memory_id"],
                    source_id=item["source_id"],
                    mode=item["mode"],
                    session_no=int(item["session_no"]),
                    date_time=item["date_time"],
                    title=item.get("title"),
                    summary=item.get("summary"),
                    detail=item.get("detail"),
                )
                for item in items
            ]
        return results

    def _run_json(self, command: str, **kwargs: str) -> dict[str, Any]:
        self.ensure_built()
        args = ["node", str(BRIDGE_DIST), command]
        for key, value in kwargs.items():
            args.extend([f"--{key.replace('_', '-')}", value])
        completed = self._run_process(args)
        try:
            return json.loads(completed.stdout)
        except json.JSONDecodeError as error:
            raise BridgeError(f"invalid JSON from bridge: {error}") from error

    def _run_process(self, args: list[str]) -> subprocess.CompletedProcess[str]:
        completed = subprocess.run(
            args,
            cwd=self.repo_root,
            capture_output=True,
            text=True,
            check=False,
        )
        if completed.returncode != 0:
            raise BridgeError(
                f"bridge command failed ({completed.returncode}): "
                f"{' '.join(args)}\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
            )
        return completed
