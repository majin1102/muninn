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
  │  TypeScript API
  ▼
server memory runtime
  │
  │  native binding
  ▼
Rust format subsystem in `format/` (typed turn / session snapshot / extraction table operations)
```

## 2. Component Responsibilities

- MCP Server
  - 暴露 `print`、`recall`、`list`、`get_timeline`、`get_detail`
  - 只做参数校验、sidecar 调用与文本返回
- Sidecar / HTTP server
  - 提供 HTTP 读写接口
  - 将 structured memory 文档渲染为 `MemoryHit[]`
- `server` memory runtime
  - 编排 capture、extractor、recall、session index 和 watchdog
  - 连接 HTTP surface 与 Rust native binding
- Rust format subsystem in `format/`
  - 提供 typed table 读写能力
  - 维护底层存储、typed rows、FTS/vector index 和 table maintenance

## 3. Text-First Output

当前 MCP 与 sidecar 的最终输出统一为：

```ts
export interface MemoryHit {
  memoryId: string;
  content: string;
}
```

说明：

- `content` 为 Markdown
- MCP 直接拼接 `MemoryHit.content`
- server 是当前 structured memory -> `MemoryHit` 的渲染边界

## 4. Memory Navigation

统一导航键为 `memoryId`。

当前有效语义：

- `session:{row_id}`
- `extraction:{id}`

其中：

- `session` 指向 turn/session navigation point
- `extraction` 指向 extraction memory row
- 当前只暴露 session / extraction memory id

## 5. Read Semantics

MCP 暴露的结构化读能力对应 server 内部的统一读语义：

- `list`
  - 返回最近 session memory points
- `detail`
  - 返回单个 session 或 extraction memory
- `timeline`
  - 返回 session anchor 周围的邻近 turn/session memory points
- `recall`
  - 查询 extraction table，属于 retrieval 行为

## 6. MCP Boundary

当前 MCP 层故意保持很薄，不承载以下职责：

- layer-specific 查询语义
- 结构化 record 聚合
- 文本渲染策略
- extraction/index/recall 业务逻辑

这些职责都留在 sidecar 和 server memory runtime；Rust `format/` 只负责 typed table / storage 能力。
