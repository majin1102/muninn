# NPM Release and Local Testing

This document describes how to test Muninn installable packages locally, publish prerelease packages to npm for registry-based debugging, and promote a verified build to the production npm tag.

## Scope

The installable release is centered on `@muninn/cli`, but the CLI depends on the other runtime packages. A registry-based test or release must publish these packages at the same version:

- `@muninn/common`
- `@muninn/format`
- `@muninn/codex`
- `@muninn/claude`
- `@muninn/mcp`
- `@muninn/server`
- `@muninn/cli`

Use `pnpm pack` or `pnpm publish` for release artifacts. Do not use `npm pack` as the release artifact path for this workspace, because npm preserves `workspace:*` dependency specifiers while pnpm rewrites them to concrete package versions in packed and published manifests.

## Prerequisites

Install these before testing or publishing:

- Node.js 20 or newer
- pnpm
- Rust with `cargo`
- `protoc`
- Platform build tools, such as Xcode command line tools on macOS
- npm account with access to the `@muninn` scope

For public scoped packages, npm requires `--access public` on first publish. For private scoped packages, use the appropriate restricted access settings for the organization.

## Local Workspace Verification

Run the workspace checks before creating any package artifact:

```sh
pnpm install --ignore-scripts
pnpm --filter @muninn/cli test
pnpm --filter @muninn/codex test
pnpm --filter @muninn/claude test
pnpm --filter @muninn/mcp build
pnpm --filter @muninn/server build
pnpm run build
```

Then verify the user-facing CLI behavior:

```sh
node cli/dist/cli.js --help
node cli/dist/cli.js install all --dry-run
```

The dry run should describe planned Codex and Claude Code MCP and Stop hook changes. It must not modify real host config files.

## Local Tarball Testing

Use local tarballs before publishing to npm. This catches missing `files` entries, broken `bin` paths, and native build layout problems.

```sh
rm -rf /tmp/muninn-packages
mkdir -p /tmp/muninn-packages

for pkg in common format codex claude mcp server cli; do
  (cd "$pkg" && pnpm pack --pack-destination /tmp/muninn-packages)
done
```

Inspect packed manifests for rewritten internal dependencies:

```sh
tmp="$(mktemp -d)"
tar -xzf /tmp/muninn-packages/muninn-cli-*.tgz -C "$tmp" --strip-components=1
cat "$tmp/package.json"
```

The packed manifest should contain concrete versions such as `0.1.0`, not `workspace:*`.

For the server native build layout, unpack `@muninn/server` and `@muninn/format` as scoped siblings:

```sh
tmp="$(mktemp -d)"
mkdir -p "$tmp/node_modules/@muninn/server" "$tmp/node_modules/@muninn/format"
tar -xzf /tmp/muninn-packages/muninn-server-*.tgz -C "$tmp/node_modules/@muninn/server" --strip-components=1
tar -xzf /tmp/muninn-packages/muninn-format-*.tgz -C "$tmp/node_modules/@muninn/format" --strip-components=1
cargo metadata --manifest-path "$tmp/node_modules/@muninn/server/native/Cargo.toml" --offline --no-deps --format-version 1
```

That command verifies that `server/native/Cargo.toml` can resolve the `../../format` path dependency in an installed npm layout.

To test the CLI from tarballs, install in an isolated npm prefix:

```sh
prefix="$(mktemp -d)"
npm install -g --prefix "$prefix" /tmp/muninn-packages/muninn-cli-*.tgz
"$prefix/bin/muninn" doctor
"$prefix/bin/muninn" serve
```

Keep `muninn serve` running in the foreground while testing host integrations from another shell.

## Registry Prerelease Testing

Use npm dist-tags for registry-based debugging. Publish prerelease artifacts under `next` or `canary`, not `latest`.

Before publishing, make a release-only commit or release branch that removes `private: true` from the packages being published. Keep normal development branches private until release.

Dry-run the recursive publish:

```sh
pnpm -r publish --tag next --access public --dry-run
```

Publish the prerelease:

```sh
pnpm -r publish --tag next --access public
```

Install from npm on a clean machine or isolated prefix:

```sh
npm install -g @muninn/cli@next
muninn doctor
muninn serve
muninn install all --dry-run
muninn install all --yes
muninn status
```

Use `next` for iterative debugging. If you need another attempt, bump every package to a new version and publish again under `next`; npm versions are immutable once published.

## Production Release

Promote only after the `next` package set has been installed and exercised from the registry.

Recommended final checks:

```sh
pnpm --filter @muninn/cli test
pnpm --filter @muninn/codex test
pnpm --filter @muninn/claude test
pnpm --filter @muninn/server build
pnpm run build
pnpm -r publish --tag latest --access public --dry-run
```

Publish to `latest`:

```sh
pnpm -r publish --tag latest --access public
```

Verify from the registry:

```sh
npm view @muninn/cli dist-tags
npm install -g @muninn/cli@latest
muninn doctor
muninn install all --dry-run
```

## Rollback and Recovery

npm package versions are immutable. Do not rely on overwriting a bad version.

If a prerelease is bad:

```sh
npm dist-tag rm @muninn/cli next
```

Publish a fixed version and move `next` again.

If `latest` is bad, publish a new patch version and move `latest` to the fixed version:

```sh
npm dist-tag add @muninn/cli@<fixed-version> latest
```

Repeat this for every package in the release set when the issue affects shared runtime packages.

## Troubleshooting

If installation fails with `Unsupported URL Type "workspace:"`, the artifact was produced with npm or another path that did not rewrite workspace dependencies. Rebuild artifacts with `pnpm pack` or publish with `pnpm publish`.

If `@muninn/server` fails during `postinstall`, confirm that the installing machine has Rust, `cargo`, `protoc`, and platform build tools in `PATH`.

If the native addon builds but `muninn doctor` reports a native addon failure, rebuild the server package after Node.js upgrades:

```sh
npm rebuild @muninn/server
```

If host config installation is risky, test with:

```sh
muninn install all --dry-run
```

Only run the non-dry-run install after the planned changes look correct.
