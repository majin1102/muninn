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
