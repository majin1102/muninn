# Format Module

This crate is Muninn's current Rust format and storage implementation layer.

## Dependency Policy

By default, this crate depends on the official published `lance` crate from crates.io.

Do not commit a repository-external `path` dependency for `lance` into the main branch.

Current default dependency lives in [`format/Cargo.toml`](./Cargo.toml).

## Local Lance Development

If you want Muninn to use your local Lance source tree immediately while you edit it, use a local Cargo patch instead of changing the main dependency to a repo-external path.

Recommended approach:

1. Keep the default dependency in `Cargo.toml` pointing at the published crate.
2. Add a local override with `[patch.crates-io]`.
3. Point that override to your local Lance checkout using an absolute path.

Example:

```toml
[patch.crates-io]
lance = { path = "/absolute/path/to/your/lance/rust/lance" }
```

With that override in place:

- `cargo test` in `format/` will use your local Lance source
- `packages/core` will also use that same local Lance source when it builds and loads the native addon
- changes made in your local Lance checkout can take effect immediately after rebuild/restart

## Why This Policy Exists

Using the published crate by default keeps this repository:

- self-contained
- buildable in clean clones
- CI-friendly
- independent of one developer's local folder layout

Using `[patch.crates-io]` for local experimentation preserves those guarantees while still allowing fast iteration on Lance itself.

## Rust Boundaries

Current Rust-side boundaries are intentionally narrow:

- `src/session.rs`, `src/observing.rs`, `src/semantic_index.rs`
  - Typed session / observing / semantic table operations.
- `src/access.rs`, `src/codec.rs`, `src/schema.rs`, `src/memory_id.rs`
  - Shared table infrastructure below the table API boundary.
- `src/config.rs`
  - Minimal format/storage config loading.
- `src/maintenance.rs`
  - Storage maintenance helpers for compact / vector index / optimize.

Practical rule:

- `packages/core` owns session / observer / memories / LLM orchestration.
- Rust owns typed tables, persistence, and native storage operations.
- Table APIs expose persisted/domain structs, not Arrow types.
- Arrow/codec conversion stays below the table boundary.

## Native Addon Workflow

`packages/core/native/` is the `napi-rs` addon that loads this crate from Node.

Useful local commands:

```bash
cargo check --manifest-path format/Cargo.toml
cargo check --manifest-path packages/core/native/Cargo.toml
pnpm --filter @muninn/core build
```

If you use a local `[patch.crates-io]` override for Lance, it affects both `format/` and `packages/core/native/`, because the addon links against this crate directly.
