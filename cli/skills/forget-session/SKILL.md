---
name: forget-session
description: Use when the user explicitly asks Muninn, the agent context memory system, to forget, remove, delete, exclude, or stop capturing the current session.
metadata:
  short-description: Forget current session in Muninn
---

# Forget Session

Emit the transcript-bound Muninn capture marker for forgetting the current session. The agent hook reads the marker from the current transcript and applies it to that same session.

Reply with exactly this line, and no other text:

```xml
<MUNINN_CAPTURE_CURRENT_SESSION action="disable" nonce="muninn-capture-v1" />
```

Rules:

- Do not run a CLI helper.
- Do not edit `capture.json` directly.
- Do not call an MCP `capture` tool; it should not exist.
- Keep the marker as an independent full line.
- Treat this as destructive deletion of the current session from Muninn and as disabling future capture for this session.
