from __future__ import annotations

import argparse
import json
import os
import re
import select
import signal
import shutil
import socket
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from benchmark.locomo.slice import build_slice

OUT_DIR = ROOT / "benchmark" / "locomo" / "out"
RUNS_DIR = ROOT / "benchmark" / "locomo" / ".runs"
DEFAULT_FULL_DATA = ROOT / "benchmark" / "locomo" / ".cache" / "data" / "locomo10.json"
CONV_26_SESSIONS_1_2_DATA = ROOT / "benchmark" / "locomo" / ".cache" / "data" / "conv-26-sessions-1-2-current.json"
THREE_SMALL_SESSIONS = {
    "conv-26": 2,
    "conv-30": 2,
}

MATCHED_PROCESS_MARKERS = (
    "benchmark/locomo/run.py",
    "benchmark/locomo/qa_existing.py",
    "benchmark/locomo/scripts/openviking_judge.py",
    "benchmark/locomo/scripts/honcho_judge.py",
)
LEGACY_PENDING_RE = re.compile(r"waiting for .*?: (\d+) pending")
WATERMARK_PENDING_RE = re.compile(r"waiting for .*?: turns=(\d+) .*?extractions=(\d+) ")


@dataclass(frozen=True)
class Target:
    name: str
    data_file: Path
    sample_ids: list[str]


@dataclass(frozen=True)
class BuildConfig:
    target: Target
    top_k: int
    budget: int
    query_limit: int
    recall_mode: str
    watermark_timeout_ms: int
    answerer: str
    keep_home: bool
    run_name: str | None = None
    no_progress_timeout_s: int = 300


@dataclass(frozen=True)
class RunPaths:
    run_name: str
    out_file: Path
    progress_file: Path
    openviking_file: Path
    honcho_file: Path
    summary_file: Path
    diagnostic_file: Path
    badcases_file: Path
    home_dir: Path
    data_file: Path


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    output: str
    timed_out: bool = False


@dataclass
class SidecarProcess:
    process: subprocess.Popen[str]
    base_url: str
    log_path: Path

    def stop(self) -> None:
        if self.process.poll() is not None:
            return
        self.process.terminate()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=10)


def rel(path: Path) -> Path:
    try:
        return path.resolve().relative_to(ROOT.resolve())
    except ValueError:
        return path


def abs_path(path: Path) -> Path:
    return path if path.is_absolute() else ROOT / path


def resolve_target(value: str) -> Target:
    target = value.strip()
    if target == "three-small":
        return Target(target, rel(DEFAULT_FULL_DATA), [])
    if target == "conv-26":
        return Target(target, rel(DEFAULT_FULL_DATA), ["conv-26"])
    if target == "conv-26-sessions-1-2":
        return Target(target, rel(CONV_26_SESSIONS_1_2_DATA), [])
    if target == "full":
        return Target(target, rel(DEFAULT_FULL_DATA), [])
    if target.startswith("sample:"):
        sample_ids = [item.strip() for item in target.removeprefix("sample:").split(",") if item.strip()]
        if not sample_ids:
            raise ValueError("sample target must include at least one sample id")
        return Target(target, rel(DEFAULT_FULL_DATA), sample_ids)
    raise ValueError(f"unsupported target: {value}")


def default_run_name(config: BuildConfig) -> str:
    safe_target = config.target.name.replace(":", "-").replace(",", "-")
    return f"{safe_target}-budget{config.budget}-top{config.top_k}-{config.recall_mode}"


def build_paths(config: BuildConfig) -> RunPaths:
    base = config.run_name or default_run_name(config)
    return RunPaths(
        run_name=base,
        out_file=rel(OUT_DIR / f"{base}.real.json"),
        progress_file=rel(OUT_DIR / f"{base}.progress.jsonl"),
        openviking_file=rel(OUT_DIR / f"{base}.openviking.json"),
        honcho_file=rel(OUT_DIR / f"{base}.honcho.json"),
        summary_file=rel(OUT_DIR / f"{base}.summary.json"),
        diagnostic_file=rel(OUT_DIR / f"{base}.diagnostic.json"),
        badcases_file=rel(OUT_DIR / f"{base}.badcases.md"),
        home_dir=rel(RUNS_DIR / f"{base}.real"),
        data_file=rel(OUT_DIR / f"{base}.data.json"),
    )


def check_preflight(config: BuildConfig) -> None:
    if not abs_path(config.target.data_file).exists():
        raise FileNotFoundError(f"data file does not exist: {config.target.data_file}")
    if not (ROOT / "muninn.json").exists():
        raise FileNotFoundError("muninn.json does not exist in workspace root")


def prepare_data_file(config: BuildConfig, paths: RunPaths) -> Path:
    if config.target.name == "three-small":
        return prepare_three_small_data(config, paths)
    if not config.target.sample_ids:
        return config.target.data_file

    source = json.loads(abs_path(config.target.data_file).read_text(encoding="utf8"))
    requested = set(config.target.sample_ids)
    selected = [
        sample for sample in source
        if isinstance(sample, dict) and str(sample.get("sample_id") or "") in requested
    ]
    found = {str(sample.get("sample_id") or "") for sample in selected}
    missing = [sample_id for sample_id in config.target.sample_ids if sample_id not in found]
    if missing:
        raise ValueError(f"LoCoMo sample not found: {', '.join(missing)} in {config.target.data_file}")

    data_file = abs_path(paths.data_file)
    data_file.parent.mkdir(parents=True, exist_ok=True)
    data_file.write_text(json.dumps(selected, indent=2, ensure_ascii=False) + "\n", encoding="utf8")
    return paths.data_file


def prepare_three_small_data(config: BuildConfig, paths: RunPaths) -> Path:
    data_file = abs_path(paths.data_file)
    data_file.parent.mkdir(parents=True, exist_ok=True)
    samples = [
        build_slice(abs_path(config.target.data_file), sample_id, max_session).sample
        for sample_id, max_session in THREE_SMALL_SESSIONS.items()
    ]
    data_file.write_text(json.dumps(samples, indent=2, ensure_ascii=False) + "\n", encoding="utf8")
    return paths.data_file


def build_run_command(
    config: BuildConfig,
    paths: RunPaths,
    data_file: Path | None = None,
    sidecar_base_url: str | None = None,
) -> tuple[list[str], dict[str, str]]:
    resolved_data_file = data_file or config.target.data_file
    command = [
        sys.executable,
        "benchmark/locomo/run.py",
        "--data-file",
        str(resolved_data_file),
        "--out-file",
        str(paths.out_file),
        "--progress-file",
        str(paths.progress_file),
        "--top-k",
        str(config.top_k),
        "--budget",
        str(config.budget),
        "--query-limit",
        str(config.query_limit),
        "--recall-mode",
        config.recall_mode,
        "--answerer",
        config.answerer,
        "--home-dir",
        str(paths.home_dir),
    ]
    if config.keep_home:
        command.append("--keep-home")
    if len(config.target.sample_ids) == 1 and data_file is None:
        command.extend(["--sample-id", config.target.sample_ids[0]])
    env = os.environ.copy()
    env["MUNINN_LOCOMO_WATERMARK_TIMEOUT_MS"] = str(config.watermark_timeout_ms)
    env["MUNINN_LOCOMO_HOME_PREPARED"] = "1"
    if sidecar_base_url:
        env["MUNINN_SIDECAR_BASE_URL"] = sidecar_base_url
    return command, env


def sidecar_log_path(paths: RunPaths) -> Path:
    return paths.home_dir / "sidecar.log"


def reset_run_home(paths: RunPaths) -> None:
    home = abs_path(paths.home_dir)
    shutil.rmtree(home, ignore_errors=True)
    home.mkdir(parents=True, exist_ok=True)


def free_tcp_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def sidecar_env(base_env: dict[str, str], paths: RunPaths, port: int) -> dict[str, str]:
    home = abs_path(paths.home_dir)
    env = base_env.copy()
    env["PORT"] = str(port)
    env["MUNINN_HOME"] = str(home)
    return env


def wait_for_sidecar(base_url: str, process: subprocess.Popen[str], timeout_s: float = 30.0) -> None:
    deadline = time.monotonic() + timeout_s
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"sidecar exited before health check passed: returncode={process.returncode}")
        try:
            with urlopen(f"{base_url}/health", timeout=1.0) as response:
                if response.status == 200:
                    return
        except Exception as exc:
            last_error = exc if isinstance(exc, Exception) else URLError(str(exc))
        time.sleep(0.2)
    raise RuntimeError(f"sidecar health check timed out: {last_error}")


def start_sidecar(paths: RunPaths, env: dict[str, str]) -> SidecarProcess:
    port = free_tcp_port()
    base_url = f"http://127.0.0.1:{port}"
    log_path = abs_path(sidecar_log_path(paths))
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_handle = log_path.open("a", encoding="utf8")
    process = subprocess.Popen(
        [node_binary(), "packages/sidecar/dist/index.js"],
        cwd=ROOT,
        env=sidecar_env(env, paths, port),
        text=True,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        bufsize=1,
    )
    try:
        wait_for_sidecar(base_url, process)
    except Exception:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        log_handle.close()
        raise
    log_handle.close()
    print(f"[muninn-eval] sidecar={base_url} log={sidecar_log_path(paths)}", flush=True)
    return SidecarProcess(process=process, base_url=base_url, log_path=sidecar_log_path(paths))


def node_binary() -> str:
    return os.environ.get("MUNINN_NODE_BINARY") or "node"


def build_judge_commands(config: BuildConfig, paths: RunPaths, data_file: Path) -> list[list[str]]:
    return [
        [
            sys.executable,
            "benchmark/locomo/scripts/openviking_judge.py",
            str(paths.out_file),
            str(paths.openviking_file),
        ],
        [
            sys.executable,
            "benchmark/locomo/scripts/honcho_judge.py",
            str(paths.out_file),
            str(paths.honcho_file),
            "--data-file",
            str(data_file),
        ],
    ]


def stats_path(out_file: Path) -> Path:
    name = out_file.name
    if name.endswith(".real.json"):
        return out_file.with_name(name.removesuffix(".real.json") + ".real_stats.json")
    return out_file.with_name(out_file.stem + "_stats.json")


def load_json_if_exists(path: Path) -> Any:
    actual = abs_path(path)
    if not actual.exists():
        return None
    return json.loads(actual.read_text(encoding="utf8"))


def extract_stats(result_file: Path, openviking_file: Path, honcho_file: Path) -> dict[str, Any]:
    f1_stats = load_json_if_exists(stats_path(result_file)) or {}
    openviking = load_json_if_exists(openviking_file) or {}
    honcho = load_json_if_exists(honcho_file) or {}
    return {
        "qa_count": f1_stats.get("qa_count", 0),
        "average_f1": f1_stats.get("average_f1", 0.0),
        "category_f1": f1_stats.get("category_f1", {}),
        "openviking_accuracy": (openviking.get("accuracy") or {}).get("accuracy"),
        "honcho_accuracy": (honcho.get("accuracy") or {}).get("accuracy"),
    }


INTERNAL_FATAL_PATTERNS: tuple[tuple[str, str], ...] = (
    ("observer", "observer run failed"),
    ("extractor", "extractor run failed"),
    ("lance-merge-upsert", "ambiguous merge inserts"),
    ("lance-index", "rowaddrtreemap::from_sorted_iter"),
    ("lance-index", "index build failed"),
    ("lance-merge-upsert", "merge insert"),
    ("provider-tool", "tool contract"),
    ("unknown", "validator"),
    ("unknown", "parser"),
    ("unknown", "schema"),
)

TRANSIENT_EXTERNAL_PATTERNS = (
    "fetch failed",
    "econnreset",
    "etimedout",
    "rate limit",
    "429",
)


def internal_fatal_category(text: str) -> tuple[str, str] | None:
    lowered = text.lower()
    for category, pattern in INTERNAL_FATAL_PATTERNS:
        if pattern in lowered:
            return category, pattern
    return None


def classify_failure(stderr: str, progress: str) -> str:
    combined = f"{stderr}\n{progress}".lower()
    if internal_fatal_category(combined):
        return "muninn_internal"
    if any(pattern in combined for pattern in TRANSIENT_EXTERNAL_PATTERNS):
        return "transient_external"
    if "filenotfounderror" in combined or "muninn.json" in combined or "data file" in combined:
        return "missing_data_or_config"
    if parse_pending_count(combined) is not None:
        return "watermark_pending"
    if "phase_start phase=recall_batch" in combined and "qa_progress" not in combined:
        return "qa_batch_stuck"
    if "openviking_judge" in combined or "honcho_judge" in combined:
        return "judge_stuck"
    if "watchdog" in combined or "optimize" in combined or "maintenance" in combined:
        return "watchdog_or_optimize_stuck"
    return "unknown"


def build_model_key(config: BuildConfig) -> str:
    if config.budget > 0:
        return f"muninn_{config.recall_mode}_budget_{config.budget}_query_{config.query_limit}"
    return f"muninn_{config.recall_mode}_top_{config.top_k}"


def judge_items_by_key(path: Path) -> dict[tuple[str, int], dict[str, Any]]:
    payload = load_json_if_exists(path) or {}
    result: dict[tuple[str, int], dict[str, Any]] = {}
    for item in payload.get("items") or []:
        sample_id = str(item.get("sample_id") or "")
        qa_index = int(item.get("qa_index") or 0)
        result[(sample_id, qa_index)] = item
    return result


def build_badcases_report(
    samples: list[dict[str, Any]],
    model_key: str,
    openviking_by_key: dict[tuple[str, int], dict[str, Any]],
    honcho_by_key: dict[tuple[str, int], dict[str, Any]],
) -> str:
    lines = ["# Muninn LoCoMo Bad Cases", ""]
    for sample in samples:
        sample_id = str(sample.get("sample_id") or "")
        for index, qa in enumerate(sample.get("qa") or []):
            f1 = float(qa.get(f"{model_key}_f1") or 0.0)
            ov = openviking_by_key.get((sample_id, index))
            hc = honcho_by_key.get((sample_id, index))
            ov_bad = ov is not None and ov.get("result") != "CORRECT"
            hc_bad = hc is not None and not bool(hc.get("passed"))
            if f1 >= 1.0 and not ov_bad and not hc_bad:
                continue
            lines.extend([
                f"## {sample_id} Q{index}",
                "",
                f"- Category: {qa.get('category')}",
                f"- Question: {qa.get('question')}",
                f"- Gold: {qa.get('answer')}",
                f"- Prediction: {qa.get(f'{model_key}_prediction')}",
                f"- F1: {f1:.4f}",
            ])
            if ov is not None:
                lines.append(f"- OpenViking: {ov.get('result')} - {ov.get('reasoning')}")
            if hc is not None:
                verdict = "PASS" if hc.get("passed") else "FAIL"
                lines.append(f"- Honcho: {verdict} - {hc.get('reasoning')}")
            hits = qa.get(f"{model_key}_hits") or []
            for hit_index, hit in enumerate(hits[:5], start=1):
                detail = str(hit.get("detail") or hit.get("matched_text") or "").replace("\n", " ")
                lines.append(f"- Hit {hit_index}: {hit.get('memory_id')} | {detail[:300]}")
            lines.append("")
    if len(lines) == 2:
        lines.append("No bad cases detected by F1, OpenViking, or Honcho.")
    return "\n".join(lines).rstrip() + "\n"


def read_text_tail(path: Path, limit: int = 20000) -> str:
    actual = abs_path(path)
    if not actual.exists():
        return ""
    text = actual.read_text(encoding="utf8", errors="replace")
    return text[-limit:]


def write_summary(
    config: BuildConfig,
    paths: RunPaths,
    *,
    status: str,
    failure: str | None = None,
    stderr: str = "",
    progress: str = "",
) -> dict[str, Any]:
    stats = extract_stats(paths.out_file, paths.openviking_file, paths.honcho_file)
    summary = {
        "status": status,
        "failure": failure,
        "target": config.target.name,
        "data_file": str(config.target.data_file),
        "sample_ids": config.target.sample_ids,
        "parameters": {
            "top_k": config.top_k,
            "budget": config.budget,
            "query_limit": config.query_limit,
            "recall_mode": config.recall_mode,
            "watermark_timeout_ms": config.watermark_timeout_ms,
            "answerer": config.answerer,
            "no_progress_timeout_s": config.no_progress_timeout_s,
        },
        "paths": {
            "run_home": str(paths.home_dir),
            "sidecar_log": str(sidecar_log_path(paths)),
            "result": str(paths.out_file),
            "progress": str(paths.progress_file),
            "openviking": str(paths.openviking_file),
            "honcho": str(paths.honcho_file),
            "diagnostic": str(paths.diagnostic_file),
            "badcases": str(paths.badcases_file),
        },
        "scores": stats,
        "stderr_tail": stderr[-4000:],
        "progress_tail": progress[-4000:],
    }
    actual = abs_path(paths.summary_file)
    actual.parent.mkdir(parents=True, exist_ok=True)
    actual.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf8")
    return summary


def read_jsonl_tail(path: Path, limit: int = 80) -> list[str]:
    actual = abs_path(path)
    if not actual.exists():
        return []
    return actual.read_text(encoding="utf8", errors="replace").splitlines()[-limit:]


def read_checkpoint_snapshot(home_dir: Path) -> Any:
    checkpoint_dir = abs_path(home_dir) / "checkpoints"
    if not checkpoint_dir.exists():
        return None
    files = sorted(checkpoint_dir.glob("*.json"), key=lambda path: path.stat().st_mtime, reverse=True)
    if not files:
        return None
    try:
        return json.loads(files[0].read_text(encoding="utf8"))
    except Exception as exc:
        return {"error": repr(exc), "path": str(files[0])}


def write_diagnostic(
    config: BuildConfig,
    paths: RunPaths,
    *,
    category: str,
    fatal_pattern: str,
    output: str,
    progress: str,
) -> Path:
    payload = {
        "writtenAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "category": category,
        "fatalPattern": fatal_pattern,
        "target": config.target.name,
        "phase": "benchmark",
        "runHome": str(paths.home_dir),
        "stdoutTail": output.splitlines()[-80:],
        "stderrTail": output.splitlines()[-80:],
        "progressTail": progress.splitlines()[-80:],
        "watchdogTail": read_jsonl_tail(paths.home_dir / "watchdog.jsonl", 80),
        "observerTraceTail": read_jsonl_tail(paths.home_dir / "locomo-observer-trace.jsonl", 20),
        "extractorTraceTail": read_jsonl_tail(paths.home_dir / "locomo-thread-observing-trace.jsonl", 20),
        "checkpoint": read_checkpoint_snapshot(paths.home_dir),
    }
    actual = abs_path(paths.diagnostic_file)
    actual.parent.mkdir(parents=True, exist_ok=True)
    actual.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    return paths.diagnostic_file


def kill_old_processes() -> list[int]:
    try:
        result = subprocess.run(["ps", "-ef"], cwd=ROOT, check=True, text=True, capture_output=True)
    except Exception:
        return []
    current_pid = os.getpid()
    killed: list[int] = []
    for line in result.stdout.splitlines():
        if not any(marker in line for marker in MATCHED_PROCESS_MARKERS):
            continue
        fields = line.split()
        if len(fields) < 2:
            continue
        try:
            pid = int(fields[1])
        except ValueError:
            continue
        if pid == current_pid:
            continue
        try:
            os.kill(pid, signal.SIGTERM)
            killed.append(pid)
        except ProcessLookupError:
            continue
    return killed


def run_command(
    command: list[str],
    *,
    env: dict[str, str] | None = None,
    phase: str,
    no_progress_timeout_s: int = 300,
) -> CommandResult:
    print(f"[muninn-eval] phase={phase} command={' '.join(command)}", flush=True)
    process = subprocess.Popen(
        command,
        cwd=ROOT,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        bufsize=1,
    )
    output: list[str] = []
    last_progress = time.monotonic()
    last_pending_count: int | None = None
    assert process.stdout is not None
    while True:
        readable, _, _ = select.select([process.stdout], [], [], 0.5)
        if readable:
            line = process.stdout.readline()
            if line:
                output.append(line)
                print(line, end="", flush=True)
                fatal = internal_fatal_category(line)
                if fatal:
                    category, pattern = fatal
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
                    message = f"\n[muninn-eval] phase={phase} internal fatal category={category} pattern={pattern}; terminated process\n"
                    output.append(message)
                    print(message, end="", flush=True)
                    return CommandResult(returncode=173, output="".join(output))
                pending = parse_pending_count(line)
                if pending is None:
                    last_progress = time.monotonic()
                elif pending != last_pending_count:
                    last_pending_count = pending
                    last_progress = time.monotonic()
                continue
        returncode = process.poll()
        if returncode is not None:
            remainder = process.stdout.read()
            if remainder:
                output.append(remainder)
                print(remainder, end="", flush=True)
            return CommandResult(returncode=returncode, output="".join(output))
        if time.monotonic() - last_progress > no_progress_timeout_s:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            message = f"\n[muninn-eval] phase={phase} no progress for {no_progress_timeout_s}s; terminated process\n"
            output.append(message)
            print(message, end="", flush=True)
            return CommandResult(returncode=124, output="".join(output), timed_out=True)
        time.sleep(0.1)


def parse_pending_count(line: str) -> int | None:
    match = WATERMARK_PENDING_RE.search(line)
    if match:
        return int(match.group(1)) + int(match.group(2))
    match = LEGACY_PENDING_RE.search(line)
    if match:
        return int(match.group(1))
    return None


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run Muninn LoCoMo benchmark with all scoring views.")
    parser.add_argument("--target", required=True)
    parser.add_argument("--top-k", type=int, default=8)
    parser.add_argument("--budget", type=int, default=0)
    parser.add_argument("--query-limit", type=int, default=8)
    parser.add_argument("--recall-mode", choices=["vector", "fts", "hybrid"], default="hybrid")
    parser.add_argument("--watermark-timeout-ms", type=int, default=7200000)
    parser.add_argument("--answerer", choices=["llm", "heuristic"], default="llm")
    parser.add_argument("--run-name")
    parser.add_argument("--no-progress-timeout-s", type=int, default=300)
    parser.add_argument("--no-keep-home", action="store_true")
    parser.add_argument("--no-kill-old", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    config = BuildConfig(
        target=resolve_target(args.target),
        top_k=args.top_k,
        budget=args.budget,
        query_limit=args.query_limit,
        recall_mode=args.recall_mode,
        watermark_timeout_ms=args.watermark_timeout_ms,
        answerer=args.answerer,
        keep_home=not args.no_keep_home,
        run_name=args.run_name,
        no_progress_timeout_s=args.no_progress_timeout_s,
    )
    paths = build_paths(config)
    data_file = config.target.data_file
    try:
        check_preflight(config)
        data_file = prepare_data_file(config, paths)
        if not args.no_kill_old:
            killed = kill_old_processes()
            if killed:
                print(f"[muninn-eval] killed old benchmark processes: {killed}", flush=True)
        print(json.dumps({
            "target": config.target.name,
            "data_file": str(data_file),
            "sample_ids": config.target.sample_ids,
            "out_file": str(paths.out_file),
            "progress_file": str(paths.progress_file),
            "home_dir": str(paths.home_dir),
        }, indent=2), flush=True)

        reset_run_home(paths)
        sidecar = start_sidecar(paths, os.environ.copy())
        try:
            command, env = build_run_command(config, paths, data_file=data_file, sidecar_base_url=sidecar.base_url)
            run_result = run_command(command, env=env, phase="benchmark", no_progress_timeout_s=config.no_progress_timeout_s)
            if run_result.returncode != 0:
                progress = read_text_tail(paths.progress_file)
                sidecar_tail = read_text_tail(sidecar.log_path)
                output = f"{run_result.output}\n[sidecar log tail]\n{sidecar_tail}"
                failure = classify_failure(output, progress)
                fatal = internal_fatal_category(output)
                if fatal:
                    category, pattern = fatal
                    write_diagnostic(config, paths, category=category, fatal_pattern=pattern, output=output, progress=progress)
                write_summary(config, paths, status="failed", failure=failure, stderr=output, progress=progress)
                return run_result.returncode
        finally:
            sidecar.stop()

        for index, judge_command in enumerate(build_judge_commands(config, paths, data_file), start=1):
            judge = run_command(judge_command, phase=f"judge_{index}", no_progress_timeout_s=config.no_progress_timeout_s)
            if judge.returncode != 0:
                progress = read_text_tail(paths.progress_file)
                failure = classify_failure(judge.output, progress)
                write_summary(config, paths, status="failed", failure=failure, stderr=judge.output, progress=progress)
                return judge.returncode

        samples = load_json_if_exists(paths.out_file) or []
        model_key = build_model_key(config)
        openviking = judge_items_by_key(paths.openviking_file)
        honcho = judge_items_by_key(paths.honcho_file)
        abs_path(paths.badcases_file).write_text(
            build_badcases_report(samples, model_key, openviking, honcho),
            encoding="utf8",
        )
        summary = write_summary(config, paths, status="complete")
        print(json.dumps(summary["scores"], indent=2, ensure_ascii=False), flush=True)
        print(f"[muninn-eval] summary={paths.summary_file}", flush=True)
        print(f"[muninn-eval] badcases={paths.badcases_file}", flush=True)
        return 0
    except Exception as exc:
        progress = read_text_tail(paths.progress_file)
        failure = classify_failure(repr(exc), progress)
        fatal = internal_fatal_category(repr(exc))
        if fatal:
            category, pattern = fatal
            write_diagnostic(config, paths, category=category, fatal_pattern=pattern, output=repr(exc), progress=progress)
        write_summary(config, paths, status="failed", failure=failure, stderr=repr(exc), progress=progress)
        raise


if __name__ == "__main__":
    raise SystemExit(main())
