# Muninn HTTP Sidecar Service API

本文档描述当前 sidecar HTTP API 的行为边界与读写语义。

## 0. Design Principles

### Read Side

- 读接口与 MCP tools 对齐：`recall`、`list`、`timeline`、`detail`
- text-first：最终返回 `MemoryHit[]`，每个 `content` 为 Markdown
- 结构化读取在 server memory runtime 内部分层完成，sidecar 负责组合与渲染

### Write Side

- 当前正式写接口只有 `POST /api/v1/turn/capture`
- session snapshot、extraction 和索引都属于后续派生流程，不作为独立 HTTP 写接口暴露

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

- `memoryId` 是 HTTP 读侧统一导航键
- 约定为 `memoryId = {memoryLayer}:{memoryPoint}`
- 当前有效值包括 `session:{row_id}` 与 `extraction:{id}`

## 2. Read Endpoints

### 2.1 `GET /api/v1/recall`

用途：

- 执行文本检索

Query 参数：

- `query: string`
- `limit?: number`
- `thinkingRatio?: number`

说明：

- server 读取 extraction table 并返回 rendered memory hits
- sidecar 仅负责将 rendered memory 渲染为统一 `MemoryHit[]`

### 2.2 `GET /api/v1/list`

用途：

- 最近浏览

Query 参数：

- `mode: "recency"`
- `limit?: number`
- `thinkingRatio?: number`

说明：

- 返回最近 session memory points
- 输出顺序从旧到新，便于直接注入 LLM context

### 2.3 `GET /api/v1/timeline`

用途：

- 以 `memoryId` 为锚点返回前后窗口

Query 参数：

- `memoryId: string`
- `beforeLimit?: number`
- `afterLimit?: number`

说明：

- `session:{row_id}` 返回同层 session timeline
- `extraction:{id}` 当前不提供 timeline 语义

### 2.4 `GET /api/v1/detail`

用途：

- 返回单条详情

Query 参数：

- `memoryId: string`

说明：

- `detail` 约定只返回一条 `MemoryHit`
- 当前支持 `session:{row_id}` 和 `extraction:{id}`

## 3. Write Endpoint

### 3.1 `POST /api/v1/turn/capture`

用途：

- 写入一条完整 turn

请求体语义：

```ts
export interface TurnContent {
  sessionId: string;
  project?: string;
  cwd?: string;
  agent: string;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
  turnSequence?: number;
  events: TurnEvent[];
  artifacts?: Artifact[];
  prompt?: string;
  response?: string;
}
```

说明：

- `sessionId` 是逻辑分组键
- `agent` 是当前 turn 的基础归属信息
- `extractor` 是 backend 内部注入的运行时身份字段，不由 capture 请求提供
- `events` 是本轮 user/assistant/tool 事件的有序列表
- `artifacts` 是可选结构化附件信息

## 4. Rendering Boundary

当前 sidecar 的渲染边界已经收敛为：

- server memory runtime 负责把结构化 record 统一为 rendered memory
- sidecar 负责把 rendered memory 渲染为 Markdown `MemoryHit`

也就是说：

- 结构化 layer 读取仍在 server 内部分层完成
- HTTP/MCP 输出仍以 sidecar 渲染后的 `MemoryHit[]` 为准
