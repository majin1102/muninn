# Muninn MCP API Spec

本文档定义当前 Muninn 暴露给 agent 的 MCP tools 语义与输入参数。

## 1. Core Concepts

### 1.1 `memoryId`

MCP 层通过 `memoryId: string` 读取 memory。

约定：

```text
memoryId = {memoryLayer}:{memoryPoint}
```

当前有效语义：

- `session:{row_id}`
  - 指向单个 turn/session navigation point
- `extraction:{id}`
  - 指向单个 extraction memory row

MCP 当前只暴露 `session` 和 `extraction` memory id。

### 1.2 `MemoryHit`

所有读工具最终都收敛为：

```ts
export interface MemoryHit {
  memoryId: string;
  content: string;
}
```

其中：

- `content` 为 Markdown 文本
- `MemoryHit[]` 是 sidecar 与 MCP 之间的统一读结果载体

MCP 保持 text-first；结构化读取、排序和渲染都留在 server/sidecar。

## 2. Tool Semantics

### 2.1 `recall`

用途：

- 执行文本检索

输入参数：

- `query: string`
- `limit?: number`
- `thinkingRatio?: number`

输出：

- MCP 文本结果，底层来源于 `MemoryResponse`

说明：

- `recall` 属于 retrieval 行为，不属于基础 browse/navigation 读接口
- 当前 recall 只查询 extraction memory

### 2.2 `list`

用途：

- 浏览最近 memories

输入参数：

- `mode: "recency"`
- `limit?: number`
- `thinkingRatio?: number`

输出：

- MCP 文本结果，底层来源于 `MemoryResponse`

语义：

- `list` 返回最近 session memory points
- 输出顺序为从旧到新，便于直接注入 LLM context

### 2.3 `get_timeline`

用途：

- 读取某个 anchor memory 周围的同层邻近 records

输入参数：

- `memoryId: string`
- `beforeLimit?: number`
- `afterLimit?: number`

输出：

- MCP 文本结果，底层来源于 `MemoryResponse`

语义：

- `session:{row_id}` 返回同 agent/session 条件下的邻近 turn/session memory points
- `extraction:{id}` 当前不提供 timeline 语义

### 2.4 `get_detail`

用途：

- 读取单个 memory row 的完整内容

输入参数：

- `memoryId: string`

输出：

- MCP 文本结果，底层来源于 `MemoryResponse`

说明：

- `get_detail` 约定只返回单条 `MemoryHit`
- 当前支持 `session:{row_id}` 和 `extraction:{id}`

### 2.5 `print`

用途：

- 本地调试
- 打印参数并生成 Markdown 调试文件

输入参数：

- `message?: string`
- `data?: unknown`

## 3. Shared Response Type

```ts
export interface MemoryResponse {
  memoryHits: MemoryHit[];
  requestId: string;
}
```

## 4. MCP Layer Boundary

当前 MCP 层职责保持极简：

- 定义 tool schema
- 调用 sidecar
- 把 sidecar 返回的 `MemoryHit[]` 直接拼接成文本结果

当前不在 MCP 层承担：

- memory 排序策略
- structure-to-text 渲染策略
- cross-layer business logic

这些职责都保留在 sidecar / server memory runtime / Rust format。
