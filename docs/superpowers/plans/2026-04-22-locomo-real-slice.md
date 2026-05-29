# LoCoMo Real Slice Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and run a small real-quality LoCoMo benchmark slice for `conv-26` session 1 with real Muninn ingestion, observer, embedding, recall, QA heuristic scoring, diagnostics, and metadata.

**Architecture:** Add a LoCoMo slicer that creates a generated one-sample dataset artifact, keep the existing runner as the execution entrypoint, and enrich runner output with hit diagnostics and redacted run metadata. Keep benchmark-only behavior inside `benchmark/locomo` and avoid changing product write semantics.

**Tech Stack:** Python 3 `unittest` benchmark runner and slicer, Node/TypeScript bridge to `@muninn/core`, pnpm workspace scripts, local `muninn.json` via `MUNINN_HOME`.

---

## File Structure

- Create `benchmark/locomo/slice.py`
  - Owns deterministic dataset slicing and slice summary generation.
  - Exposes pure functions for tests and a CLI for manual generation.
- Create `benchmark/locomo/tests/test_slice.py`
  - Unit tests for evidence-contained QA filtering, summary content, missing sample, and no retained QA.
- Create `benchmark/locomo/metadata.py`
  - Owns redacted run metadata generation from CLI args, environment, and active `muninn.json`.
- Modify `benchmark/locomo/run.py`
  - Adds top-hit diagnostics to each QA.
  - Writes run metadata after outputs.
  - Keeps existing runner input model.
- Modify `benchmark/locomo/src/bridge.ts`
  - Keeps compatibility with current `addMessage(): Promise<void>`.
  - Adds environment-configurable watermark timeout/warning defaults.
- Modify `benchmark/locomo/test/bridge.test.mjs`
  - Stabilizes timeout/warning tests and covers env-based watermark timeout.
- Modify `benchmark/locomo/tests/test_scoring.py`
  - Verifies hit diagnostics in QA output.

---

### Task 1: Stabilize Bridge Import And Watermark Behavior

**Files:**
- Modify: `benchmark/locomo/src/bridge.ts`
- Modify: `benchmark/locomo/test/bridge.test.mjs`

- [ ] **Step 1: Write failing TypeScript bridge tests**

Add a bridge test that proves import still writes manifest turn ids even though `addMessage()` returns `void`, and a test that proves env timeout defaults are honored.

In `benchmark/locomo/test/bridge.test.mjs`, extend the import test with:

```js
  assert.match(manifest.turns[0].turn_id, /^session:/);
  assert.match(manifest.turns[1].turn_id, /^session:/);
  assert.notEqual(manifest.turns[0].turn_id, manifest.turns[1].turn_id);
```

Add a new test near the watermark timeout tests:

```js
test('waitForImportWatermark reads timeout and warning defaults from env', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'muninn-locomo-env-timeout-'));
  t.after(async () => rm(home, { recursive: true, force: true }));
  t.after(async () => core.shutdownCoreForTests());
  t.after(() => {
    delete process.env.MUNINN_LOCOMO_WATERMARK_TIMEOUT_MS;
    delete process.env.MUNINN_LOCOMO_WATERMARK_WARNING_DELAY_MS;
    delete process.env.MUNINN_OBSERVER_POLL_MS;
  });

  await prepareSourceConfig(t, {
    observerProvider: 'openai',
    semanticIndexProvider: 'mock',
  });
  await runBridge('reset-home', { 'muninn-home': home });
  await runBridge('import-sample', {
    'data-file': fixturePath,
    'sample-id': 'sample-a',
    'muninn-home': home,
  });

  process.env.MUNINN_HOME = home;
  process.env.MUNINN_OBSERVER_POLL_MS = '60000';
  process.env.MUNINN_LOCOMO_WATERMARK_TIMEOUT_MS = '50';
  process.env.MUNINN_LOCOMO_WATERMARK_WARNING_DELAY_MS = '0';
  const bridgeModule = await import(`${bridgePath}?env-timeout=${Date.now()}`);
  const manifest = JSON.parse(await readFile(path.join(home, 'locomo-manifest.json'), 'utf8'));

  await assert.rejects(
    () => bridgeModule.waitForImportWatermark(manifest, { pollMs: 10 }),
    /observer watermark timeout.*pending turn ids/i,
  );
});
```

- [ ] **Step 2: Run the failing bridge test**

Run:

```bash
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/pnpm --filter @muninn/benchmark-locomo build
node --test benchmark/locomo/test/bridge.test.mjs
```

Expected before implementation:

- TypeScript build fails on `summary` or `turn.turnId`, or
- the env timeout test fails because `waitForImportWatermark()` ignores env defaults.

- [ ] **Step 3: Implement bridge compatibility and env defaults**

In `benchmark/locomo/src/bridge.ts`, import the types:

```ts
import type { RenderedMemory, SessionTurn, TurnContent } from '@muninn/core';
```

Replace `coreClient.addMessage({ ... summary ... })` in `importSampleCommand()` with:

```ts
      const turn = await addTurnAndFind({
        sessionId,
        agent: dialog.speaker,
        prompt: text,
        response: 'Recorded.',
      });
```

Add this helper before `resolveEvidenceIds()`:

```ts
async function addTurnAndFind(content: TurnContent): Promise<SessionTurn> {
  await coreClient.addMessage(content);
  const turns = await coreClient.sessions.list({
    mode: { type: 'recency', limit: 20 },
    agent: content.agent,
    sessionId: content.sessionId,
  });
  const match = turns.find((turn) => (
    turn.prompt === content.prompt
    && turn.response === content.response
  ));
  if (!match) {
    throw new Error(
      `failed to resolve imported LoCoMo turn for ${content.agent} in ${content.sessionId}`
    );
  }
  return match;
}
```

Add env parsing helpers near constants:

```ts
function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
```

Change default timeout values inside `waitForImportWatermark()`:

```ts
  const pollMs = options?.pollMs ?? WATERMARK_POLL_MS;
  const timeoutMs = options?.timeoutMs
    ?? envPositiveInt('MUNINN_LOCOMO_WATERMARK_TIMEOUT_MS', WATERMARK_TIMEOUT_MS);
  const warningDelayMs = options?.warningDelayMs
    ?? envPositiveInt('MUNINN_LOCOMO_WATERMARK_WARNING_DELAY_MS', WATERMARK_WARNING_DELAY_MS);
```

Change the warning condition to warn whenever pending remains after the delay:

```ts
    if (
      !stalledWarningEmitted
      && Date.now() - startedAt >= warningDelayMs
      && pendingTurnIds.length > 0
    ) {
```

- [ ] **Step 4: Run bridge tests**

Run:

```bash
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/pnpm --filter @muninn/benchmark-locomo test
```

Expected:

- Python tests pass.
- Node bridge tests pass.

- [ ] **Step 5: Commit bridge stabilization**

```bash
git add benchmark/locomo/src/bridge.ts benchmark/locomo/test/bridge.test.mjs
git commit -m "fix: stabilize LoCoMo bridge import"
```

---

### Task 2: Add LoCoMo Slice Generator

**Files:**
- Create: `benchmark/locomo/slice.py`
- Create: `benchmark/locomo/tests/test_slice.py`

- [ ] **Step 1: Write failing slicer tests**

Create `benchmark/locomo/tests/test_slice.py`:

```python
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
```

- [ ] **Step 2: Run slicer tests to verify failure**

Run:

```bash
python3 -m unittest benchmark.locomo.tests.test_slice
```

Expected:

- FAIL with `ModuleNotFoundError: No module named 'benchmark.locomo.slice'`.

- [ ] **Step 3: Implement slicer**

Create `benchmark/locomo/slice.py`:

```python
from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class SliceResult:
    sample: dict[str, Any]
    summary: dict[str, Any]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-file", required=True, type=Path)
    parser.add_argument("--sample-id", required=True)
    parser.add_argument("--max-session", required=True, type=int)
    parser.add_argument("--out-file", required=True, type=Path)
    parser.add_argument("--summary-file", required=True, type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    result = build_slice(args.data_file, args.sample_id, args.max_session)
    write_slice(result, args.out_file, args.summary_file)
    print(json.dumps(result.summary, indent=2))


def build_slice(data_file: Path, sample_id: str, max_session: int) -> SliceResult:
    if max_session <= 0:
        raise ValueError("no QA rows remain after filtering: max_session must be positive")
    samples = json.loads(data_file.read_text(encoding="utf8"))
    source = next((item for item in samples if item.get("sample_id") == sample_id), None)
    if source is None:
        raise ValueError(f"LoCoMo sample not found: {sample_id} in {data_file}")

    conversation = source.get("conversation", {})
    retained_conversation: dict[str, Any] = {}
    for key in ("speaker_a", "speaker_b"):
        if key in conversation:
            retained_conversation[key] = conversation[key]

    retained_dialog_ids: list[str] = []
    retained_sessions: list[int] = []
    for session_no in range(1, max_session + 1):
        session_key = f"session_{session_no}"
        date_key = f"session_{session_no}_date_time"
        dialogs = conversation.get(session_key)
        if not isinstance(dialogs, list):
            continue
        retained_sessions.append(session_no)
        if date_key in conversation:
            retained_conversation[date_key] = conversation[date_key]
        retained_conversation[session_key] = dialogs
        retained_dialog_ids.extend(str(dialog.get("dia_id", "")) for dialog in dialogs if dialog.get("dia_id"))

    retained_id_set = set(retained_dialog_ids)
    qas = [
        qa
        for qa in source.get("qa", [])
        if qa_evidence_contained(qa, retained_id_set)
    ]
    if not qas:
        raise ValueError(
            f"no QA rows remain after filtering sample_id={sample_id} max_session={max_session}"
        )

    sample = {
        "sample_id": source["sample_id"],
        "conversation": retained_conversation,
        "qa": qas,
    }
    if "observation" in source:
        observation = slice_session_map(source["observation"], retained_sessions)
        if observation:
            sample["observation"] = observation
    if "session_summary" in source:
        summary = slice_session_map(source["session_summary"], retained_sessions)
        if summary:
            sample["session_summary"] = summary

    category_counts: dict[str, int] = {}
    for qa in qas:
        key = str(qa.get("category"))
        category_counts[key] = category_counts.get(key, 0) + 1

    summary = {
        "source_path": str(data_file),
        "source_sha256": sha256_file(data_file),
        "sample_id": sample_id,
        "max_session": max_session,
        "retained_sessions": retained_sessions,
        "retained_dialog_ids": retained_dialog_ids,
        "turn_count": len(retained_dialog_ids),
        "qa_count": len(qas),
        "category_counts": dict(sorted(category_counts.items())),
    }
    return SliceResult(sample=sample, summary=summary)


def qa_evidence_contained(qa: dict[str, Any], retained_ids: set[str]) -> bool:
    evidence = qa.get("evidence")
    return isinstance(evidence, list) and bool(evidence) and all(str(item) in retained_ids for item in evidence)


def slice_session_map(value: Any, retained_sessions: list[int]) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    prefixes = tuple(f"session_{session_no}_" for session_no in retained_sessions)
    return {
        key: item
        for key, item in value.items()
        if key.startswith(prefixes)
    }


def write_slice(result: SliceResult, out_file: Path, summary_file: Path) -> None:
    out_file.parent.mkdir(parents=True, exist_ok=True)
    summary_file.parent.mkdir(parents=True, exist_ok=True)
    enriched_summary = {
        **result.summary,
        "output_path": str(out_file),
        "summary_path": str(summary_file),
    }
    out_file.write_text(f"{json.dumps([result.sample], indent=2)}\n", encoding="utf8")
    summary_file.write_text(f"{json.dumps(enriched_summary, indent=2)}\n", encoding="utf8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run slicer tests**

Run:

```bash
python3 -m unittest benchmark.locomo.tests.test_slice
```

Expected:

- 4 tests pass.

- [ ] **Step 5: Generate the real slice artifact**

Run:

```bash
python3 benchmark/locomo/slice.py \
  --data-file benchmark/locomo/.cache/data/locomo10.json \
  --sample-id conv-26 \
  --max-session 1 \
  --out-file benchmark/locomo/out/conv-26-session-1.slice.json \
  --summary-file benchmark/locomo/out/conv-26-session-1.slice_summary.json
```

Expected summary:

- `sample_id` is `conv-26`.
- `turn_count` is `18`.
- `qa_count` is `4`.
- `retained_sessions` is `[1]`.

- [ ] **Step 6: Commit slicer**

Do not commit generated files under `benchmark/locomo/out`.

```bash
git add benchmark/locomo/slice.py benchmark/locomo/tests/test_slice.py
git commit -m "feat: add LoCoMo slice generator"
```

---

### Task 3: Add Recall Hit Diagnostics To QA Output

**Files:**
- Modify: `benchmark/locomo/run.py`
- Modify: `benchmark/locomo/tests/test_scoring.py`

- [ ] **Step 1: Write failing output-shape test**

In `benchmark/locomo/tests/test_scoring.py`, add `apply_predictions` to imports:

```python
from benchmark.locomo.run import apply_predictions
```

Add this test:

```python
    def test_apply_predictions_records_top_hit_diagnostics(self) -> None:
        qas = [
            {
                "question": "When did Caroline go to the support group?",
                "category": 2,
                "answer": "8 May 2023",
                "evidence": ["D1:3"],
            }
        ]
        hits = [
            RecallHit(
                memory_id="observing:1",
                evidence_ids=["D1:3", "D1:4"],
                date_time="1:56 pm on 8 May, 2023",
                title="Support group memory",
                summary="Caroline went to the support group.",
                detail="Caroline went to the support group on 8 May 2023.",
            )
        ]

        apply_predictions(qas, {0: hits}, "muninn_top_5")

        self.assertEqual(qas[0]["muninn_top_5_prediction"], "8 May 2023")
        self.assertEqual(qas[0]["muninn_top_5_prediction_context"], ["D1:3", "D1:4"])
        self.assertEqual(
            qas[0]["muninn_top_5_hits"],
            [
                {
                    "memory_id": "observing:1",
                    "title": "Support group memory",
                    "evidence_ids": ["D1:3", "D1:4"],
                    "date_time": "1:56 pm on 8 May, 2023",
                }
            ],
        )
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
python3 -m unittest benchmark.locomo.tests.test_scoring.ScoringTests.test_apply_predictions_records_top_hit_diagnostics
```

Expected:

- FAIL because `muninn_top_5_hits` is missing.

- [ ] **Step 3: Implement hit diagnostics**

In `benchmark/locomo/run.py`, update `apply_predictions()` after context collection:

```python
        qa[f"{prediction_key}_hits"] = [
            {
                "memory_id": hit.memory_id,
                "title": hit.title,
                "evidence_ids": hit.evidence_ids,
                "date_time": hit.date_time,
            }
            for hit in hits
        ]
```

- [ ] **Step 4: Run scoring tests**

Run:

```bash
python3 -m unittest benchmark.locomo.tests.test_scoring
```

Expected:

- All scoring tests pass.

- [ ] **Step 5: Commit diagnostics**

```bash
git add benchmark/locomo/run.py benchmark/locomo/tests/test_scoring.py
git commit -m "feat: add LoCoMo recall hit diagnostics"
```

---

### Task 4: Add Redacted Run Metadata

**Files:**
- Create: `benchmark/locomo/metadata.py`
- Create or modify: `benchmark/locomo/tests/test_metadata.py`
- Modify: `benchmark/locomo/run.py`

- [ ] **Step 1: Write failing metadata tests**

Create `benchmark/locomo/tests/test_metadata.py`:

```python
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
                "observer": {"name": "default-observer", "llm": "default"},
                "llm": {
                    "default": {
                        "provider": "openai",
                        "model": "doubao-seed",
                        "apiKey": "secret",
                        "baseUrl": "https://example.test",
                    }
                },
                "semanticIndex": {
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
```

- [ ] **Step 2: Run metadata tests to verify failure**

Run:

```bash
python3 -m unittest benchmark.locomo.tests.test_metadata
```

Expected:

- FAIL with `ModuleNotFoundError: No module named 'benchmark.locomo.metadata'`.

- [ ] **Step 3: Implement metadata module**

Create `benchmark/locomo/metadata.py`:

```python
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


SECRET_KEYS = {"apikey", "api_key", "token", "secret", "password", "authorization"}


def build_run_metadata(
    *,
    run_name: str,
    data_file: Path,
    out_file: Path,
    top_k: int,
    started_at: str,
    completed_at: str,
) -> dict[str, Any]:
    config_path = active_config_path()
    config = read_json_object(config_path)
    observer_ref = config.get("observer", {}).get("llm") if isinstance(config.get("observer"), dict) else None
    observer_llm = {}
    if isinstance(observer_ref, str) and isinstance(config.get("llm"), dict):
        observer_llm = config["llm"].get(observer_ref, {}) or {}
    semantic_index = config.get("semanticIndex", {})
    embedding = semantic_index.get("embedding", {}) if isinstance(semantic_index, dict) else {}
    return {
        "run_name": run_name,
        "data_file": str(data_file),
        "out_file": str(out_file),
        "top_k": top_k,
        "started_at": started_at,
        "completed_at": completed_at,
        "config_path": str(config_path),
        "observer": {
            "name": config.get("observer", {}).get("name") if isinstance(config.get("observer"), dict) else None,
            "provider": observer_llm.get("provider") if isinstance(observer_llm, dict) else None,
            "model": observer_llm.get("model") if isinstance(observer_llm, dict) else None,
        },
        "embedding": {
            "provider": embedding.get("provider") if isinstance(embedding, dict) else None,
            "model": embedding.get("model") if isinstance(embedding, dict) else None,
            "dimensions": embedding.get("dimensions") if isinstance(embedding, dict) else None,
        },
        "config": redact(config),
    }


def write_run_metadata(out_file: Path, metadata: dict[str, Any]) -> Path:
    metadata_file = out_file.with_name(f"{out_file.stem}_metadata.json")
    metadata_file.parent.mkdir(parents=True, exist_ok=True)
    metadata_file.write_text(f"{json.dumps(metadata, indent=2)}\n", encoding="utf8")
    return metadata_file


def active_config_path() -> Path:
    home = os.environ.get("MUNINN_HOME")
    if home and home.strip():
        return Path(home) / "muninn.json"
    return Path.home() / ".muninn" / "muninn.json"


def read_json_object(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    value = json.loads(path.read_text(encoding="utf8"))
    return value if isinstance(value, dict) else {}


def redact(value: Any) -> Any:
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, dict):
        output: dict[str, Any] = {}
        for key, item in value.items():
            if key.lower() in SECRET_KEYS:
                output[key] = "<redacted>"
            else:
                output[key] = redact(item)
        return output
    return value
```

- [ ] **Step 4: Wire metadata into runner**

In `benchmark/locomo/run.py`, import:

```python
from benchmark.locomo.metadata import build_run_metadata, write_run_metadata
```

Add this helper near `build_model_key()`:

```python
def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
```

Change `run_started_at = monotonic()` to:

```python
    run_started_at = monotonic()
    run_started_timestamp = utc_now()
```

After `write_report`, add:

```python
        run_phase(
            reporter,
            "write_metadata",
            lambda: write_run_metadata(
                args.out_file,
                build_run_metadata(
                    run_name=args.out_file.stem,
                    data_file=args.data_file,
                    out_file=args.out_file,
                    top_k=args.top_k,
                    started_at=run_started_timestamp,
                    completed_at=utc_now(),
                ),
            ),
            out_file=args.out_file.with_name(f"{args.out_file.stem}_metadata.json"),
        )
```

- [ ] **Step 5: Run metadata and runner tests**

Run:

```bash
python3 -m unittest benchmark.locomo.tests.test_metadata benchmark.locomo.tests.test_run benchmark.locomo.tests.test_scoring
```

Expected:

- All tests pass.

- [ ] **Step 6: Commit metadata**

```bash
git add benchmark/locomo/metadata.py benchmark/locomo/tests/test_metadata.py benchmark/locomo/run.py
git commit -m "feat: add LoCoMo run metadata"
```

---

### Task 5: Full Benchmark Package Verification And Real Slice Run

**Files:**
- No source files required.
- Generated outputs under `benchmark/locomo/out/` must remain untracked.

- [ ] **Step 1: Run full LoCoMo package tests**

Run:

```bash
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/pnpm --filter @muninn/benchmark-locomo test
```

Expected:

- TypeScript bridge builds.
- Python tests pass.
- Node bridge tests pass.

- [ ] **Step 2: Ensure LoCoMo source data exists**

Run:

```bash
sh benchmark/locomo/scripts/fetch-data.sh
```

Expected:

- Prints `locomo: data ready at ...`.
- Does not fail checksum validation.

- [ ] **Step 3: Generate conv-26 session-1 slice**

Run:

```bash
python3 benchmark/locomo/slice.py \
  --data-file benchmark/locomo/.cache/data/locomo10.json \
  --sample-id conv-26 \
  --max-session 1 \
  --out-file benchmark/locomo/out/conv-26-session-1.slice.json \
  --summary-file benchmark/locomo/out/conv-26-session-1.slice_summary.json
```

Expected:

- `turn_count` is `18`.
- `qa_count` is `4`.
- `category_counts` includes categories `1`, `2`, and `3`.

- [ ] **Step 4: Run real slice benchmark**

Use the local untracked repo-root config as active Muninn config.

Run:

```bash
MUNINN_HOME=/Users/Nathan/workspace/muninn \
MUNINN_LOCOMO_WATERMARK_TIMEOUT_MS=1800000 \
MUNINN_LOCOMO_WATERMARK_WARNING_DELAY_MS=60000 \
PATH=/opt/homebrew/bin:$PATH \
python3 benchmark/locomo/run.py \
  --data-file benchmark/locomo/out/conv-26-session-1.slice.json \
  --out-file benchmark/locomo/out/conv-26-session-1.real.json \
  --progress-file benchmark/locomo/out/conv-26-session-1.real.progress.jsonl \
  --top-k 5
```

Expected:

- Run completes before 30 minutes.
- Progress log includes `import_sample`, `recall_batch`, `build_predictions`, `aggregate_stats`, `write_outputs`, `write_report`, and `write_metadata`.
- No API key or secret appears in stdout/stderr.

- [ ] **Step 5: Inspect outputs**

Run:

```bash
node -e "const s=require('./benchmark/locomo/out/conv-26-session-1.real_stats.json'); console.log(JSON.stringify(s, null, 2));"
node -e "const r=require('./benchmark/locomo/out/conv-26-session-1.real_report.json'); console.log(JSON.stringify(r, null, 2));"
node -e "const x=require('./benchmark/locomo/out/conv-26-session-1.real.json'); console.log(JSON.stringify(x[0].qa.map(q => ({question:q.question,prediction:q.muninn_top_5_prediction,context:q.muninn_top_5_prediction_context,hits:q.muninn_top_5_hits})), null, 2));"
node -e "const m=require('./benchmark/locomo/out/conv-26-session-1.real_metadata.json'); const raw=JSON.stringify(m); if(/apiKey|secret|42578|cc487/.test(raw)) process.exit(1); console.log(JSON.stringify({observer:m.observer, embedding:m.embedding}, null, 2));"
```

Expected:

- Stats JSON has `qa_count: 4`.
- Each QA has `muninn_top_5_hits`.
- Metadata command exits 0 and prints observer/embedding summary without secrets.

- [ ] **Step 6: Record final benchmark summary for the user**

Do not commit generated output files. Summarize:

- slice path and summary path
- run output paths
- elapsed time from progress log
- `average_f1`
- `average_recall`
- category scores
- per-QA question, gold answer, prediction, evidence, retrieved contexts, and top hit memory ids
- whether any hit is broad, meaning it contains many evidence ids beyond the gold evidence

- [ ] **Step 7: Confirm working tree**

Run:

```bash
git status --short --branch
```

Expected:

- Only intended source changes are tracked.
- `muninn.json` remains untracked.
- Generated files under `benchmark/locomo/out/` remain untracked or ignored.

