# Munnai Board 工作线 Progress

## 当前状态

- 状态：已启动，正在搭建独立页面承载位与 MVP 信息架构
- 最近更新时间：2026-03-20
- 当前负责人：Codex

## 已确认结论

- Munnai Board 应单独承载在 `packages/board`，不应塞入 `mcp`
- 当前阶段先做只读查看器，不做编辑器
- 当前后端只具备 session 读链路，observation 视图需要先占位再等上游接入
- 现有 sidecar read payload 偏 LLM 注入，后续可能需要补 UI-friendly read model

## 已完成内容

- 读取 brief 并完成当前仓库扫描
- 确认当前仓库没有现成前端应用壳
- 新建 `packages/board` 作为独立页面承载模块
- 落一版静态页面骨架，用样例数据承载 session / observation / gaps 三栏结构

## 当前正在推进

- 站稳 Munnai Board 的最小页面结构
- 为后续接 sidecar 真实数据预留页面入口和模块边界

## 当前阻塞点

- observation 目前没有正式读接口和稳定数据合同
- session 与 observation 的关系视图还缺上游真实产物
- 当前 sidecar 返回 `MemoryHit.content` Markdown，更适合 LLM，不够适合 UI 字段级展示

## 与其他工作线的依赖

- 依赖 OpenClaw 对接工作线的点：
- 真实 session 数据接入后需要验证页面展示是否足够清晰
- 依赖记忆蒸馏工作线的点：
- observation 读模型、source session 关系和蒸馏结果形态需要上游给出

## 下一步建议

- 明确 Munnai Board 的 MVP 页面清单与导航
- 决定真实数据接入时是继续消费 `MemoryHit`，还是单独补 UI-oriented read API
- 在 observation 数据到位前，先完成 session 列表 / 详情页的真实接线

## 需要记录的风险

- 如果继续直接消费 Markdown `MemoryHit`，页面会很快遇到结构化展示瓶颈
- 如果 observation 工作线延迟，Munnai Board 很容易长期停留在 session-only viewer
