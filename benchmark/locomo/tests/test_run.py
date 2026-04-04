from __future__ import annotations

import unittest
from pathlib import Path

from benchmark.locomo.run import ensure_selected_samples


class RunTests(unittest.TestCase):
    def test_raises_when_explicit_sample_id_is_missing(self) -> None:
        data_file = Path("/tmp/mini-locomo.json")

        with self.assertRaisesRegex(
            ValueError,
            "LoCoMo sample not found: missing-sample in /tmp/mini-locomo.json",
        ):
            ensure_selected_samples([], "missing-sample", data_file)

    def test_allows_empty_selection_when_no_sample_filter_is_set(self) -> None:
        ensure_selected_samples([], None, Path("/tmp/mini-locomo.json"))


if __name__ == "__main__":
    unittest.main()
