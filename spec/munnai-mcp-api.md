# Munnai MCP API Spec（当前 Demo 对齐版）

本文档定义当前 Munnai 暴露给 agent 的 MCP tools 语义与输入参数。文档仍然保留 spec 的组织方式，但以当前 demo 的接口为准。

## 1. 核心概念

### 1.1 `memoryId`

MCP 层当前通过 `memoryId: string` 读取 memory。

当前 demo 下：
- `memoryId` 是 read-side 的统一读取键
- `get_detail` 与 `get_timeline` 都以它为输入
- 当前 demo 的持久化重点仍然是 turn 数据

### 1.2 `MemoryHit`

所有读接口最终都收敛为：

```ts
export interface MemoryHit {
  memoryId: string;
  content: string;
}
```

其中：
- `content` 为 Markdown 文本
- `MemoryHit[]` 是 sidecar 与 MCP 之间的统一读结果载体

## 2. 排序与稳定性（当前）

- `recall`：当前 demo 为简单文本匹配，按当前实现规则返回
- `list`：按时间倒序返回最近结果
- `get_timeline`：按锚点前后窗口返回结果
- `get_detail`：返回单条结果

## 3. Tools

### 3.1 `print`

用途：
- 本地调试
- 打印参数并生成 Markdown 调试文件

输入参数：
- `message?: string`
- `data?: unknown`

### 3.2 `recall`

输入参数：
- `query: string`
- `limit?: number`
- `thinkingRatio?: number`

输出：
- MCP 文本结果，底层来源于 `MemoryResponse`

### 3.3 `list`

输入参数：
- `mode: "recency"`
- `limit?: number`
- `thinkingRatio?: number`

输出：
- MCP 文本结果，底层来源于 `MemoryResponse`

### 3.4 `get_timeline`

输入参数：
- `memoryId: string`
- `beforeLimit?: number`
- `afterLimit?: number`

输出：
- MCP 文本结果，底层来源于 `MemoryResponse`

### 3.5 `get_detail`

输入参数：
- `memoryId: string`

输出：
- MCP 文本结果，底层来源于 `MemoryResponse`

## 4. 当前对应的共享响应类型

```ts
export interface MemoryResponse {
  memoryHits: MemoryHit[];
  requestId: string;
}
```
