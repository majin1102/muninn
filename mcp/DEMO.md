# Muninn MCP Demo

Muninn MCP exposes four tools:

- `muninn_recall` with `{ query, budget?, top_k? }`
- `muninn_list` with `{ query, top_k? }`
- `muninn_read` with `{ context_ids }`
- `muninn_explain` with `{ context_id }`

`muninn_list` returns session summaries with opaque `session_*` context ids. `muninn_recall` returns extracted recall content and a source context reference table when a recalled hit can be tied back to a session.

Use `muninn_read` to read `session_*` or `turn_*` context ids. Use `muninn_explain` to inspect source provenance for `session_*` context ids.

MCP hosts should treat context ids as opaque strings and pass them back unchanged.
