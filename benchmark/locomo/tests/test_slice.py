from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from benchmark.locomo.slice import build_slice, write_slice


FIXTURE = Path("benchmark/locomo/test/fixtures/mini-locomo.json")


class SliceTests(unittest.TestCase):
    def test_build_slice_keeps_only_evidence_contained_qas(self) -> None:
        result = build_slice(FIXTURE, "sample-a", 1)

        self.assertEqual(result.sample["sample_id"], "sample-a")
        self.assertIn("session_1", result.sample["conversation"])
        self.assertNotIn("session_2", result.sample["conversation"])
        self.assertEqual(result.summary["turn_count"], 2)
        self.assertEqual(result.summary["qa_count"], 1)
        self.assertEqual(result.sample["qa"][0]["evidence"], ["D1:1"])
        self.assertEqual(result.summary["retained_dialog_ids"], ["D1:1", "D1:2"])

    def test_build_slice_fails_for_missing_sample(self) -> None:
        with self.assertRaisesRegex(ValueError, "LoCoMo sample not found: missing"):
            build_slice(FIXTURE, "missing", 1)

    def test_build_slice_fails_when_no_qa_remains(self) -> None:
        with self.assertRaisesRegex(ValueError, "no QA rows remain"):
            build_slice(FIXTURE, "sample-a", 0)

    def test_write_slice_writes_dataset_and_summary(self) -> None:
        result = build_slice(FIXTURE, "sample-a", 1)
        with TemporaryDirectory() as tmpdir:
            out_file = Path(tmpdir) / "slice.json"
            summary_file = Path(tmpdir) / "slice_summary.json"
            write_slice(result, out_file, summary_file)

            dataset = json.loads(out_file.read_text(encoding="utf8"))
            summary = json.loads(summary_file.read_text(encoding="utf8"))
            self.assertEqual(len(dataset), 1)
            self.assertEqual(summary["sample_id"], "sample-a")
            self.assertEqual(summary["output_path"], str(out_file))


if __name__ == "__main__":
    unittest.main()
