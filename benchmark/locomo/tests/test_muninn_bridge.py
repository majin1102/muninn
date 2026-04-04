from __future__ import annotations

import contextlib
import io
import os
import unittest
from pathlib import Path
from unittest.mock import MagicMock

from benchmark.common.muninn_bridge import BOOTSTRAP_SCRIPT, MuninnBridge


class MuninnBridgeTests(unittest.TestCase):
    def test_ensure_built_runs_bootstrap_once(self) -> None:
        bridge = MuninnBridge()
        bridge._run_process = MagicMock()

        bridge.ensure_built()
        bridge.ensure_built()

        self.assertEqual(
            bridge._run_process.call_args_list,
            [
                unittest.mock.call(
                    ["sh", str(BOOTSTRAP_SCRIPT)],
                ),
            ],
        )

    def test_ensure_built_retries_when_bootstrap_fails(self) -> None:
        bridge = MuninnBridge()
        bridge._run_process = MagicMock(
            side_effect=[RuntimeError("bootstrap failed"), None]
        )

        with self.assertRaisesRegex(RuntimeError, "bootstrap failed"):
            bridge.ensure_built()

        bridge.ensure_built()

        self.assertEqual(
            bridge._run_process.call_args_list,
            [
                unittest.mock.call(
                    ["sh", str(BOOTSTRAP_SCRIPT)],
                ),
                unittest.mock.call(
                    ["sh", str(BOOTSTRAP_SCRIPT)],
                ),
            ],
        )

    def test_run_process_streams_and_returns_output_without_check_argument(self) -> None:
        bridge = MuninnBridge()

        with contextlib.redirect_stderr(io.StringIO()):
            completed = bridge._run_process(
                [
                    os.environ.get("PYTHON", "python3"),
                    "-c",
                    "import sys; print('ok'); print('warn', file=sys.stderr)",
                ]
            )

        self.assertEqual(completed.returncode, 0)
        self.assertEqual(completed.stdout.strip(), "ok")
        self.assertIn("warn", completed.stderr)

    def test_recall_batch_parses_evidence_ids(self) -> None:
        bridge = MuninnBridge()
        bridge.ensure_built = MagicMock()
        bridge._run_json = MagicMock(
            return_value={
                "results": {
                    "0:0": [
                        {
                            "memory_id": "observing:1",
                            "evidence_ids": ["D1:1", "D1:2"],
                            "date_time": "1:56 pm on 8 May, 2023",
                            "title": "title",
                            "summary": "summary",
                            "detail": "detail",
                        }
                    ]
                }
            }
        )

        results = bridge.recall_batch(
            [{"key": "0:0", "query": "support group", "limit": 5}],
            Path("/tmp/muninn-home"),
        )

        self.assertEqual(results["0:0"][0].memory_id, "observing:1")
        self.assertEqual(results["0:0"][0].evidence_ids, ["D1:1", "D1:2"])


if __name__ == "__main__":
    unittest.main()
