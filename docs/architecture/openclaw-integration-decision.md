# OpenClaw 集成方案决策：Hook vs Context Engine

## 背景

Muninn 需要对接 OpenClaw 以捕获 agent 执行上下文。当前有两种集成方式可选：

1. **Hook-based**：OpenClaw memory-lancedb 插件使用的方式
2. **Context Engine**：OpenViking 使用的方式

## 两种方式对比

### 1. Hook-based 集成

**实现方式：**
- 通过 `api.on(hookName, handler)` 注册生命周期 hooks
- 可用的 hooks：`before_model_resolve`、`after_tool_call`、`agent_end` 等
- 每个 hook 独立触发，handler 独立处理

**OpenClaw memory-lancedb 的实现：**
```typescript
// Auto-recall: 在 before_model_resolve 注入记忆
api.on("before_model_resolve", async (event, ctx) => {
  const vector = await embeddings.embed(event.prompt);
  const results = await db.search(vector, 3, 0.3);
  return {
    prependContext: formatRelevantMemoriesContext(results)
  };
});

// Auto-capture: 在 agent_end 捕获记忆
api.on("agent_end", async (event, ctx) => {
  const texts = extractUserMessages(event.messages);
  const analyzed = await analyzeWithLLM(texts);
  for (const item of analyzed) {
    const vector = await embeddings.embed(item.text);
    await db.store({ text: item.text, vector, category, importance });
  }
});
```

**优点：**
- ✅ 简单直接，每个 hook 职责单一
- ✅ 适合独立的读写操作（recall 和 capture 分离）
- ✅ 不需要实现复杂接口
- ✅ 错误隔离好，一个 hook 失败不影响其他

**缺点：**
- ❌ 无法跨 hook 共享状态（除非用外部变量）
- ❌ 需要在多个 hook 中重复处理 sessionKey 映射
- ❌ 难以实现复杂的批量处理逻辑

### 2. Context Engine 集成

**实现方式：**
- 实现 `ContextEngine` 接口：`ingest`、`assemble`、`afterTurn`、`compact`
- OpenClaw 在特定时机调用这些方法
- 可以在 engine 内部维护状态

**OpenViking 的实现：**
```typescript
export function createMemoryOpenVikingContextEngine(params): ContextEngine {
  return {
    info: { id, name, version },

    // ingest: 单条消息写入（OpenViking 选择不用）
    async ingest() { return { ingested: false }; },

    // assemble: 在发送给 LLM 前注入记忆
    async assemble(params) {
      const client = await getClient();
      const memories = await client.memories.recall(query);
      return {
        messages: params.messages,
        systemPromptAddition: formatMemories(memories),
        estimatedTokens: estimateTokens(params.messages)
      };
    },

    // afterTurn: 在 agent 完成后批量处理
    async afterTurn(params) {
      const client = await getClient();
      const decision = getCaptureDecision(params.messages);
      if (decision.shouldCapture) {
        await client.addSessionMessage(sessionId, "user", decision.normalizedText);
        const extracted = await client.extractSessionMemories(sessionId);
        // 处理提取的记忆
      }
    },

    // compact: 压缩历史（可选）
    async compact(params) { ... }
  };
}
```

**优点：**
- ✅ 可以在 engine 内部维护状态（如 sessionMap）
- ✅ 适合复杂的批量处理逻辑
- ✅ 接口语义清晰：assemble = 读，afterTurn = 写
- ✅ 可以在 afterTurn 中一次性处理所有消息

**缺点：**
- ❌ 需要实现完整的 ContextEngine 接口（即使某些方法不用）
- ❌ 更重的抽象，学习成本高
- ❌ 需要理解 OpenClaw 的 context engine 调用时机

## Muninn 的需求分析

### 当前 MVP1 需求

根据 `../workstreams/progress-openclaw-integration.md`：

1. **agent_end** → 一次生成完整 turn
2. `prompt` / `response` 为必填基础事实
3. `toolCalls` / `artifacts` 为可选补充信息

### 数据流特点

- **写入为主**：Muninn 当前主要是捕获上下文，不是召回
- **完整写入**：在 turn 闭合时一次提交完整 payload
- **需要 sessionKey 映射**：OpenClaw sessionKey → Muninn sessionId
- **artifact 采集复杂**：需要根据 tool 类型决定是否回读文件

### 未来扩展

- 可能需要在 `before_model_resolve` 时召回 Muninn 记忆注入 context
- 可能需要在 `afterTurn` 批量触发 Observer 生成

## 决策建议

### 推荐方案：**Hook-based**

**理由：**

1. **MVP1 需求匹配度高**
   - `agent_end` 可以作为完整 turn 的稳定闭合时机
   - 不再依赖 prompt/tool/response 分段写入
   - 失败只打日志，不阻塞主流程

2. **实现复杂度低**
   - 不需要实现完整的 ContextEngine 接口
   - 不需要理解 assemble/compact 等复杂语义
   - 参考 memory-lancedb 的实现即可

3. **错误处理简单**
   - 每个 hook 独立 try-catch
   - 失败只打日志，不阻塞 OpenClaw

4. **未来扩展性**
   - 如果需要召回，可以在 `before_model_resolve` 中实现
   - 如果需要批量处理，可以在 `agent_end` 中触发
   - 不排除未来同时提供 Context Engine 接口

### 当前实现形态

```typescript
// openclaw/plugin/src/hooks.ts

api.on("after_tool_call", async (event, ctx) => {
  const runId = ctx.runId ?? event.runId;
  // 聚合 toolCalls / artifacts
});

api.on("agent_end", async (event, ctx) => {
  const runId = ctx.runId;
  // 读取缓存，组装 turn/capture，随后删除 runId 缓存
});
```

### 关键实现细节

1. **sessionKey 映射**
   ```typescript
   function getOrCreateSessionId(map: Map<string, string>, sessionKey: string): string {
     if (!map.has(sessionKey)) {
       map.set(sessionKey, sessionKey); // 直接使用 sessionKey 作为 sessionId
     }
     return map.get(sessionKey)!;
   }
   ```

2. **runId 聚合**
   - `agent_end(ctx)` 可以拿到 `ctx.runId`
   - 当前插件直接按 `runId` 聚合 `toolCalls` / `artifacts`
   - 不再维护按 session/scope 切分的状态机

3. **artifact 采集**
   ```typescript
   async function collectArtifacts(event): Promise<Record<string, string>> {
     const artifacts: Record<string, string> = {};

     // write/edit: 直接从 event.args 读取
     if (event.toolName === "write" || event.toolName === "edit") {
       artifacts[event.args.file_path] = event.args.content || event.args.new_string;
     }

     // apply_patch: 解析 diff，回读受影响文件
     if (event.toolName === "apply_patch") {
       const paths = extractPathsFromDiff(event.args.patch);
       for (const path of paths) {
         try {
           artifacts[path] = await fs.readFile(path, "utf-8");
         } catch (err) {
           api.logger.warn(`muninn: failed to read ${path}: ${err}`);
         }
       }
     }

     // exec: 如果 command 包含文件路径，尝试回读
     if (event.toolName === "exec") {
       const paths = extractPathsFromCommand(event.args.command);
       // 同上
     }

     return artifacts;
   }
   ```

4. **失败降级**
   - 所有 HTTP 请求都包在 try-catch 中
   - 失败只打 warn 日志，不抛异常
   - 不阻塞 OpenClaw 主流程

## Context Engine 何时考虑？

如果未来出现以下需求，可以考虑提供 Context Engine 接口：

1. **需要在 assemble 时注入大量记忆**（当前 hook 也能做）
2. **需要复杂的批量处理逻辑**（如跨多个 turn 的聚合）
3. **需要实现 compact**（压缩历史记忆）
4. **需要与 OpenClaw 的 context 管理深度集成**

但即使提供 Context Engine，也可以保留 hook-based 作为轻量级选项。

## 结论

**当前阶段选择 Hook-based 集成**，理由：

1. ✅ 实现简单，符合 MVP1 需求
2. ✅ 错误隔离好，不阻塞主流程
3. ✅ 参考实现清晰（memory-lancedb）
4. ✅ 未来可扩展（不排除同时提供 Context Engine）

**下一步行动：**

1. 保持当前 `openclaw/plugin` hook-based 接入形态
2. 继续细化 artifact 采集策略
3. 补齐端到端验证与文档
