# Round 01

## Base

- PR: #45 `codex/extractor-observer-memory-units`
- Base branch: `main`
- Merge base: `8603662ccbfe43476554afc0018030d184ef05a9`

## Scope

- Reviewed `git diff origin/main...HEAD`, with focus on Board session/observation split rendering, citation navigation, and session pagination.

## Findings

1. 新发现：Observation 正文里的 turn citation 可能指向当前聊天窗口尚未加载的后续 turn。当前 `locateConversationTurn()` 只设置 focus，不会补加载 session 的后续页；当 session 初始只加载前 100 条，而 citation 指向更靠后的 `turn:*` 时，右侧 Conversation 无法滚到目标轮次。

## Finding Comparison

- Finding 1: `new`。此前没有 review-loop 记录。

## Fix Plan

- 在 `App.tsx` 增加按目标 turn 补页的 helper。
- `locateConversationTurn()` 在目标 turn 已加载时保持原逻辑；未加载但当前 session 还有 `nextOffset` 时，先顺序加载后续页直到找到目标或耗尽分页，再触发 focus。

## Fixes Applied

- 新增 `loadUntilTurn(session, memoryId)`，复用现有 `client.loadSessionTurns()` 和 `updateSession()` 合并后续页数据。
- 新增 `hasTurn(session, memoryId)` 辅助函数。
- `locateConversationTurn()` 改为在定位前按需补加载目标 turn。

## Verification

- `source ~/.zprofile && pnpm --filter @muninn/board build && pnpm --filter @muninn/sidecar build` passed.
