from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from benchmark.locomo.scripts.run_muninn_eval import (
    BuildConfig,
    build_badcases_report,
    build_paths,
    build_run_command,
    sidecar_log_path,
    classify_failure,
    extract_stats,
    prepare_data_file,
    parse_pending_count,
    resolve_target,
    write_diagnostic,
)


class RunMuninnEvalTests(unittest.TestCase):
    def test_resolve_known_targets(self) -> None:
        self.assertEqual(resolve_target("three-small").data_file, Path("benchmark/locomo/.cache/data/locomo-three-small-shared.json"))
        self.assertEqual(resolve_target("conv-26").sample_ids, ["conv-26"])
        self.assertEqual(resolve_target("conv-26-sessions-1-2").data_file, Path("benchmark/locomo/.cache/data/conv-26-sessions-1-2-current.json"))
        self.assertEqual(resolve_target("full").data_file, Path("benchmark/locomo/.cache/data/locomo10.json"))

    def test_resolve_sample_list_target(self) -> None:
        target = resolve_target("sample:conv-26,conv-30,conv-41")
        self.assertEqual(target.data_file, Path("benchmark/locomo/.cache/data/locomo10.json"))
        self.assertEqual(target.sample_ids, ["conv-26", "conv-30", "conv-41"])

    def test_resolve_rejects_unknown_target(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsupported target"):
            resolve_target("custom")

    def test_extract_stats_reads_f1_recall_and_judges(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            result = root / "result.real.json"
            openviking = root / "openviking.json"
            honcho = root / "honcho.json"
            result.write_text(json.dumps([{"sample_id": "conv-a", "qa": []}]), encoding="utf8")
            result.with_name("result.real_stats.json").write_text(json.dumps({
                "qa_count": 2,
                "average_f1": 0.5,
                "average_recall": 0.75,
            }), encoding="utf8")
            openviking.write_text(json.dumps({"accuracy": {"correct": 1, "total": 2, "accuracy": 0.5}}), encoding="utf8")
            honcho.write_text(json.dumps({"accuracy": {"passed": 2, "total": 2, "accuracy": 1.0}}), encoding="utf8")

            stats = extract_stats(result, openviking, honcho)

        self.assertEqual(stats["qa_count"], 2)
        self.assertEqual(stats["average_f1"], 0.5)
        self.assertEqual(stats["average_recall"], 0.75)
        self.assertEqual(stats["openviking_accuracy"], 0.5)
        self.assertEqual(stats["honcho_accuracy"], 1.0)

    def test_classify_known_failures(self) -> None:
        self.assertEqual(classify_failure("TypeError: fetch failed", ""), "transient_external")
        self.assertEqual(classify_failure("[muninn:observer] observer run failed: bad", ""), "muninn_internal")
        self.assertEqual(classify_failure("RowAddrTreeMap::from_sorted_iter called with non-sorted input", ""), "muninn_internal")
        self.assertEqual(classify_failure("", "waiting for turn:17: 40 pending"), "watermark_pending")
        self.assertEqual(classify_failure("", "phase_start phase=recall_batch"), "qa_batch_stuck")
        self.assertEqual(classify_failure("[openviking_judge] 10/40", ""), "judge_stuck")
        self.assertEqual(classify_failure("FileNotFoundError: muninn.json", ""), "missing_data_or_config")

    def test_write_diagnostic_file(self) -> None:
        config = BuildConfig(
            target=resolve_target("conv-26"),
            top_k=8,
            budget=0,
            query_limit=8,
            recall_mode="hybrid",
            watermark_timeout_ms=7200000,
            answerer="llm",
            keep_home=True,
            run_name="diagnostic-test",
        )
        paths = build_paths(config)
        path = write_diagnostic(
            config,
            paths,
            category="lance-index",
            fatal_pattern="rowaddrtreemap::from_sorted_iter",
            output="stdout\nRowAddrTreeMap::from_sorted_iter called with non-sorted input",
            progress="progress",
        )
        payload = json.loads((Path.cwd() / path).read_text(encoding="utf8"))
        self.assertEqual(payload["category"], "lance-index")
        self.assertEqual(payload["fatalPattern"], "rowaddrtreemap::from_sorted_iter")

    def test_parse_pending_count(self) -> None:
        self.assertEqual(parse_pending_count("[locomo] waiting for turn:17: 32 pending (turn:8)"), 32)
        self.assertIsNone(parse_pending_count("[locomo] qa_progress sample_id=conv-26 completed=1/20"))

    def test_build_badcases_report_includes_low_f1_rows(self) -> None:
        samples = [{
            "sample_id": "conv-a",
            "qa": [{
                "question": "What did Alice research?",
                "answer": "adoption agencies",
                "category": 4,
                "muninn_hybrid_top_8_prediction": "career options",
                "muninn_hybrid_top_8_f1": 0.0,
                "muninn_hybrid_top_8_recall": 0.0,
                "muninn_hybrid_top_8_hits": [{
                    "memory_id": "observation:1",
                    "detail": "Alice discussed career options.",
                    "evidence_ids": ["D1:1"],
                }],
            }],
        }]
        report = build_badcases_report(samples, "muninn_hybrid_top_8", {}, {})

        self.assertIn("What did Alice research?", report)
        self.assertIn("Gold: adoption agencies", report)
        self.assertIn("Prediction: career options", report)
        self.assertIn("observation:1", report)

    def test_build_run_command_includes_single_sample_and_timeout(self) -> None:
        config = BuildConfig(
            target=resolve_target("conv-26"),
            top_k=8,
            budget=0,
            query_limit=8,
            recall_mode="hybrid",
            watermark_timeout_ms=7200000,
            answerer="llm",
            keep_home=True,
            run_name="test-run",
        )
        paths = build_paths(config)
        command, env = build_run_command(config, paths)

        joined = " ".join(command)
        self.assertIn("benchmark/locomo/run.py", joined)
        self.assertIn("--sample-id conv-26", joined)
        self.assertIn("--budget 0", joined)
        self.assertEqual(env["MUNINN_LOCOMO_WATERMARK_TIMEOUT_MS"], "7200000")

    def test_build_run_command_injects_persistent_sidecar_base_url(self) -> None:
        config = BuildConfig(
            target=resolve_target("conv-26"),
            top_k=8,
            budget=0,
            query_limit=8,
            recall_mode="hybrid",
            watermark_timeout_ms=7200000,
            answerer="llm",
            keep_home=True,
            run_name="test-run",
        )
        paths = build_paths(config)

        _, env = build_run_command(config, paths, sidecar_base_url="http://127.0.0.1:9817")

        self.assertEqual(env["MUNINN_SIDECAR_BASE_URL"], "http://127.0.0.1:9817")

    def test_sidecar_log_path_lives_next_to_run_home(self) -> None:
        config = BuildConfig(
            target=resolve_target("three-small"),
            top_k=8,
            budget=0,
            query_limit=8,
            recall_mode="hybrid",
            watermark_timeout_ms=7200000,
            answerer="llm",
            keep_home=True,
            run_name="sidecar-log-test",
        )
        paths = build_paths(config)

        self.assertEqual(sidecar_log_path(paths), Path("benchmark/locomo/.runs/sidecar-log-test.real/sidecar.log"))

    def test_prepare_data_file_writes_multi_sample_subset(self) -> None:
        target = resolve_target("sample:conv-26,conv-30")
        config = BuildConfig(
            target=target,
            top_k=8,
            budget=0,
            query_limit=8,
            recall_mode="hybrid",
            watermark_timeout_ms=7200000,
            answerer="llm",
            keep_home=True,
            run_name="test-subset",
        )
        paths = build_paths(config)

        data_file = prepare_data_file(config, paths)
        data = json.loads((Path.cwd() / data_file).read_text(encoding="utf8"))

        self.assertEqual([sample["sample_id"] for sample in data], ["conv-26", "conv-30"])

    def test_prepare_data_file_writes_single_sample_subset(self) -> None:
        config = BuildConfig(
            target=resolve_target("conv-26"),
            top_k=8,
            budget=0,
            query_limit=8,
            recall_mode="hybrid",
            watermark_timeout_ms=7200000,
            answerer="llm",
            keep_home=True,
            run_name="test-single-subset",
        )
        paths = build_paths(config)

        data_file = prepare_data_file(config, paths)
        data = json.loads((Path.cwd() / data_file).read_text(encoding="utf8"))

        self.assertEqual([sample["sample_id"] for sample in data], ["conv-26"])

    def test_prepare_data_file_keeps_unfiltered_target_file(self) -> None:
        config = BuildConfig(
            target=resolve_target("full"),
            top_k=8,
            budget=0,
            query_limit=8,
            recall_mode="hybrid",
            watermark_timeout_ms=7200000,
            answerer="llm",
            keep_home=True,
            run_name="test-full",
        )
        paths = build_paths(config)

        data_file = prepare_data_file(config, paths)

        self.assertEqual(data_file, config.target.data_file)


if __name__ == "__main__":
    unittest.main()
