from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
BRIDGE_PACKAGE_NAME = "@muninn/benchmark-locomo"
BRIDGE_DIST = REPO_ROOT / "benchmark" / "locomo" / "dist" / "bridge.js"
BOOTSTRAP_SCRIPT = REPO_ROOT / "benchmark" / "locomo" / "scripts" / "bootstrap.sh"
NODE_BINARY_ENV = "MUNINN_NODE_BINARY"


class BridgeError(RuntimeError):
    """Raised when the Node bridge exits unsuccessfully."""


@dataclass
class RecallHit:
    memory_id: str
    evidence_ids: list[str]
    detail: str | None
    matched_text: str = ""
    references: list[dict[str, Any]] | None = None
    observation_ratio: float | None = None

    def __post_init__(self) -> None:
        if self.references is None:
            self.references = []


class MuninnBridge:
    def __init__(self, repo_root: Path | None = None) -> None:
        self.repo_root = repo_root or REPO_ROOT
        self._bootstrapped = False

    def ensure_built(self) -> None:
        if self._bootstrapped:
            return
        self._run_process(["sh", str(BOOTSTRAP_SCRIPT)])
        self._bootstrapped = True

    def reset_home(self, home: Path) -> dict[str, Any]:
        return self._run_json("reset-home", muninn_home=str(home))

    def import_sample(
        self,
        data_file: Path,
        sample_id: str,
        muninn_home: Path,
    ) -> dict[str, Any]:
        return self._run_json(
            "import-sample",
            data_file=str(data_file),
            sample_id=sample_id,
            muninn_home=str(muninn_home),
        )

    def recall(
        self,
        query: str,
        limit: int,
        muninn_home: Path,
        recall_mode: str = "hybrid",
        budget: int = 0,
        query_limit: int | None = None,
        skip_watermark: bool = False,
    ) -> list[RecallHit]:
        kwargs = {
            "query": query,
            "limit": str(limit),
            "muninn_home": str(muninn_home),
            "recall_mode": recall_mode,
        }
        if budget > 0:
            kwargs["budget"] = str(budget)
            if query_limit is not None:
                kwargs["query_limit"] = str(query_limit)
        if skip_watermark:
            kwargs["skip_watermark"] = "1"
        payload = self._run_json("recall", **kwargs)
        hits = []
        for item in payload["hits"]:
            hits.append(
                RecallHit(
                    memory_id=item["memory_id"],
                    evidence_ids=[str(value) for value in item.get("evidence_ids", [])],
                    detail=item.get("detail"),
                    matched_text=item.get("matched_text") or "",
                    references=item.get("references") or [],
                    observation_ratio=item.get("observationRatio"),
                )
            )
        return hits

    def recall_batch(
        self,
        queries: list[dict[str, Any]],
        muninn_home: Path,
        recall_mode: str = "hybrid",
        budget: int = 0,
        query_limit: int | None = None,
        skip_watermark: bool = False,
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
            kwargs = {
                "queries_file": str(query_file),
                "muninn_home": str(muninn_home),
                "recall_mode": recall_mode,
            }
            if budget > 0:
                kwargs["budget"] = str(budget)
                if query_limit is not None:
                    kwargs["query_limit"] = str(query_limit)
            if skip_watermark:
                kwargs["skip_watermark"] = "1"
            payload = self._run_json("recall-batch", **kwargs)
        finally:
            query_file.unlink(missing_ok=True)

        results: dict[str, list[RecallHit]] = {}
        for key, items in payload["results"].items():
            results[key] = [
                RecallHit(
                    memory_id=item["memory_id"],
                    evidence_ids=[str(value) for value in item.get("evidence_ids", [])],
                    detail=item.get("detail"),
                    matched_text=item.get("matched_text") or "",
                    references=item.get("references") or [],
                    observation_ratio=item.get("observationRatio"),
                )
                for item in items
            ]
        return results

    def _run_json(self, command: str, **kwargs: str) -> dict[str, Any]:
        self.ensure_built()
        args = [node_binary(), str(BRIDGE_DIST), command]
        for key, value in kwargs.items():
            args.extend([f"--{key.replace('_', '-')}", value])
        completed = self._run_process(args)
        try:
            return json.loads(completed.stdout)
        except json.JSONDecodeError as error:
            raise BridgeError(f"invalid JSON from bridge: {error}") from error

    def _run_process(self, args: list[str]) -> subprocess.CompletedProcess[str]:
        process = subprocess.Popen(
            args,
            cwd=self.repo_root,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=False,
            bufsize=0,
            env=self._subprocess_env(),
        )
        stdout_chunks: list[bytes] = []
        stderr_chunks: list[bytes] = []

        def read_stdout() -> None:
            assert process.stdout is not None
            with process.stdout:
                while True:
                    chunk = process.stdout.read(4096)
                    if not chunk:
                        break
                    stdout_chunks.append(chunk)

        def read_stderr() -> None:
            assert process.stderr is not None
            with process.stderr:
                while True:
                    chunk = process.stderr.read(4096)
                    if not chunk:
                        break
                    stderr_chunks.append(chunk)
                    text = chunk.decode("utf-8", errors="replace")
                    sys.stderr.write(text)
                    sys.stderr.flush()

        stdout_thread = threading.Thread(target=read_stdout, daemon=True)
        stderr_thread = threading.Thread(target=read_stderr, daemon=True)
        stdout_thread.start()
        stderr_thread.start()
        returncode = process.wait()
        stdout_thread.join()
        stderr_thread.join()
        completed = subprocess.CompletedProcess(
            args=args,
            returncode=returncode,
            stdout=b"".join(stdout_chunks).decode("utf-8", errors="replace"),
            stderr=b"".join(stderr_chunks).decode("utf-8", errors="replace"),
        )
        if completed.returncode != 0:
            raise BridgeError(
                f"bridge command failed ({completed.returncode}): "
                f"{' '.join(args)}\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
            )
        return completed

    def _subprocess_env(self) -> dict[str, str]:
        env = os.environ.copy()
        if "PATH" not in env or not env["PATH"].strip():
            env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
        return env


def node_binary() -> str:
    value = os.environ.get(NODE_BINARY_ENV, "").strip()
    return value or "node"
