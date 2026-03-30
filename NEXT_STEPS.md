# Munnai 接下来的工作清单

基于 MVP1.md、agents/ 进度文档和当前代码状态，以下是需要完成的工作：

## 1. 核心功能完善

### 1.1 Observer 实现 ✅ 已完成
**状态：** 已实现并运行

**已完成：**
- ✅ `ObservingGateway` (ObservationGenerator)：语义提取和路由
- ✅ `ObservingSession` 管理：snapshot 追加和 child session 派生
- ✅ `ObservedSnapshot` 生成：memories、concepts、openQuestions、nextSteps
- ✅ 7 天活跃窗口机制：`load_runtime()` 中过滤 `updated_at >= now - 7 days`
- ✅ Lance 存储持久化

**代码位置：**
- `core/src/observer/mod.rs` - 核心 Observer 实现
- `core/src/llm/observing.rs` - Gateway 路由逻辑
- `core/src/llm/observing_update.rs` - Observe 生成逻辑

### 1.2 OpenClaw 对接（高优先级）
**状态：** 调研收敛中，MVP hook 面已初步定稿，等待实现

**已确认方案：**（见 `agents/progress-openclaw-integration.md`）
- ✅ Hook 映射已定：`before_model_resolve` → prompt，`after_tool_call` → artifacts，`agent_end` → response
- ✅ Session ID 映射：`munnai.session.session_id = openclaw.sessionKey`
- ✅ Artifact 采集策略已确认：write/edit 直接读，apply_patch/exec 按需回读

**需要做的：**
- [ ] 在 OpenClaw 中实现 3 个 hook 的 Munnai 写入逻辑
- [ ] 实现 artifact 路径抽取和文件回读（apply_patch/exec）
- [ ] 实现失败降级：写失败只打日志，不阻塞主流程
- [ ] 端到端验证：OpenClaw 真实执行 → Munnai 写入 → Observer 生成 observation

**产品价值：** 验证 Munnai 能真正嵌入 agent 的实际工作流

**当前阻塞点：**
- `apply_patch` 的受影响路径抽取规则如何落地
- `exec` 的 artifact 路径识别规则如何落地
- 文件回读失败时 payload 如何降级

### 1.3 记忆输出到 OpenClaw LanceDB（高优先级）
**状态：** 未开始

**需要做的：**
- [ ] 明确 Munnai observation 到 OpenClaw LanceDB schema 的映射规则
- [ ] 实现 observation → OpenClaw LanceDB 的蒸馏输出
- [ ] 验证 OpenClaw 可以召回 Munnai 产出的精炼记忆
- [ ] 对比测试：Munnai vs OpenClaw 自带 LanceDB plugin 的召回准确性和 token 消耗

**产品价值：** 这是 MVP1 的主召回路径，证明 Munnai 产出的记忆可以被 OpenClaw 直接使用

### 1.4 Munnai Board 前端收尾（中优先级）
**状态：** 基础功能已完成，缺少品牌元素

**需要做的：**
- [ ] 设计并添加 Munnai logo
- [ ] 视觉细节优化：配色、间距、字体等
- [ ] 交互细节优化：加载状态、错误提示、空状态等
- [ ] 验证 observation 视图能正确展示精炼后的记忆结构

**产品价值：** 让人可以检查 Munnai 生成的记忆是否有价值

## 2. 记忆蒸馏优化（进行中）

**状态：** 已完成 turn 双路径蒸馏，进入质量优化阶段（见 `agents/progress-memory-distillation.md`）

**已完成：**
- ✅ Turn 双路径蒸馏：短 turn 用 direct summary，长 turn 用 full LLM
- ✅ Title-only 生成逻辑
- ✅ Fixture-based 评测模块

**当前正在推进：**
- [ ] Agent 段后处理压缩（`normalize_agent_source`）
- [ ] 用真实 OpenClaw 输入做批量评测

**下一步：**
- 停止细抠 prompt，把当前实现作为 v1
- 用真实 OpenClaw 输入验证 direct summary gate 是否合理
- 在 benchmark 中证明新方案比默认全量 LLM summary 更稳或更省 token

## 3. 技术债务

### 3.1 Rust 核心路径问题（低优先级）
**问题：** `packages/core/src/client.ts` 中硬编码了 Rust 路径查找逻辑

**需要做的：**
- [ ] 检查 `resolveRepoRoot()` 和 `resolveManifestPath()` 是否正确指向 `core/Cargo.toml`
- [ ] 确保 `MUNNAI_PATH` 环境变量正确传递
- [ ] 添加错误处理：Rust daemon 启动失败时的友好提示

### 3.2 Memory Layer 命名（已统一）
**状态：** ✅ 已统一为 `OBSERVING`，文档已更新

## 4. 测试与验证

### 4.1 端到端测试（高优先级）
**需要做的：**
- [ ] 编写 OpenClaw + Munnai 的集成测试
- [ ] 验证完整闭环：OpenClaw 执行 → Munnai 写入 → Observer 生成 observation → 召回验证
- [ ] 性能测试：对比 Munnai vs OpenClaw 自带 LanceDB plugin 的召回质量和 token 消耗

### 4.2 单元测试补充（中优先级）
**状态：** Observer 相关测试已存在（`core/src/observer/tests.rs`）

**需要做的：**
- [ ] 补充 direct-summary path 的集成测试
- [ ] 验证 short turn 经 `Session::add_message -> TurnGenerator -> dataset merge` 后能以 direct summary 路径正确写入

## 5. 文档完善

### 5.1 部署文档（中优先级）
**需要做的：**
- [ ] 编写 Munnai Sidecar 的启动文档
- [ ] 编写 OpenClaw 对接指南
- [ ] 编写 Munnai Board 的访问说明

### 5.2 API 示例（低优先级）
**需要做的：**
- [ ] 为 `POST /api/v1/session/messages` 添加完整示例
- [ ] 为 MCP tools 添加使用示例

## 6. MVP1 验收标准检查清单

根据 `MVP1.md` 的验收标准，需要确保：

- [ ] OpenClaw 能在真实执行过程中持续把上下文写入 Munnai
- [x] Munnai 能把这些上下文整理成 session 记忆（已实现）
- [x] Munnai 能从 session 中蒸馏出 observation 记忆（Observer 已实现）
- [ ] Munnai 能产出可被 OpenClaw 直接召回的精炼记忆（需要实现输出到 OpenClaw LanceDB）
- [x] 人可以通过 Munnai Board 查看 session 和 observation（基础功能已完成）
- [ ] Munnai Board 的基础前端已经足够支撑上述查看与人工校验流程（缺 logo 和视觉收尾）
- [ ] 相比 OpenClaw 自带的 LanceDB plugin，Munnai 产出的记忆在 benchmark 中具备更高的召回准确性
- [ ] 相比 OpenClaw 自带的 LanceDB plugin，Munnai 在达到相近或更好效果时具备更优的 token 消耗表现

## 优先级建议

**立即开始（本周）：**
1. ✅ ~~Observer 实现~~ 已完成
2. **OpenClaw hook 实现**（3 个 hook 的写入逻辑 + artifact 采集）
3. **Munnai 到 OpenClaw LanceDB 的记忆输出**

**下周：**
4. 端到端测试和 benchmark
5. Munnai Board logo 和视觉收尾

**后续：**
6. 文档完善

## 当前关键路径

**MVP1 的关键路径现在是：**

1. **OpenClaw 写入对接**（agents/progress-openclaw-integration.md）
   - 在 OpenClaw 中实现 3 个 hook 的 Munnai 写入
   - 解决 artifact 路径抽取问题

2. **记忆输出到 OpenClaw**
   - 实现 Munnai observation → OpenClaw LanceDB 的蒸馏输出
   - 这是 MVP1 的主召回路径

3. **端到端验证**
   - 验证完整闭环可用
   - Benchmark 对比测试

## 当前阻塞点

**OpenClaw 对接的实现细节：**
- `apply_patch` 的受影响路径抽取规则
- `exec` 的 artifact 路径识别规则
- 文件回读失败时的降级策略

**记忆输出：**
- 需要明确 Munnai observation 到 OpenClaw LanceDB schema 的映射规则
