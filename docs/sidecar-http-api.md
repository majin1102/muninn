# Munnai HTTP Sidecar Service API（当前 Demo 对齐版）

本文档描述当前仓库中的 sidecar HTTP API。文档继续沿用“读取接口 / 写入接口”的组织方式，但内容以当前 demo 的真实接口为准。

## 0. 设计原则

### 读取接口（Read）

- **与当前 MCP tools 对齐**：`recall`、`list`、`timeline`、`detail`
- **text-first**：返回 `MemoryHit[]`，每个 `content` 为 Markdown
- **统一响应形状**：统一使用 `MemoryResponse`

### 写入接口（Write）

- **当前只保留 turn 写入**
- **单条写入**：当前 demo 的路径仍为 `message/add`
- **服务端生成标识与时间**：单条持久化记录的标识统一记为 `turnId`

---

## 1. 基础约定

### 1.1 错误格式

当前错误响应统一为：

```ts
export interface ErrorResponse {
  errorCode: string;
  errorMessage: string;
  requestId: string;
}
```

### 1.2 读响应格式

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

---

## 2. 读取接口（Read）

### 2.1 `GET /api/v1/recall`

用途：
- 根据 query 做当前 demo 的文本检索

Query 参数：
- `query: string`
- `limit?: number`
- `thinkingRatio?: number`

响应：
- `MemoryResponse`

### 2.2 `GET /api/v1/list`

用途：
- 最近浏览

Query 参数：
- `mode: "recency"`
- `limit?: number`
- `thinkingRatio?: number`

响应：
- `MemoryResponse`

### 2.3 `GET /api/v1/timeline`

用途：
- 以 `memoryId` 为锚点返回前后窗口

Query 参数：
- `memoryId: string`
- `beforeLimit?: number`
- `afterLimit?: number`

响应：
- `MemoryResponse`

### 2.4 `GET /api/v1/detail`

用途：
- 返回单条详情

Query 参数：
- `memoryId: string`

响应：
- `MemoryResponse`

说明：
- `detail` 约定只返回一条 `MemoryHit`

---

## 3. 写入接口（Write）

### 3.1 `POST /api/v1/message/add`

用途：
- 写入一条 turn 数据

请求体：

```ts
export interface Turn {
  agent: string;
  summary?: string;
  details?: string;
  tool_calling?: string[];
  // 工具调用过程中产生的产出物。
  artifacts?: Record<string, string>;
  prompt?: string;
  response?: string;
}

export interface AddTurnRequest {
  turn: Turn;
}
```

响应：

```ts
export interface AddTurnResponse {
  turnId: string;
  requestId: string;
}
```

说明：
- 当前文档统一将这条记录视为 turn，并使用 `turnId` 表达该标识
- `tool_calling` 表示本轮调用过的工具
- `artifacts` 表示工具调用产生的产出物

---

## 4. 当前范围边界

当前 demo 不包含其他 sidecar 写接口。
