from __future__ import annotations

import json
import os
import selectors
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
BRIDGE_PACKAGE_NAME = "@muninn/benchmark-locomo"
BRIDGE_DIST = REPO_ROOT / "benchmark" / "locomo" / "dist" / "bridge.js"
BOOTSTRAP_SCRIPT = REPO_ROOT / "benchmark" / "locomo" / "scripts" / "bootstrap.sh"


class BridgeError(RuntimeError):
    """Raised when the Node bridge exits unsuccessfully."""


@dataclass
class RecallHit:
    memory_id: str
    evidence_ids: list[str]
    date_time: str
    title: str | None
    summary: str | None
    detail: str | None


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
                    evidence_ids=[str(value) for value in item.get("evidence_ids", [])],
                    date_time=item.get("date_time") or "",
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
                    evidence_ids=[str(value) for value in item.get("evidence_ids", [])],
                    date_time=item.get("date_time") or "",
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
        process = subprocess.Popen(
            args,
            cwd=self.repo_root,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=self._subprocess_env(),
        )
        stdout_chunks: list[str] = []
        stderr_chunks: list[str] = []
        selector = selectors.DefaultSelector()
        if process.stdout is not None:
            selector.register(process.stdout, selectors.EVENT_READ)
        if process.stderr is not None:
            selector.register(process.stderr, selectors.EVENT_READ)
        while selector.get_map():
            for key, _ in selector.select():
                chunk = key.fileobj.readline()
                if chunk == "":
                    selector.unregister(key.fileobj)
                    key.fileobj.close()
                    continue
                if key.fileobj is process.stdout:
                    stdout_chunks.append(chunk)
                else:
                    stderr_chunks.append(chunk)
                    sys.stderr.write(chunk)
                    sys.stderr.flush()
        returncode = process.wait()
        completed = subprocess.CompletedProcess(
            args=args,
            returncode=returncode,
            stdout="".join(stdout_chunks),
            stderr="".join(stderr_chunks),
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
