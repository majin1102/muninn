# Observation 设计

当前仓库里的正式实现术语以 `observing` 为准。

这份文档保留 `observation` 这个更通用的产品概念，用来说明它和当前 `observing` 实现之间的关系。

## 1. Product-Level Intuition

从产品视角看，`observation` 表示 agent 对一段工作过程形成的可复用观察结果：

- 它不是原始 turn 的逐字拷贝
- 它也不是单纯的一段 summary prose
- 它应该能被再次 recall、detail、timeline

## 2. Current Implementation Mapping

当前实现中，产品概念上的 `observation` 对应的是 `observing` layer。

具体映射：

- 一条产品层面的“观察线”
  - 对应一个 `observing_id`
- 该观察线的某一次状态切片
  - 对应一个 observing snapshot row
  - 对外 `memoryId = observing:{row_id}`

所以当前并没有单独的 `observation` public layer；产品上的 observation 通过 `observing` snapshot rows 落地。

## 3. Why Snapshot Rows

当前实现选择“一行一个 observing snapshot”，而不是“一行保存整条 observation 历史”，原因是：

- `memoryId` 能稳定指向单个原子 row
- `detail` 的语义保持单行读取
- `timeline` 可以自然围绕 snapshot 做邻接窗口
- semantic index 可以按 sequence 逐步追平

## 4. What Stays Internal

以下概念仍然属于内部组织层，不直接暴露为 public memory id：

- observing line identity：`observing_id`
- gateway routing 决策
- runtime 聚合态与恢复逻辑

对 agent/MCP 来说，当前正式可见的 public observation surface 仍然是：

- `observing:{row_id}`

## 5. Future Direction

如果后续确实需要把“整条 observing line”也提升为一级 public memory object，再单独引入新的 public layer 或新的 read contract。

在当前阶段，保持：

- line 只做内部 grouping
- snapshot row 才是 public memory

是更清晰、更稳定的选择。
