#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)

cd "$ROOT_DIR"
pnpm --filter @muninn/core build
pnpm --filter @muninn/sidecar build
pnpm --filter @muninn/benchmark-locomo build
