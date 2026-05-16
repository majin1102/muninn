from __future__ import annotations

import json
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from benchmark.locomo.metadata import build_run_metadata, write_run_metadata


class MetadataTests(unittest.TestCase):
    def test_build_run_metadata_redacts_secret_fields(self) -> None:
        with TemporaryDirectory() as tmpdir:
            home = Path(tmpdir)
            config = {
                "extractor": {"name": "default-extractor", "llm": "default"},
                "observer": {"name": "default-observer", "llm": "default"},
                "llm": {
                    "default": {
                        "provider": "openai",
                        "model": "doubao-seed",
                        "apiKey": "secret",
                        "baseUrl": "https://example.test",
                    }
                },
                "extraction": {
                    "embedding": {
                        "provider": "openai",
                        "model": "embedding-model",
                        "apiKey": "embedding-secret",
                        "dimensions": 2048,
                    }
                },
            }
            (home / "muninn.json").write_text(json.dumps(config), encoding="utf8")
            previous = os.environ.get("MUNINN_HOME")
            os.environ["MUNINN_HOME"] = str(home)
            try:
                metadata = build_run_metadata(
                    run_name="slice-real",
                    data_file=Path("slice.json"),
                    out_file=Path("out.json"),
                    top_k=5,
                    started_at="2026-04-22T00:00:00Z",
                    completed_at="2026-04-22T00:01:00Z",
                )
            finally:
                if previous is None:
                    os.environ.pop("MUNINN_HOME", None)
                else:
                    os.environ["MUNINN_HOME"] = previous

            raw = json.dumps(metadata)
            self.assertNotIn("secret", raw)
            self.assertEqual(metadata["observer"]["provider"], "openai")
            self.assertEqual(metadata["observer"]["model"], "doubao-seed")
            self.assertEqual(metadata["embedding"]["dimensions"], 2048)
            self.assertEqual(metadata["config"]["llm"]["default"]["apiKey"], "<redacted>")

    def test_write_run_metadata_uses_real_suffix(self) -> None:
        with TemporaryDirectory() as tmpdir:
            out_file = Path(tmpdir) / "conv-26-session-1.real.json"
            metadata_file = write_run_metadata(out_file, {"ok": True})
            self.assertEqual(metadata_file.name, "conv-26-session-1.real_metadata.json")
            self.assertTrue(metadata_file.exists())


if __name__ == "__main__":
    unittest.main()
