from __future__ import annotations

import unittest
from unittest.mock import MagicMock

from benchmark.common.muninn_bridge import MuninnBridge


class MuninnBridgeTests(unittest.TestCase):
    def test_ensure_built_builds_core_before_bridge(self) -> None:
        bridge = MuninnBridge()
        bridge._bridge_dist_is_fresh = MagicMock(return_value=False)
        bridge._run_process = MagicMock()

        bridge.ensure_built()

        self.assertEqual(
            bridge._run_process.call_args_list,
            [
                unittest.mock.call(["pnpm", "--filter", "@muninn/core", "build"]),
                unittest.mock.call(["pnpm", "--filter", "@muninn/benchmark-locomo", "build"]),
            ],
        )

    def test_ensure_built_skips_work_when_dist_is_fresh(self) -> None:
        bridge = MuninnBridge()
        bridge._bridge_dist_is_fresh = MagicMock(return_value=True)
        bridge._run_process = MagicMock()

        bridge.ensure_built()

        bridge._run_process.assert_not_called()


if __name__ == "__main__":
    unittest.main()
