from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]


class PublicModeSourceTests(unittest.TestCase):
    def test_locomo_python_surfaces_do_not_expose_legacy_recall_mode(self) -> None:
        paths = [
            ROOT / "benchmark" / "common" / "muninn_bridge.py",
            ROOT / "benchmark" / "locomo" / "run.py",
            ROOT / "benchmark" / "locomo" / "qa_existing.py",
            ROOT / "benchmark" / "locomo" / "scripts" / "qa_budget_grid.py",
            ROOT / "benchmark" / "locomo" / "scripts" / "run_muninn_eval.py",
        ]

        for path in paths:
            source = path.read_text(encoding="utf8")
            with self.subTest(path=path):
                self.assertNotIn("--recall-mode", source)
                self.assertNotIn("recall_mode", source)
                self.assertNotIn("recall-mode", source)

    def test_readme_uses_public_mode_wording(self) -> None:
        source = (ROOT / "benchmark" / "locomo" / "README.md").read_text(encoding="utf8")

        self.assertIn("--mode extraction", source)
        self.assertNotIn("--recall-mode", source)


if __name__ == "__main__":
    unittest.main()
