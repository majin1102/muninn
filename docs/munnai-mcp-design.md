# Munnai MCP 接口与服务设计（当前 Demo 对齐版）

本文档描述当前仓库中 Munnai 的 MCP（Model Context Protocol）接口与服务端架构设计。本文档延续原有的设计文档组织方式，但以当前 TS/JS demo 的真实接口与数据结构为准。

当前规范以仓库内文档为准：
- MCP API：[spec/munnai-mcp-api.md](/Users/Nathan/workspace/munnai/spec/munnai-mcp-api.md)
- Format Schema：[spec/munnai-format-schema.md](/Users/Nathan/workspace/munnai/spec/munnai-format-schema.md)
- Sidecar HTTP API：[docs/sidecar-http-api.md](/Users/Nathan/workspace/munnai/docs/sidecar-http-api.md)

---

## 1. 设计目标

- **跨 agent 可接入**：MCP 层通过统一的读接口暴露 memory 查询能力。
- **text-first**：读取结果统一收敛到 `MemoryHit[]`，每个 `MemoryHit.content` 为 Markdown 文本。
- **薄 MCP 层**：MCP Server 负责 stdio MCP 协议、tool schema 和 sidecar 调用，不承载复杂业务状态。
- **可调试**：保留 `print` 作为本地调试工具，并额外生成 Markdown 调试文件。

---

## 2. 当前总体架构

```text
Agent
  │
  │  MCP stdio
  ▼
Munnai MCP Server
  │
  │  HTTP
  ▼
Munnai Sidecar
  │
  │  local JSONL storage
  ▼
turn-like message records
```

### 2.1 组件职责

- **MCP Server**
  - 暴露 `print`、`recall`、`list`、`get_timeline`、`get_detail`
  - 参数校验与 sidecar 调用
  - `print` 额外写调试 Markdown
- **Sidecar**
  - 提供 `message/add` 写接口
  - 提供 `recall/list/timeline/detail` 读接口
  - 将已写入的 message-turn 数据渲染为 `MemoryHit`

---

## 3. MCP Tools（当前）

当前 demo 的 MCP tools 集合为：

- `print`
- `recall`
- `list`
- `get_timeline`
- `get_detail`

### 3.1 `print`

用途：
- 本地调试
- 将参数打印到 stderr
- 将参数写入 `.munnai/debug/*.md`

### 3.2 `recall`

输入参数：
- `query: string`
- `limit?: number`
- `thinkingRatio?: number`

### 3.3 `list`

输入参数：
- `mode: "recency"`
- `limit?: number`
- `thinkingRatio?: number`

### 3.4 `get_timeline`

输入参数：
- `memoryId: string`
- `beforeLimit?: number`
- `afterLimit?: number`

### 3.5 `get_detail`

输入参数：
- `memoryId: string`

---

## 4. 输出约定（当前）

当前读接口和 sidecar 返回统一收敛为：

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

说明：
- `recall`、`list`、`get_timeline` 返回 `memoryHits[]`
- `get_detail` 也返回 `MemoryResponse`，但约定 `memoryHits.length === 1`
- `content` 为 Markdown 文本，承担 text-first 的主要输出职责

---

## 5. 写入侧（当前）

当前 demo 只暴露一个正式写接口：

- `POST /api/v1/message/add`

写入 payload 为：

```ts
export interface Message {
  agent: string;
  summary?: string;
  details?: string;
  trace?: string[];
  artifacts?: Record<string, string>;
  prompt?: string;
  response?: string;
}
```

当前 demo 不暴露其他写接口。

---

## 6. 标识约定（当前）

- 读接口统一使用 `memoryId`
- 单条 message-turn 的持久化标识统一记为 `turnId`

---

## 7. 当前非目标

以下内容仍属于后续演进方向，不属于当前 demo 的正式实现：

- session 自动聚合算法
- thinking 写接口
- 向量召回与 embedding 写入
- 复杂存储后端（数据库 / Lance / Arrow）
