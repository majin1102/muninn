# Muninn macOS

This is the first macOS host for Muninn. It is a SwiftUI shell that starts a bundled `@muninn/server` process, waits for `/health`, injects the desktop bootstrap token into WKWebView, and loads `http://127.0.0.1:<port>/app/`.

## Local Development

Open `Muninn.xcodeproj` in Xcode and run the `Muninn` scheme. The Xcode target builds a native `Muninn.app` bundle with `Info.plist` and `Assets.xcassets`, so Dock, Finder, and Cmd-Tab use the real app icon.

The Swift package remains useful as a lightweight compile check:

```sh
swift build --package-path apple/macos
```

Expected bundle resource layout:

```text
Resources/Server/
  bin/node
  web/dist/
  server/dist/
  server/native/muninn_native.node
  common/dist/
  node_modules/
```

Default desktop data lives under:

```text
~/Library/Application Support/Muninn
```

Developer ID packaging stages `web/dist` and `server/dist`; build both with `pnpm run build:runtime` before packaging. The distribution flow still needs a release-machine script that stages the Node runtime, workspace build artifacts, signs the app with hardened runtime, submits it for notarization, and builds the DMG or ZIP.
