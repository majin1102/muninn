# Munnai Format Schema Spec（Iceberg/Lance 风格）

本文档描述 Munnai 的数据格式（format）与 schema 约定，用于支撑 text-first MCP（Markdown 渲染）与 `memory_id` 单入口。本文档只描述格式与语义，不约束具体存储实现（Iceberg/Lance/SQLite/其他）。

## 1. 概览

Munnai 以三张主表表达 memory：

- `message`：事实/过程（每行是一条 message 记录），支撑 `get_timeline(message_...)` 与 `get_detail(message_...)`
- `session`：会话/线程元信息（每行一个 session），支撑 `get_detail(session_...)`
- `thinking`：结论/推理笔记的版本序列（每行一个版本条目），支撑 `get_timeline(thinking_...)` 与 `get_detail(thinking_...)`

## 2. IDs 与 `memory_id`

格式层存在三类 ID，均为字符串，建议全局唯一，并可直接作为 MCP 的 `memory_id`：

- `thinking_id`: `thinking_<ULID>`
- `session_id`: `session_<ULID>`
- `message_id`: `message_<ULID>`

其中：
- `<ULID>` 为 26 字符 Crockford Base32（如 `01J...`），要求全局唯一。
- MCP 层只暴露 `memory_id`（字符串），其值等于上述三类 ID 之一；服务端通过前缀解释维度与渲染方式。

## 3. Dataset 总览（表级视图）

| dataset | 粒度 | 主键（推荐） | 时间列 | 稳定排序键（推荐） | 主要用途 |
|---|---|---|---|---|---|
| message | 单条 message 记录 | message_id | time | (session_id, time, message_id) | recall/list/get_timeline(message)/get_detail(message) |
| session | 单个 session 元信息 | session_id | updated_at | (updated_at, session_id) | get_detail(session) |
| thinking | 同一 thinking 的版本条目 | (thinking_id, last_update) | last_update | (thinking_id, last_update) | recall/list/get_timeline(thinking)/get_detail(thinking) |

说明：
- `message.time`：消息发生时间（RFC3339）。
- `thinking.last_update`：该 thinking 版本的更新时间（RFC3339），用于同一 thinking_id 的版本时间线。

## 4. Schema：message

### 4.1 字段表

| field | type | required | description | example |
|---|---|---:|---|---|
| message_id | string | yes | 全局唯一消息 ID（`message_<ULID>`） | message_01J... |
| session_id | string | yes | 所属 session ID（`session_<ULID>`） | session_01J... |
| time | string | yes | RFC3339 时间戳 | 2026-03-09T10:10:00Z |
| agent | string | yes | 生产者/执行者（谁写入这条 message） | claude-code/sonnet |
| summary | string | yes | 短摘要，用于检索与列表 | 实现审计日志 CSV 导出… |
| details | string | no | 可选长文本（可为 Markdown） | 详细说明… |
| trace | object | no | 工具调用轨迹（opaque JSON；由实现决定结构） | {"tool":"Read","result":"ok"} |
| artifacts | array | no | 产物列表（opaque JSON；由实现决定结构） | [{"name":"docs/x.md"}] |
| prompt | string | no | 可选原始 prompt（由 policy 决定是否记录） | null |
| response | string | no | 可选原始 response（由 policy 决定是否记录） | null |
| policy_name | string | no | 写入策略名（脱敏/截断/是否记录等） | default |
| embedding_summary | array<number> | no | 摘要向量（可选；用于向量召回） | [0.01, 0.02] |

### 4.1.1 `details` / `trace` / `artifacts`（内容案例）

`details` 建议为可读的 Markdown 文本，表达这条 message 的关键上下文；`trace`/`artifacts` 保持结构化（JSON），用于工程化复现与审计。

示例（details）：

```md
实现审计日志 CSV 导出接口，并补充最小可用测试覆盖。

- 新增 GET /api/audit/export（管理员权限）
- 支持空结果集与分页导出
- 导出操作写入审计日志
```

示例（trace）：

```json
[
  { "tool": "Read", "target": "docs/audit-export-requirements.md", "result": "ok" },
  { "tool": "Edit", "target": "src/api/routes/audit.ts", "result": "ok" },
  { "tool": "Bash", "command": "npm test", "result": "ok" }
]
```

示例（artifacts）：

```json
[
  {
    "name": "docs/audit-export-implementation.md",
    "produced": true,
    "mime_type": "text/markdown",
    "content": "# 审计日志导出实现\n\n## 路由\n- GET /api/audit/export\n\n## 权限\n- 仅管理员可导出\n"
  },
  {
    "name": "reports/export-sample.csv",
    "produced": true,
    "mime_type": "text/csv",
    "content": "id,actor,action,ts\n1,admin,export_audit,2026-03-09T10:10:00Z\n"
  }
]
```

### 4.2 Demo（示例行）

```json
{
  "message_id": "message_01J9Z3K8D2B2FQ2QFJQ8C3VQ8S",
  "session_id": "session_01J9Z3JZJ1QY3WJ4R5Z7E6H1K2",
  "time": "2026-03-09T10:10:00Z",
  "agent": "claude-code/sonnet",
  "summary": "实现审计日志 CSV 导出：新增路由与测试…",
  "details": "实现审计日志 CSV 导出接口，并补充最小可用测试覆盖。\n\n- 新增 GET /api/audit/export（管理员权限）\n- 支持空结果集与分页导出\n- 导出操作写入审计日志\n",
  "trace": [
    { "tool": "Read", "target": "docs/audit-export-requirements.md", "result": "ok" },
    { "tool": "Edit", "target": "src/api/routes/audit.ts", "result": "ok" },
    { "tool": "Bash", "command": "npm test", "result": "ok" }
  ],
  "artifacts": [
    {
      "name": "docs/audit-export-implementation.md",
      "produced": true,
      "mime_type": "text/markdown",
      "content": "# 审计日志导出实现\n\n## 路由\n- GET /api/audit/export\n\n## 权限\n- 仅管理员可导出\n"
    }
  ],
  "policy_name": "default"
}
```

## 5. Schema：session

### 5.1 字段表

| field | type | required | description | example |
|---|---|---:|---|---|
| session_id | string | yes | 全局唯一 session ID（`session_<ULID>`） | session_01J... |
| updated_at | string | yes | RFC3339；该 session 的最后活跃时间（建议等于最新 message.time） | 2026-03-09T11:30:00Z |
| agent | string | yes | session 元信息的生产者 | munnai/session-manager |
| summary | string | yes | session 的短描述/标签 | 审计日志导出实现与回归 |
| details | string | no | 可选长描述（可为 Markdown） | … |
| policy_name | string | no | 写入策略名 | default |

### 5.2 Demo（示例行）

```json
{
  "session_id": "session_01J9Z3JZJ1QY3WJ4R5Z7E6H1K2",
  "updated_at": "2026-03-09T11:30:00Z",
  "agent": "munnai/session-manager",
  "summary": "审计日志导出实现与回归",
  "details": null,
  "policy_name": "default"
}
```

## 6. Schema：thinking

### 6.1 字段表

| field | type | required | description | example |
|---|---|---:|---|---|
| thinking_id | string | yes | thinking 的全局唯一 ID（`thinking_<ULID>`） | thinking_01J... |
| last_update | string | yes | RFC3339；该版本更新时间 | 2026-03-09T11:40:00Z |
| agent | string | yes | 生成/更新该版本的生产者 | munnai/thinking-generator |
| summary | string | yes | 短摘要 | 导出接口权限边界：仅管理员可导出… |
| notes | string | yes | 推理笔记/结论展开（可为 Markdown） | … |
| related_memory_ids | array<string> | no | 关联 memory 的 `memory_id` 列表（可混合维度） | ["message_...","session_..."] |
| policy_name | string | no | 写入策略名 | default |
| embedding_content | array<number> | no | 内容向量（可选；用于向量召回） | [0.01, 0.02] |

### 6.2 Demo（示例行）

```json
{
  "thinking_id": "thinking_01J9Z3T2S0EJ3W1Z7Q2B8K9A1C",
  "last_update": "2026-03-09T11:40:00Z",
  "agent": "munnai/thinking-generator",
  "summary": "导出接口权限边界：仅管理员可导出…",
  "notes": "当需要导出大结果集时，推荐使用后台任务 + 分页拉取 + 审计记录…",
  "related_memory_ids": [
    "message_01J9Z3K8D2B2FQ2QFJQ8C3VQ8S",
    "session_01J9Z3JZJ1QY3WJ4R5Z7E6H1K2"
  ],
  "policy_name": "default"
}
```

## 7. 关系与导航

- Message 属于 Session：`message.session_id → session.session_id`
- Thinking 关联其他 memories：`thinking.related_memory_ids` 允许混合维度（thinking/session/message）
- MCP 层不暴露类型字段；服务端通过 `thinking_`/`session_`/`message_` 前缀完成路由

## 8. Schema 演进与兼容性（Iceberg 风格）

兼容性原则（建议）：

- 新增字段：
  - 新增 optional 字段：向后兼容
  - 新增 required 字段：通常为破坏性变更（除非提供默认填充策略）
- 重命名字段：破坏性变更（建议通过“新增新字段 + 保留旧字段一段时间”迁移）
- 删除字段：破坏性变更（建议先标记 deprecated）
- 类型变更：通常为破坏性变更（除非是安全的扩展，如 int → long）

不可变约束（建议）：
- `*_id` 一旦写入不可更改
- `time/last_update` 一旦写入不可更改（如需修正时间，应新增修正字段而非覆盖）

## 9. Lance/Arrow 落地建议（非强制）

- required/optional 对应 Arrow 字段的 nullability（required=non-nullable，optional=nullable）。
- embedding 向量：
  - 建议使用 `list<float32>` 或 fixed-size list（依实现而定）
  - 模型名/维度等信息建议放在字段级 metadata（而不是每行重复）
