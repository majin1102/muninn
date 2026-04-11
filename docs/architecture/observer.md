# Observer 设计

本文档描述当前 observer 的实现边界与核心模型。

## 1. Goal

`observer` 的目标不是把原始对话压成一段 prose，而是把完成的 turns 组织成更适合：

- recall
- detail 下钻
- timeline 恢复上下文
- 后续 thinking / abstraction

的 observing memory。

## 2. Core Model

当前 observer 明确分成两层概念：

### 2.1 Observing Line

内存中的 `ObservingThread` 表示一条 observing line。

它的职责是：

- 维护当前聚合态
- 维护该 line 的标题、摘要、当前内容快照
- 按 `observing_id` 聚合同一条线上的多次更新

`observing_id` 是 observing line 的稳定 identity，但不是对外 `memoryId`。

### 2.2 Observing Snapshot Row

持久化到 `observing` 表中的一行表示一个 observing snapshot row。

关键字段：

- `snapshotId`
- `observingId`
- `snapshotSequence`
- `content`
- `references`
- `checkpoint`

其中：

- `snapshotId`
  - 当前 row 的唯一 identity
  - 对外暴露为 `observing:{row_id}`
- `observingId`
  - 同一条 line 的 grouping key
- `snapshotSequence`
  - 当前 row 在该 line 内的顺序
- `content`
  - 当前 snapshot 的完整内容 JSON
  - 序列化的是 `SnapshotContent`
- `references`
  - 当前 snapshot 的有界 provenance
  - 累计保留形成当前 snapshot 的来源引用
  - 默认最多保留 `1000` 条，超限时优先淘汰最老的 `session:*` 引用
- `checkpoint`
  - 当前 row 持久化的 checkpoint 信息
  - 包含 `observingEpoch` 和 `indexedSnapshotSequence`

当前 `references` 只表示 provenance。

- 不维护 observing-to-observing 的父子关系
- 不保证包含 parent observing ref

## 3. Runtime And Persistence Boundary

当前实现刻意保持 observer 的内存聚合模型尽量不变：

- runtime 仍按 `observing_id` 聚合
- 每次 observe update 生成新的当前 snapshot
- flush 时 append 一个新的 observing snapshot row

也就是说：

- 内存里是 line-oriented runtime
- 盘上是 snapshot-oriented rows

启动恢复时：

- 读取 observing 表全部 snapshot rows
- 按 `observing_id` 分组
- 按 `snapshot_sequence` 排序
- 用 latest row 恢复每条 line 的当前聚合态

当前 `ObservingSnapshot.content` 对应的 `SnapshotContent` 包含：

- `memories`
  - 当前 snapshot 的完整 materialized memories
- `openQuestions`
  - 当前 observing line 的 full-image open questions
- `nextSteps`
  - 当前 observing line 的 full-image next steps
- `memoryDelta`
  - 当前 snapshot 相对上一版的 memory delta

也就是说：

- 盘上保留的是完整内容快照
- semantic index 追平时只消费 `memory_delta`

当前 lifecycle 语义：

- `shutdown()`
  - fast stop
  - 停止接收新的 observer 工作
  - 尽快中断 in-flight 的网络型 observe/index 请求
  - 不保证排干 staged epoch、queued epoch 或 semantic index backlog
- `flushPending()`
  - 显式 barrier-drain
  - 调用瞬间会先封口当前 `openEpoch`
  - 只保证排干 barrier 之前已经进入 observer 的工作
  - barrier 之后新进入的 `accept` 不属于这次 flush
- restart replay
  - shutdown 时未 publish / 未 observe 的 observable turns 不靠内存态续跑
  - 下次启动时通过 `loadTurnsAfterEpoch(committedEpoch)` 从 session rows 重新恢复

## 4. Observe LLM Contract

当前 observe update 的 LLM 输入输出已经固定为：

- `ObserveRequest`
  - `observing_content`
    - `title`
    - `summary`
    - `memories`
    - `openQuestions`
    - `nextSteps`
  - `pending_turns`
- `ObserveResult`
  - `observing_content_update`
    - `title`
    - `summary`
    - `openQuestions`
    - `nextSteps`
  - `memoryDelta`

关键语义：

- `memories` 是唯一的 delta 字段，也是 semantic index 的输入
- `openQuestions` / `nextSteps` 不是 delta，而是 full-image 覆盖
- 不再单独维护 `concepts`；概念类长期内容统一落到 `ObservedMemory.category = Concept`

## 5. Gateway Semantics

`ObservingGateway` 的职责是：

- 看当前已有 observing lines
- 看最新完成的 turns
- 决定 turn 应该 append 到哪个已有 line
- 或是否派生出新的 line

关键原则：

- 一个 turn 可以贡献给多个 observing lines
- gateway 返回的是 update routing，不是唯一归属
- gateway 输入使用 `observing_threads`
- 新建 line 的 hint 字段为 `new_thread`

## 6. Semantic Index Catch-up

semantic index 不再依赖单行里的 `snapshots[]` 数组。

当前逻辑是：

- 按 `observing_id` 聚合同一条线的 snapshot rows
- 依据 `checkpoint.indexed_snapshot_sequence` 找到尚未投影的 snapshot
- 用相邻 snapshots 做 diff projection
- 追平后更新该 line 的 latest indexed sequence

## 7. Read Semantics

当前 `observing` 读语义已经固定：

- `list`
  - 返回每条 observing line 的 latest snapshot row
- `detail`
  - 返回单个 snapshot row
- `timeline`
  - 返回同一 `observing_id` 下按 `snapshot_sequence` 排序的邻近 snapshot rows

这保证了 `observing` layer 与 `session` layer 一样，都是 row-oriented 的 public memory surface。
