# Muninn MCP 接口与服务设计

本文档描述当前仓库中 Muninn 的 MCP 接口与服务端架构。

## 1. Current Architecture

```text
Agent
  │
  │  MCP stdio
  ▼
Muninn MCP Server
  │
  │  HTTP
  ▼
Muninn Sidecar
  │
  │  TypeScript binding
  ▼
@muninn/core
  │
  │  native binding
  ▼
Rust storage core in `core/` (typed session / observing / semantic table operations)
```

### Component Responsibilities

- MCP Server
  - 暴露 `print`、`recall`、`list`、`get_timeline`、`get_detail`
  - 只做参数校验、sidecar 调用与文本返回
- Sidecar
  - 提供 HTTP 读写接口
  - 将 `RenderedMemoryRecord` 渲染为 `MemoryHit[]`
- `@muninn/core`
  - 作为 TS 业务编排层连接 sidecar 和 Rust native binding
  - 持有 session / observer / memories / llm 的主逻辑
- Rust core in `core/`
  - 提供 typed table 读写能力
  - 维护底层存储、typed rows 与 semantic index 表操作

## 2. Text-First Output

当前 MCP 与 sidecar 的最终输出仍然统一为：

```ts
export interface MemoryHit {
  memoryId: string;
  content: string;
}
```

说明：

- `content` 为 Markdown
- MCP 直接拼接 `MemoryHit.content`
- sidecar 是当前的 `RenderedMemoryRecord -> MemoryHit` 渲染边界

`@muninn/core` 当前对 sidecar 暴露的是 `RenderedMemoryRecord` 等 TS contract，但 MCP 并不直接消费它；MCP 仍通过 sidecar 的 `MemoryHit[]` 获得最终文本。

## 3. Memory Navigation

统一导航键仍为 `memoryId`。

当前有效语义：

- `session:{row_id}`
- `observing:{row_id}`

其中：

- `OBSERVING` 现在表示 observing snapshot row
- `observing_id` 是内部 observing line 分组键，不单独暴露为 MCP memory id

## 4. Read Semantics

MCP 暴露的结构化读能力对应 core 内部的统一读语义：

- `list`
  - layer 的顶层浏览接口
- `detail`
  - 单个 memory row
- `timeline`
  - 单个 anchor row 周围的同层邻近 records

具体到当前已落地 layers：

- `session`
  - `list` 返回最近 session memory points（内部来源于 session turn rows）
  - `timeline` 返回相邻 session memory points（内部来源于 session turn rows）
- `observing`
  - `list` 返回每条 observing line 的 latest snapshot row
  - `detail` 返回单个 observing snapshot row
  - `timeline` 返回同一 `observing_id` 下按 `snapshot_sequence` 排序的邻近 snapshot rows

`recall` 继续独立于这套接口，因为它属于 retrieval，而不是基础结构化读取。

## 5. MCP Boundary

当前 MCP 层故意保持很薄，不承载以下职责：

- layer-specific 查询语义
- 结构化 record 聚合
- 文本渲染策略
- semantic index / observer 业务逻辑

这些职责都留在 sidecar 和 `@muninn/core`；Rust `core/` 只负责 typed table / storage 能力。
