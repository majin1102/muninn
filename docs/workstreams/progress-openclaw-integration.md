# OpenClaw 对接工作线 Progress

## 当前状态

- 状态：调研收敛中，MVP hook 面已初步定稿
- 最近更新时间：2026-03-19
- 当前负责人：Codex

## 已确认结论

- 以后统一以上游 `../openclaw` 为准，不再以 `../openclaw-cn` 的旧实现作为事实基线。
- OpenClaw 当前对 Muninn 的 MVP 接入面，先只关注三个 hook：
  - `before_model_resolve`
  - `agent_end`
  - `after_tool_call`
- `message_sent` 对 Muninn MVP 不是必需项，当前不作为接入范围。
- `tool_result_persist` 已理解其语义，但当前阶段先不纳入 MVP 主链路。
- OpenClaw 的稳定逻辑会话锚点应使用 `sessionKey`，不是物理 transcript `sessionId`。
- 对 Muninn 而言，当前可采用：
  - `muninn.session.session_id = openclaw.sessionKey`
- 这个 `session.session_id` 语义上是逻辑会话归属，不是 OpenClaw 当前 transcript 文件 id。
- 在上游 `openclaw` 里，`before_tool_call` / `after_tool_call` 的上下文已经会透传：
  - `agentId`
  - `sessionKey`
  - `sessionId`
  - `runId`
  - `toolCallId`
- `after_tool_call` 的 `event.result` 是 `sanitizedResult`，不是更早期的 provider 原始包，但已经是 OpenClaw 认可过的统一执行结果。
- 如果目标是把完整信息交给 Muninn，再由 format 层去处理噪音，那么 OpenClaw hook 这一层应以“高保真采集”为主，不应过早做裁剪或价值判断。
- 对于启动输入采集，当前应优先使用 `before_model_resolve.prompt`：
  - 它是本轮的 user prompt
  - 这个阶段还没有 session messages 混入
  - 比 legacy `before_agent_start` 更符合长期稳定接入面
- artifact 采集策略已确认：
  - `write`：直接从 `after_tool_call.params.content` 获取正文
  - `edit`：从 `after_tool_call.params.path` 识别目标文件，再主动回读完整文件正文
  - `apply_patch`：提取受影响路径后，再主动回读完整文件正文
  - `exec`：仅在输出中能明确识别 artifact 路径时，再按路径回读文件
- artifact key 策略已确认：
  - `artifacts` 的 key 统一使用工具指令的目标路径
  - 仅在目标路径能被明确解析时才写入 `artifacts`
  - `exec` 默认不产出 artifact，除非输出中能明确识别文件路径
- hook 到当前 Muninn 写入契约的映射原则已确认：
  - 写入粒度采用“每个 hook 各写一条 `session/messages`”
  - OpenClaw MVP 不写 `extra`
  - OpenClaw MVP 不使用 `details`
  - `summary` 属于 Muninn 的派生字段，不是 OpenClaw hook 的输入责任
  - 缺少 `summary` 不应阻止 `prompt` / `tool_calling` / `artifacts` / `response` 的原始写入
- 因此，对 Muninn 来说：
  - `after_tool_call` 是 artifact 识别入口
  - 文件正文不应只依赖 `after_tool_call.result`
  - 必要时应由 hook 实现补一次文件读取

## 已完成内容

- 已重新核对上游 `openclaw` 中 `after_tool_call` 的实现，确认 `sessionKey` 透传问题在上游已修复。
- 已梳理 `sessionKey` 与 `sessionId` 的语义边界：
  - `sessionKey` = 稳定逻辑会话桶
  - `sessionId` = 当前物理 transcript 实例
- 已对照 `../claude-mem`，确认 Claude Code 宿主提供的是稳定 `session_id`，而 OpenClaw 当前最接近这个角色的是 `sessionKey`。
- 已确认 `write` / `edit` / `read` 等工具参数会先经规范化处理：
  - `file_path -> path`
  - `old_string -> oldText`
  - `new_string -> newText`
- 已确认上游 `apply_patch` 返回的主要是修改摘要，不保证返回文件全文。
- 已确认 `write` / `edit` / `apply_patch` 这类工具不能统一假设 `after_tool_call.result` 一定包含完整 artifact 正文。
- 已确认 artifact 正文采集的 MVP 策略，优先保证保真，再把噪音控制下沉到 Muninn format 层。
- 已确认 `summary` 的所有权属于 Muninn core；OpenClaw hook 只提交原始执行上下文。
- 已确认 OpenClaw MVP 只采集 user prompt，不采集经 prompt-build 后的混合 prompt。

## Hook 到写入映射

- `before_model_resolve`
  - 写一条 `session/messages`
  - `session.session_id = sessionKey`
  - `session.agent = agentId`
  - `before_model_resolve.prompt` 进入 `prompt`
- `after_tool_call`
  - 每次工具调用写一条 `session/messages`
  - `session.session_id = sessionKey`
  - `session.agent = agentId`
  - 完整工具指令字符串进入 `tool_calling`
  - 如能明确识别目标路径，则回读完整文件正文并写入 `artifacts[path]`
  - `write` / `edit` 的目标路径可直接确定
  - `apply_patch` 在能提取受影响路径时写对应 artifact
  - `exec` 仅在输出中能明确识别文件路径时写对应 artifact
  - OpenClaw MVP 不向 `details` 写入非 artifact 文本
  - OpenClaw MVP 不写 `extra`
- `agent_end`
  - 写一条 `session/messages`
  - `session.session_id = sessionKey`
  - `session.agent = agentId`
  - 最终 agent 输出进入 `response`
  - OpenClaw MVP 不写 `extra`

## 当前正在推进

- 将已确认的 artifact 采集策略细化成具体实现规则。
- 收敛 `apply_patch` 和 `exec` 的路径抽取细节。
- 将失败处理收敛到“写失败只打日志，不阻塞主流程”。

## 当前阻塞点

- 当前不再阻塞于总体方案，但仍有两类实现问题需要收口：
  - `apply_patch` 的受影响路径抽取规则如何落地
  - `exec` 的 artifact 路径识别规则如何落地
  - 文件回读失败时 payload 如何降级

## 与其他工作线的依赖

- 依赖记忆蒸馏工作线的点：
- hook 层暂定走高保真采集，噪音裁剪与 observation/session 抽象留给蒸馏/format 层处理。
- 依赖 Muninn Board 工作线的点：
- 暂无直接阻塞依赖。

## 下一步建议

- 下一步优先补齐两个问题：
  - 在 `after_tool_call` 中，分别针对 `apply_patch` / `exec` 细化 artifact 路径抽取规则
  - 在 OpenClaw 侧把失败处理固定为“记录日志并继续主流程”
- MVP 实现阶段不考虑幂等与去重。

## 需要记录的风险

- 若只依赖 `after_tool_call.result`，将无法稳定拿到完整 markdown 或其他文件正文。
- 若 hook 层过早做摘要化，可能会损失后续蒸馏真正需要的原始上下文。
- 如果未来将 `sessionId` 一词同时用于 OpenClaw 物理 transcript id 和 Muninn 逻辑 session anchor，文档和实现都容易混淆，需在接口说明里明确。
- 若继续把 `response` 写入与 `summary` 生成强绑定，会让 OpenClaw hook 层被迫理解 Muninn 内部派生逻辑，破坏职责边界。
