---
name: muninn-remember
description: Use when the user explicitly asks Muninn, the agent context memory system, to remember, capture, include, or keep the current session for future recall.
metadata:
  short-description: Remember current session in Muninn
---

# Muninn Remember

Emit a short user-facing confirmation plus the hidden transcript-bound Muninn capture marker for remembering the current session. The agent hook reads the marker from the current transcript and applies it to that same session.

Reply with exactly these two lines, and no other text:

```md
已开启当前会话的 Muninn 捕获。
<!-- <MUNINN_CAPTURE_CURRENT_SESSION action="enable" nonce="muninn-capture-v1" /> -->
```

Rules:

- Do not run a CLI helper.
- Do not edit `capture.json` directly.
- Do not call an MCP `capture` tool; it should not exist.
- Keep the hidden marker comment as an independent full line.
