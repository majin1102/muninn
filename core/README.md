# Core Module

This crate is Munnai's current Rust core implementation layer.

## Dependency Policy

By default, this crate depends on the official published `lance` crate from crates.io.

Do not commit a repository-external `path` dependency for `lance` into the main branch.

Current default dependency lives in [Cargo.toml](/Users/Nathan/workspace/munnai/core/Cargo.toml).

## Local Lance Development

If you want Munnai to use your local Lance source tree immediately while you edit it, use a local Cargo patch instead of changing the main dependency to a repo-external path.

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

- `cargo test` in `core/` will use your local Lance source
- `packages/core` will also use that same local Lance source when it spawns the Rust bridge
- changes made in your local Lance checkout can take effect immediately after rebuild/restart

## Why This Policy Exists

Using the published crate by default keeps this repository:

- self-contained
- buildable in clean clones
- CI-friendly
- independent of one developer's local folder layout

Using `[patch.crates-io]` for local experimentation preserves those guarantees while still allowing fast iteration on Lance itself.

## Rust Boundaries

Current Rust-side boundaries are intentionally layered:

- `service.rs`
  - Top-level Rust application facade.
  - `Service` is the preferred entrypoint for higher layers.
- `storage.rs`
  - Internal persistence boundary.
  - `Storage` owns object-store configuration and dataset wiring.
  - `SessionStore`, `ObservingStore`, and `SemanticIndexStore` are crate-internal typed stores used by Rust modules.
- `format/`
  - Pure persisted row and memory-id models.
  - Row structs do not carry persistence behavior.
- `observer/`
  - Observing domain state and orchestration.
- `memory/`
  - Read-side memory composition over `SESSION` and `OBSERVING`.

Practical rule:

- Higher-level callers should prefer `Service`.
- Internal Rust modules can use `Storage` and its typed stores.
- Store APIs expose internal domain structs, not Arrow types.
- Arrow/codec conversion stays below the store boundary.
