# Muninn MCP API Spec

本文档定义当前 Muninn 暴露给 agent 的 MCP tools 语义与输入参数。

## 1. Core Concepts

### 1.1 `memoryId`

MCP 层当前统一通过 `memoryId: string` 读取 memory。

约定：

- `memoryId = {memoryLayer}:{memoryPoint}`

当前有效语义：

- `session:{row_id}`
  - 指向单个 session memory point（内部落在 turn row 上）
- `observing:{row_id}`
  - 指向单个 observing snapshot row

MCP 不单独暴露 observing line id；`observing_id` 只作为内部 grouping key 存在。

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

MCP 仍保持 text-first；当前不直接暴露 `@muninn/core` 的 `RenderedMemoryRecord`，而是通过 sidecar 将其渲染为 `MemoryHit[]`。

## 2. Tool Semantics

### 2.1 `recall`

用途：

- 执行当前 demo 的文本检索

输入参数：

- `query: string`
- `limit?: number`
- `thinkingRatio?: number`

输出：

- MCP 文本结果，底层来源于 `MemoryResponse`

说明：

- `recall` 不属于基础 browse/navigation 读接口
- 它属于 retrieval 行为

### 2.2 `list`

用途：

- 浏览最近的 memories

输入参数：

- `mode: "recency"`
- `limit?: number`
- `thinkingRatio?: number`

输出：

- MCP 文本结果，底层来源于 `MemoryResponse`

语义：

- `list` 是 layer 的顶层浏览接口
- `SESSION` 返回最近 session memory points 的窗口（内部来源于 session turn rows）
- `OBSERVING` 返回每条 observing line 的 latest snapshot row
- sidecar 合并不同 layer 的结果后，再按时间窗口输出给 MCP
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

- `SESSION`
  - 围绕 anchor session memory point 返回同 agent/session 条件下的邻近 session memory points（内部来源于 session turn rows）
- `OBSERVING`
  - 围绕 anchor snapshot 返回同一 `observing_id` 下按 `snapshot_sequence` 的邻近 snapshot rows

### 2.4 `get_detail`

用途：

- 读取单个 memory row 的完整内容

输入参数：

- `memoryId: string`

输出：

- MCP 文本结果，底层来源于 `MemoryResponse`

说明：

- `get_detail` 约定只返回单条 `MemoryHit`
- `observing:{row_id}` 返回的是单个 observing snapshot row，而不是整条 observing line

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

这些职责都保留在 sidecar / `@muninn/core` / lance core。
