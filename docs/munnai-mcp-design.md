# Munnai MCP 接口与服务设计（参考 claude-mem 设计）

本文档描述 Munnai 的 MCP（Model Context Protocol）接口与服务端架构设计。MCP 层采用 text-first：工具输出以 Markdown 文本为主，解释权归服务端所有；对 agent 仅暴露统一的 `memory_id`。

当前规范以 spec 文档为准：
- MCP API（tools 语义/参数/排序）：[spec/munnai-mcp-api.md](file:///Users/Nathan/workspace/claude-mem/docs/spec/munnai-mcp-api.md)
- Format Schema（IDs/实体/关系）：[spec/munnai-format-schema.md](file:///Users/Nathan/workspace/claude-mem/docs/spec/munnai-format-schema.md)
- claude-mem MCP 设计风格：薄 MCP Server + HTTP sidecar API（thin wrapper）

---

## 1. 设计目标

- **跨 agent 互操作**：所有 agent 只要会 MCP，就能读到同一种 memory 结构。
- **渐进式披露**：先返回轻量索引（多个 MemoryHit 的 Markdown 渲染），再按需展开同维度上下文（get_timeline）与单条详情（get_detail）。
- **薄 MCP 层**：MCP Server 只做协议与 tool schema，不承载业务逻辑；业务逻辑下沉到 HTTP sidecar service。
- **列裁剪友好**：sidecar 内部按“轻字段优先”查询 Lance/Arrow 表，减少 IO 与 token 占用。

---

## 2. 总体架构

```
Agent (Claude / OpenAI / Custom)
  │
  │  MCP stdio (tools/list + tools/call)
  ▼
Munnai MCP Server (thin wrapper)
  │  (不存状态；不做业务逻辑)
  │
  │  HTTP (localhost / remote)
  ▼
Munnai HTTP Sidecar Service (HTTP API)
  │
  │  Lance Dataset (Arrow Schema)
  ▼
thinking + message + session datasets
```

### 2.1 组件职责

- **MCP Server**
  - 提供 `tools/list`（工具定义与描述）
  - 处理 `tools/call`（参数校验/标准化/错误包装）
  - 转发请求到 sidecar 的 HTTP API
- **HTTP Sidecar Service**
  - 读取 Lance 表（支持列裁剪、过滤、ANN 检索）
  - 实现渐进式披露工作流（Index → Expand）
  - 统一返回 MCP 友好的文本/结构化输出

---

## 3. 工具设计：对标 claude-mem 的 3 层工作流（强约束）

Munnai 的检索工具对标 claude-mem 的使用习惯与命名风格，仍然保持 3 层强约束（类似 claude-mem 的 `__IMPORTANT` 提示工具；Munnai 侧命名为 `_GUIDE`）：

1. **search(query)**：返回 Markdown 文本（多个 MemoryHit），按相关度排序。
2. **get_timeline(memory_id, before_limit, after_limit)**：返回 Markdown 文本（多个 MemoryHit），用于“同维度上下历史/上下文窗口”，按时间轴升序排序。
3. **get_detail(memory_id)**：返回 Markdown 文本（单个 MemoryHit），作为下钻终点。

补充：
- **list(mode=recency)**：返回 Markdown 文本（多个 MemoryHit），用于“无明确 query 的最近浏览”，按 time 降序排序。

可选补充：
- **help(operation)**：输出完整用法（减少 tool 列表 description 的 token）

---

## 4. MCP Tools（现行）

本项目的 MCP tools 以 spec 为唯一规范来源：
- [spec/munnai-mcp-api.md](file:///Users/Nathan/workspace/claude-mem/docs/spec/munnai-mcp-api.md)

工具集合：

- `_GUIDE`：工作流说明文本
- `search(query, limit?, thinking_ratio?)`：相关度排序的索引检索，输出 Markdown（多个 MemoryHit）
- `list(mode="recency", limit?, thinking_ratio?)`：最近浏览，输出 Markdown（多个 MemoryHit，按 time 降序）
- `get_timeline(memory_id, before_limit?, after_limit?)`：同维度窗口/历史，输出 Markdown（多个 MemoryHit，按时间轴升序）
- `get_detail(memory_id)`：单条下钻详情，输出 Markdown（单个 MemoryHit）

输出约定（简要）：
- MCP tool 返回值统一为 `{ content: [{ type: "text", text: "<markdown>" }] }`
- `memory_id` 为 `thinking_<ULID>` / `session_<ULID>` / `message_<ULID>`（服务端按前缀解释维度）

---

## 5. Sidecar 与存储（现行）

MCP Server 是薄层，负责：
- tool schema 与 stdio JSON-RPC
- 将 `tools/call` 转发给 sidecar（业务逻辑在 sidecar）

sidecar 负责（与 spec 对齐）：
- 按 `memory_id` 前缀路由到 `thinking/session/message` 三张表
- 按工具语义与排序规则渲染 Markdown（MemoryHit/数组）
- 列裁剪与 token 预算控制（避免返回大字段）
- 向量召回（可选；例如基于 Lance/Arrow）

数据格式与表结构以 [spec/munnai-format-schema.md](file:///Users/Nathan/workspace/claude-mem/docs/spec/munnai-format-schema.md) 为准。

---

## 6. 输出渲染（现行）

输出以 Markdown 为主（text-first）。服务端渲染建议包含（允许演进）：
- `memory_id`
- `agent`
- `time`（RFC3339）
- `summary`
- `details`

并可选包含：
- `Related memories`（其他 `memory_id` 列表）
- `Next`（非强制提示；建议用于 search/get_timeline）

---

## 7. 错误处理与可靠性（现行）

- MCP Server 所有日志写 stderr，避免破坏 stdio JSON-RPC 输出。
- sidecar 不可用时，MCP 返回 `isError: true` 的文本消息。
- 参数缺失/格式错误（如 `memory_id` 前缀不合法或 ULID 不匹配）在 MCP 层快速报错。

---

## 8. thinking_ratio（现行）

在 text-first 输出下，`thinking_ratio` 仍可作为服务端“召回/渲染预算建议”：
- 倾向更多 `thinking_...`（接近 1）或更多 `message_...`（接近 0）
- `session_...` 的混入与混排不受该值约束
- 服务端可忽略该建议；最终返回由供给与质量决定
