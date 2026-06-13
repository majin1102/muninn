# @muninn/server

`@muninn/server` is the Muninn HTTP runtime package. It runs the local server used by Muninn agent integrations and stores memory through the native Rust-backed storage layer.

## Usage

```sh
muninn-server
```

`muninn-server` runs in the foreground. Keep the process running while Codex or Claude Code integrations use Muninn MCP tools and Stop hooks.

Normal users should install `@muninn/cli` and start the server with:

```sh
muninn serve
```

## Native Build Requirements

`@muninn/server` builds a native addon during install. Install Node.js 20+, Rust with `cargo`, `protoc`, and platform build tools before installing or building this package.
