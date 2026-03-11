# Munnai vs claude-mem（概览对比）

本文件用于给读者一个“概览级对比”，帮助理解 Munnai 的定位与 claude-mem 的差异。两者都主张渐进式披露：先返回轻量索引，再按需展开上下文与详情。

参考（Munnai 现行规范）：
- MCP API：[spec/munnai-mcp-api.md](file:///Users/Nathan/workspace/claude-mem/docs/spec/munnai-mcp-api.md)
- Format Schema：[spec/munnai-format-schema.md](file:///Users/Nathan/workspace/claude-mem/docs/spec/munnai-format-schema.md)

## 一句话总结

- claude-mem：更偏“本地可用的产品化记忆系统”，强调可复现的 timeline 体验与强约束下钻工作流。
- Munnai：更偏“可互操作的格式 + 服务”，强调统一 `memory_id` 与 text-first MCP（Markdown 渲染）。

## 数据与接口粒度

| 维度 | claude-mem | Munnai |
|---|---|---|
| 基本记录粒度 | observation / session summary | thinking / session / message |
| MCP 输出形态 | text 为主 | Markdown（MemoryHit/数组），解释权归服务端 |
| 导航键 | 各工具自带 ids | 统一 `memory_id`（`thinking_`/`session_`/`message_` + ULID） |

