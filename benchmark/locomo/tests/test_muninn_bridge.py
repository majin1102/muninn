from __future__ import annotations

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
                    wrap_zsh_env=False,
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
                    wrap_zsh_env=False,
                ),
                unittest.mock.call(
                    ["sh", str(BOOTSTRAP_SCRIPT)],
                    wrap_zsh_env=False,
                ),
            ],
        )

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
