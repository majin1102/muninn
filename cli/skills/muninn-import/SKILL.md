---
name: muninn-import
description: Use when the user asks Muninn to import prior sessions or context using a natural-language query.
metadata:
  short-description: Import prior Muninn session context
---

# Muninn Import

Use MCP `muninn-list` and `muninn-read` to import context from prior sessions.

Workflow:

1. Parse optional `--top <integer>` from the user request.
2. Call `muninn-list({ query, top_k? })` with the remaining user text as `query`.
3. Show the numbered candidate list with session titles and summaries.
4. Ask the user to choose by number.
5. Keep the candidate `session_*` `context_id` values available.
6. When the user chooses candidates, map selected numbers to `session_*` `context_id` values and call `muninn-read({ context_ids })`.
7. Treat the read result as imported context for the current conversation.

Rules:

- Do not call an MCP `import` tool; it should not exist.
- Do not read every candidate automatically.
- If the user asks for source provenance or references behind a candidate, map the selected number to its `session_*` `context_id` and call MCP `muninn-explain`.
