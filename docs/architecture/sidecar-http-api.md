# Muninn HTTP Sidecar Service API

本文档描述当前 sidecar HTTP API 的行为边界与读写语义。

## 0. Design Principles

### Read Side

- 读接口与 MCP tools 对齐：`recall`、`list`、`timeline`、`detail`
- text-first：最终返回 `MemoryHit[]`，每个 `content` 为 Markdown
- 结构化读取在 lance core 内部分层完成，sidecar 通过 `@muninn/core` 调用并负责组合与渲染

### Write Side

- 当前正式写接口只有 `POST /api/v1/session/messages`
- 观察/summary/semantic index 都属于后续派生流程，不作为独立 HTTP 写接口暴露

## 1. Shared Response Types

```ts
export interface MemoryHit {
  memoryId: string;
  content: string;
}

export interface MemoryResponse {
  memoryHits: MemoryHit[];
  requestId: string;
}
```

补充说明：

- `memoryId` 仍是 HTTP 读侧统一导航键
- 约定为 `memoryId = {memoryLayer}:{memoryPoint}`
- 当前有效值包括 `SESSION:{turn_id}` 与 `OBSERVING:{snapshot_id}`
- `SESSION` 是 public memory layer；内部仍然由 session turn rows 承载
- `OBSERVING` 当前对应 observing snapshot row，不对应 observing line

## 2. Read Endpoints

### 2.1 `GET /api/v1/recall`

用途：

- 执行当前 demo 的文本检索

Query 参数：

- `query: string`
- `limit?: number`
- `thinkingRatio?: number`

说明：

- sidecar 通过 `@muninn/core` 的统一 rendered 读接口读取 cross-layer recall 结果
- `@muninn/core` 返回 `RenderedMemoryRecord[]`
- sidecar 仅负责将 `RenderedMemoryRecord` 渲染为统一 `MemoryHit[]`

### 2.2 `GET /api/v1/list`

用途：

- 最近浏览

Query 参数：

- `mode: "recency"`
- `limit?: number`
- `thinkingRatio?: number`

说明：

- sidecar 通过 `@muninn/core` 的统一 rendered `list` 接口读取 recent window
- lance core 内部会：
  - 读取 `SESSION` 层最近 session memory points（内部来源于 session turn rows）
  - 读取 `OBSERVING` 层每条 observing line 的 latest snapshot row
  - 按 recency 合并成统一 `RenderedMemoryRecord[]`
- sidecar 再将其渲染为 `MemoryHit[]`
- 输出顺序从旧到新，便于直接注入 LLM context

### 2.3 `GET /api/v1/timeline`

用途：

- 以 `memoryId` 为锚点返回前后窗口

Query 参数：

- `memoryId: string`
- `beforeLimit?: number`
- `afterLimit?: number`

说明：

- sidecar 通过 `@muninn/core` 的统一 rendered `timeline` 接口读取同层邻近 records
- `SESSION:{turn_id}`
  - 返回同层 session timeline（内部来源于 session turn rows）
- `OBSERVING:{snapshot_id}`
  - 返回同一 `observing_id` 下按 `snapshot_sequence` 排序的邻近 snapshot rows

### 2.4 `GET /api/v1/detail`

用途：

- 返回单条详情

Query 参数：

- `memoryId: string`

说明：

- sidecar 通过 `@muninn/core` 的统一 rendered `detail` 接口读取单个 memory row
- `detail` 约定只返回一条 `MemoryHit`
- `OBSERVING:{snapshot_id}` 返回的是单个 observing snapshot 的 detail 文档

## 3. Write Endpoint

### 3.1 `POST /api/v1/session/messages`

用途：

- 向某个逻辑 session 添加一条 message

请求体语义：

```ts
export interface SessionMessageInput {
  session_id?: string;
  agent: string;
  title?: string;
  summary?: string;
  tool_calling?: string[];
  artifacts?: Record<string, string>;
  prompt?: string;
  response?: string;
  extra?: Record<string, string>;
}
```

说明：

- `session_id` 是逻辑分组键
- 至少要有一项 message 内容
- `extra` 仅属于 API 传输层，不写入持久化 schema
- `response` 可独立持久化，不依赖 `summary` 是否生成

## 4. Rendering Boundary

当前 sidecar 的渲染边界已经收敛为：

- lance core 负责把不同 layer 的结构化 record 统一为 `RenderedMemoryRecord`
- sidecar 负责把 `RenderedMemoryRecord` 渲染为 Markdown `MemoryHit`

也就是说：

- 结构化 layer 读取仍在 lance core 内部分层完成
- HTTP/MCP 输出仍以 sidecar 渲染后的 `MemoryHit[]` 为准
