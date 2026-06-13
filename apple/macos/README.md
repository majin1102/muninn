# Muninn macOS

This is the first macOS host for Muninn. It is a SwiftUI shell that starts a bundled `@muninn/server` process, waits for `/health`, injects the desktop bootstrap token into WKWebView, and loads `http://127.0.0.1:<port>/app/`.

Expected bundle resource layout:

```text
Resources/Server/
  bin/node
  app/dist/
  packages/server/dist/
  packages/core/dist/
  packages/core/native/muninn_native.node
  packages/types/dist/
  node_modules/
```

Default desktop data lives under:

```text
~/Library/Application Support/Muninn
```

The Developer ID distribution flow still needs a release-machine script that stages the Node runtime, workspace build artifacts, signs the app with hardened runtime, submits it for notarization, and builds the DMG or ZIP.
