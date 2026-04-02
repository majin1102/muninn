# 记忆蒸馏工作线 Progress

## 当前状态

- 状态：进行中
- 最近更新时间：2026-03-22
- 当前负责人：Codex

## 已确认结论

- `turn` 级别的记忆蒸馏不应该默认让 LLM 同时重写 `title + summary`
- 对短且结构清晰的 turn，`summary` 应优先保真直出，避免二次改写造成事实、偏好、约束和 next step 丢失
- `title` 和 `summary` 的职责需要解耦：`title` 负责检索抽象，`summary` 负责记忆保真
- 对长、散、过程化明显的 turn，才应走完整 LLM 蒸馏路径

## 已完成内容

- 已完成 `turn` prompt 从单一 `title + summary` 路径向两阶段路径的收敛
- 已落地 `turn` 生成双路径：
  - 短 turn：direct summary + title-only LLM
  - 长 / 过程化 turn：full LLM title + summary
- 已新增 `turn_title.yaml`，并在 `core/src/llm/prompts.rs` 中补齐 title-only prompt loader
- 已在 `core/src/llm/turn.rs` 中加入 summary gate、direct summary builder、title-only 生成逻辑
- 已补齐相关 mock 兼容、单测和 fixture
- 已构建 `turn` 评测模块，并能对真实 provider 输出跑 fixture-based live evaluation
- 已通过多轮 live 对比，确认当前主要剩余问题不再是 User 约束丢失或 Agent next step 丢失，而是 Agent 段仍偏长

## 当前正在推进

- 把 `direct summary` 路径进一步做稳，尤其是 `Agent` 段的后处理压缩
- 观察新双路径方案在真实 fixture 下的质量表现，确认短 turn 是否已明显减少不必要的 LLM 改写
- 记录一个 `turn` 侧 backlog：补一条 direct-summary path 的集成测试，显式验证 short turn 经 `Session::add_message -> TurnGenerator -> dataset merge` 后能以 direct summary 路径正确写入 title 与 summary

## 当前阻塞点

- 没有功能级阻塞；当前主要是质量优化进入边际收益区间
- 继续只靠 prompt 微调，收益已经明显下降，后续更可能要靠 direct summary 的规则后处理进一步收紧

## 与其他工作线的依赖

- 依赖 OpenClaw 对接工作线的点：
  - 需要后续用真实 OpenClaw 对话样本继续验证 direct-summary gate 是否合理
  - 需要在 benchmark 中证明新方案比默认全量 LLM summary 更稳或更省 token
- 依赖 Muninn Board 工作线的点：
  - 后续 UI 如果允许人工查看或编辑 turn summary，需要确认 direct summary 与 full summary 的展示差异是否可接受

## 下一步建议

- 先停止继续细抠 prompt 文案，把当前实现作为 `v1`
- 下一步优先把 `core/src/llm/turn.rs` 中的 `normalize_agent_source(...)` 和相关后处理再压一轮
- 再下一步用真实 OpenClaw 输入做批量评测，观察 direct summary 命中比例、token 节省和 recall 质量

## 需要记录的风险

- direct summary 虽然保真更好，但如果 `Agent` 段后处理不够强，仍可能在 recall 里显得偏长
- title-only prompt 目前仍复用 `LlmTask::Turn` 配置，后续如果要更精细控制 provider / model，可能需要独立任务配置
- 当前规则评测已经足够做工程闸门，但对“语义是否真的更好”的判断仍有限，后续最好引入 LLM judge 作为内容质量补充
