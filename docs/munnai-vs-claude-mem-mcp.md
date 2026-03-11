# Munnai vs claude-mem（MCP 工作流对比）

本文件只对比两者暴露给 agent 的 MCP 工具工作流与“渐进式披露”策略，不展开存储实现细节。

参考（Munnai 现行规范）：
- [spec/munnai-mcp-api.md](file:///Users/Nathan/workspace/claude-mem/docs/spec/munnai-mcp-api.md)
- [spec/munnai-format-schema.md](file:///Users/Nathan/workspace/claude-mem/docs/spec/munnai-format-schema.md)

## 工作流对比（高层）

| Step | claude-mem（工具） | Munnai（工具） | 差异要点 |
|---|---|---|---|
| 0 | `__IMPORTANT` | `_GUIDE` | 都用固定文本把“先索引再下钻”的行为写死 |
| 1 | `search(query, ...)` | `search(query, limit?, thinking_ratio?)` | 都是相关度检索；Munnai 输出为服务端渲染的 Markdown（MemoryHit 列表），并统一 `memory_id` |
| 2 | `timeline(anchor, ...)` | `get_timeline(memory_id, before_limit?, after_limit?)` | 都用于上下文窗口；Munnai 的“同维度上下历史”由 `memory_id` 前缀解释 |
| 3 | `get_observations(ids...)` | `get_detail(memory_id)` | claude-mem 批量下钻；Munnai 单条下钻（服务端渲染完整 Markdown） |
| + | （无） | `list(mode="recency", limit?, thinking_ratio?)` | Munnai 额外提供 recency 浏览入口 |

## 关键设计差异

- **输出形态**：claude-mem 与 Munnai 都偏 text-first；Munnai 明确把输出定义为 Markdown（MemoryHit/数组），解释权归服务端。
- **统一定位键**：Munnai 的 MCP 层只暴露 `memory_id`（`thinking_`/`session_`/`message_` + ULID），agent 只需要复制该字段即可导航。
- **广度/深度**：
  - 广度：`get_timeline`（before/after 指定方向展开）
  - 深度：`get_detail`（单条终点下钻）

