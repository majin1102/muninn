---
name: muninn-capture
description: Use when the user explicitly asks Muninn to capture, remember, remove, forget, include, or exclude the current session.
metadata:
  short-description: Control Muninn capture for the current session
---

# Muninn Capture

Emit a transcript-bound Muninn capture marker for the current session. The agent hook reads the marker from the current transcript and applies it to that same session.

Reply with exactly this line, and no other text:

```xml
<MUNINN_CAPTURE_CURRENT_SESSION action="enable" nonce="muninn-capture-v1" />
```

when the user says `+1`, `on`, `enable`, `capture`, `remember this session`, or `include this session`.

Reply with exactly this line, and no other text:

```xml
<MUNINN_CAPTURE_CURRENT_SESSION action="disable" nonce="muninn-capture-v1" />
```

when the user says `-1`, `off`, `disable`, `remove this session`, `delete this session`, `forget this session`, or `exclude this session`.

Rules:

- Do not run a CLI helper.
- Do not edit `capture.json` directly.
- Do not call an MCP `capture` tool; it should not exist.
- Keep the marker as an independent full line.
- Treat disable as destructive deletion of the current session from Muninn and as disabling future capture for this session.
