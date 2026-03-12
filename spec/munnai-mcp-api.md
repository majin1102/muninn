# Munnai MCP API Spec（Text-First）

本文档定义 Munnai 暴露给 agent 的 MCP tools 语义与输入参数。MCP 输出以 Markdown 文本为主，解释权归服务端所有。

## 1. 核心概念

### 1.1 `memory_id`

MCP 层只暴露 `memory_id: string`，用于定位任意可检索 memory。

约定的 ID 前缀：
- `thinking_...`
- `session_...`
- `message_...`

ID 构成（建议）：
- `thinking_<ULID>`
- `session_<ULID>`
- `message_<ULID>`

其中：
- `<ULID>` 为 26 字符 Crockford Base32（如 `01J...`），要求全局唯一。
- 服务端可选择其他唯一 ID 实现，但必须保持前缀与“可复制/可读”的性质，并保证在一个数据集内无冲突。

服务端通过 `memory_id` 前缀解释该 memory 的维度与渲染方式；MCP 层不暴露 thinking/session/message 的类型字段。

### 1.2 `MemoryHit`（文本）

所有工具输出都渲染为 Markdown 文本。概念上，服务端输出由一个或多个 `MemoryHit` 拼接而成：

- `memory_id`
- `agent`
- `time`（RFC3339）
- `summary`
- `details`

这些字段的呈现格式由服务端决定；允许演进。服务端也可以在文本中包含 `Related memories`（列出其他 memory_id）与 `Next`（可选提示，非强制）。

## 2. 排序与稳定性

- `recall`：相关度排序（服务端可自行决定是否混入 `session_...`，以及混排策略）
- `list`：按 `time`（recency）降序
- `get_timeline`：按时间轴先后顺序（升序）排序
- 稳定性：窗口结果在“底层数据集无新增/更新”的前提下原则上稳定；该稳定性为经验性行为，不作强保证。

## 3. Tools

### 3.1 `_GUIDE`

用途：
- 返回固定的工作流说明文本，指导 agent 使用“渐进式披露”流程。

输入参数：
- 无

输出：
- Markdown 文本

### 3.2 `recall`

用途：
- 面向具体内容的检索入口，返回若干条候选 `MemoryHit`（Markdown 文本拼接）。

输入参数：
- `query: string`（必填）
- `limit?: number`（可选；默认由服务端决定）
- `thinking_ratio?: number`（可选；0..1）
  - 语义：作为服务端的“召回/渲染预算建议”，倾向返回更多 `thinking_...`（接近 1）或更多 `message_...`（接近 0）。
  - 说明：服务端可忽略该建议；`session_...` 的混入与混排不受该值约束；最终返回由服务端根据供给与质量决定。

输出：
- Markdown 文本（包含 0..N 条 MemoryHit）

### 3.3 `list`

用途：
- 列出最近的 memory（recency 浏览），用于无明确 query 的场景。

输入参数：
- `mode: "recency"`（必填；当前仅支持该值）
- `limit?: number`（可选；默认由服务端决定）
- `thinking_ratio?: number`（可选；0..1）
  - 语义：作为服务端的“预算建议”，影响 `thinking_...` 与 `message_...` 的返回占比。
  - 说明：服务端可忽略该建议；`session_...` 的混入不受该值约束；recency 模式下仍以时间排序为准。

输出：
- Markdown 文本（包含 0..N 条 MemoryHit，按 time 降序）

### 3.4 `get_timeline`

用途：
- 返回指定 `memory_id` 的“同维度上下历史信息”，用于做广度扩展（上下文窗口 / 邻近窗口 / 版本窗口）。

输入参数：
- `memory_id: string`（必填）
- `before_limit?: number`（可选；默认由服务端决定）
- `after_limit?: number`（可选；默认由服务端决定）

输出：
- Markdown 文本（包含 0..N 条 MemoryHit，按时间升序）

维度解释（由服务端按 memory_id 前缀决定）：
- `message_...`：同一 session 内的邻近消息窗口
- `session_...`：跨 session 的窗口（锚点时间为该 session 最新消息时间；数据来源为 session 表或服务端派生）
- `thinking_...`：同一 thinking_id 的历史版本窗口（按 last_update）

### 3.5 `get_detail`

用途：
- 返回单个 `memory_id` 的完整细节（渐进式披露的终点）。

输入参数：
- `memory_id: string`（必填）

输出：
- Markdown 文本（单个 MemoryHit）
