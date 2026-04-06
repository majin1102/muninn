# Cycle 01 Plan

## Problem Clusters

### Cluster 1
- Symptoms: observer flush 失败时，`buffer` 会回填，但 `threads` 可能已经被原地修改。
- Root cause: 提交前阶段直接在真实 `this.threads` 上工作，第一次 `observingTable.upsert(...)` 之前没有 staging 边界。
- Fix: 提交前改在线程副本上执行；第一次 `observingTable.upsert(...)` 作为提交点；`applyParentRefs(...)` 降成提交后的补写，失败仅记录日志，不再打断整轮 flush。
- Validation: `@muninn/core` build、core tests、sidecar tests、Rust core/native `cargo check`。
- Risks: `applyParentRefs(...)` 降级后，`pendingParentId` 需要保留，确保后续补写仍然可恢复。

## Global Plan Review

- Coverage gaps: 需要同时验证两类失败边界。
- Possible regressions: 提交前失败时 `buffer` / `observingBuffer` / `observingEpoch` 回收不完整；提交后 `parent refs` 失败时错误地把 flush 打回失败。
- Extra tests needed:
  - 提交前失败时，`threads` 不污染。
  - 第一次 observing upsert 成功、`applyParentRefs(...)` 失败时，flush 仍成功，`pendingParentId` 仍保留。

## Final Plan

- 用线程深拷贝把 observer 提交前 staging 做实。
- 把 `flushOnce` / `ensureRootThread` 命名整理成 `flushWindow` / `ensureActiveThreads`。
- 补两条 observer 内部回归，并跑 core / sidecar / Rust native 相关验证。
