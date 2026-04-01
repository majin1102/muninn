# Muninn vs claude-mem（MCP 工作流对比）

本文件只对比两者暴露给 agent 的 MCP 工具工作流与“渐进式披露”策略，不展开存储实现细节。

参考（Muninn 当前规范）：
- [spec/muninn-mcp-api.md](/Users/Nathan/Documents/Playground/muninn/spec/muninn-mcp-api.md)
- [spec/muninn-format-schema.md](/Users/Nathan/Documents/Playground/muninn/spec/muninn-format-schema.md)

## 工作流对比（高层）

| Step | claude-mem（工具） | Muninn（工具） | 差异要点 |
|---|---|---|---|
| 0 | `__IMPORTANT` | `print` | 当前 demo 里 `print` 主要承担本地调试入口 |
| 1 | `search(query, ...)` | `recall(query, limit?, thinkingRatio?)` | 都是检索入口；Muninn 当前通过 session-backed `MemoryHit[]` 返回 text-first 内容 |
| 2 | `timeline(anchor, ...)` | `get_timeline(memoryId, beforeLimit?, afterLimit?)` | 都用于上下文窗口；Muninn 当前使用统一 `memoryId` |
| 3 | `get_observations(ids...)` | `get_detail(memoryId)` | 都用于单条下钻；Muninn 返回单条 `MemoryHit` 的 `MemoryResponse` |
| + | （无） | `list(mode="recency", limit?, thinkingRatio?)` | Muninn 提供 recency 浏览入口，选择最近窗口但按旧到新返回 |

## 关键设计差异

- **输出形态**：claude-mem 与 Muninn 都偏 text-first；Muninn 明确把输出定义为 Markdown（MemoryHit/数组），解释权归服务端。
- **统一定位键**：Muninn 当前通过 `memoryId` 做统一读取导航。
- **广度/深度**：
  - 广度：`get_timeline`（before/after 指定方向展开）
  - 深度：`get_detail`（单条终点下钻）
