# @muninn/mcp

`@muninn/mcp` is Muninn's MCP adapter and protocol package. It exposes the `muninn-mcp` command, which connects MCP hosts to the Muninn server over the local server API.

## Usage

```sh
muninn-mcp
```

Most users should not install this package directly. Use the Muninn CLI host installers instead:

```sh
muninn install codex
muninn install claude
muninn install all
```

There is no `muninn install mcp` target. `mcp/` remains the protocol adapter used by Codex and Claude Code integrations.

## Tools

- `muninn_recall` searches extracted memory with `{ query, budget?, top_k? }`.
- `muninn_list` lists related sessions with `{ query, top_k? }`.
- `muninn_read` reads opaque context ids with `{ context_ids }`.
- `muninn_explain` explains session provenance with `{ context_id }`.

Context ids are opaque `session_*` or `turn_*` strings. MCP hosts should pass them back to Muninn unchanged.
