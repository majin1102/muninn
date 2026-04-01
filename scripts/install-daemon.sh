#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
INSTALL_DIR=${MUNNAI_CORE_INSTALL_DIR:-"$HOME/.local/bin"}
SOURCE_BIN="$ROOT_DIR/packages/core/bin/munnai-core"
TARGET_BIN="$INSTALL_DIR/munnai-core"

if [ ! -x "$SOURCE_BIN" ]; then
  sh "$ROOT_DIR/scripts/export-daemon.sh"
fi

mkdir -p "$INSTALL_DIR"
cp "$SOURCE_BIN" "$TARGET_BIN"
chmod 755 "$TARGET_BIN"

echo "Installed munnai-core to $TARGET_BIN"
echo "Add $INSTALL_DIR to PATH if it is not already available."
