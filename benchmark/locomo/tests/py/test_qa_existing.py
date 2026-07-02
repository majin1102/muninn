from __future__ import annotations

import unittest

from benchmark.locomo.qa_existing import parse_args


class QaExistingTests(unittest.TestCase):
    def test_parse_args_session_mode_defaults_to_no_extraction_budget(self) -> None:
        args = parse_args(
            [
                "--data-file",
                "data.json",
                "--out-file",
                "out.json",
                "--mode",
                "session",
            ]
        )

        self.assertEqual(args.mode, "session")
        self.assertEqual(args.budget, 0)
        self.assertIsNone(args.query_limit)

    def test_parse_args_rejects_session_extraction_budget_options(self) -> None:
        base = ["--data-file", "data.json", "--out-file", "out.json", "--mode", "session"]

        with self.assertRaises(SystemExit):
            parse_args([*base, "--budget", "1"])
        with self.assertRaises(SystemExit):
            parse_args([*base, "--query-limit", "8"])


if __name__ == "__main__":
    unittest.main()
