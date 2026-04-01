import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import { collectArtifacts } from "../dist/src/artifacts.js";

test("collectArtifacts uses write params content directly", async () => {
  const artifacts = await collectArtifacts({
    toolName: "write",
    toolParams: {
      path: "docs/a.md",
      content: "hello",
    },
    logger: {},
  });

  assert.deepEqual(artifacts, { "docs/a.md": "hello" });
});

test("collectArtifacts reads edit target from workspace", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "muninn-plugin-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  await writeFile(path.join(dir, "src.txt"), "edited");

  const artifacts = await collectArtifacts({
    toolName: "edit",
    toolParams: {
      path: "src.txt",
    },
    workspaceDir: dir,
    logger: {},
  });

  assert.deepEqual(artifacts, { "src.txt": "edited" });
});

test("collectArtifacts returns undefined when exec output has no path", async () => {
  const artifacts = await collectArtifacts({
    toolName: "exec",
    toolParams: {
      output: "ok",
    },
    logger: {},
  });

  assert.equal(artifacts, undefined);
});

test("collectArtifacts extracts paths from apply_patch", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "muninn-plugin-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  await writeFile(path.join(dir, "file1.txt"), "content1");
  await writeFile(path.join(dir, "file2.txt"), "content2");

  const artifacts = await collectArtifacts({
    toolName: "apply_patch",
    toolParams: {
      patch: "*** Add File: file1.txt\n*** Update File: file2.txt",
    },
    workspaceDir: dir,
    logger: {},
  });

  assert.deepEqual(artifacts, {
    "file1.txt": "content1",
    "file2.txt": "content2",
  });
});

test("collectArtifacts extracts paths from exec output", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "muninn-plugin-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  await writeFile(path.join(dir, "result.json"), '{"status":"ok"}');

  const artifacts = await collectArtifacts({
    toolName: "exec",
    toolParams: {
      output: "Generated ./result.json successfully",
    },
    workspaceDir: dir,
    logger: {},
  });

  assert.deepEqual(artifacts, {
    "./result.json": '{"status":"ok"}',
  });
});

test("collectArtifacts degrades gracefully on read failure", async () => {
  const warnings = [];
  const artifacts = await collectArtifacts({
    toolName: "edit",
    toolParams: {
      path: "nonexistent.txt",
    },
    workspaceDir: "/tmp",
    logger: {
      warn: (msg) => warnings.push(msg),
    },
  });

  assert.equal(artifacts, undefined);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /artifact read failed/);
});
