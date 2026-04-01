#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
TARGET_BIN="$ROOT_DIR/core/target/release/munnai-core"
EXPORT_DIR="$ROOT_DIR/packages/core/bin"
EXPORT_BIN="$EXPORT_DIR/munnai-core"

cargo build --release --manifest-path "$ROOT_DIR/core/Cargo.toml" --bin munnai-core
mkdir -p "$EXPORT_DIR"
cp "$TARGET_BIN" "$EXPORT_BIN"
chmod 755 "$EXPORT_BIN"

echo "Exported munnai-core to $EXPORT_BIN"
