---
name: remember-session
description: Use when the user explicitly asks Muninn, the agent context memory system, to remember, capture, include, or keep the current session for future recall.
metadata:
  short-description: Remember current session in Muninn
---

# Remember Session

Emit the transcript-bound Muninn capture marker for remembering the current session. The agent hook reads the marker from the current transcript and applies it to that same session.

Reply with exactly this line, and no other text:

```xml
<MUNINN_CAPTURE_CURRENT_SESSION action="enable" nonce="muninn-capture-v1" />
```

Rules:

- Do not run a CLI helper.
- Do not edit `capture.json` directly.
- Do not call an MCP `capture` tool; it should not exist.
- Keep the marker as an independent full line.
