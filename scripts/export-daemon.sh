#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
EXPORT_DIR="$ROOT_DIR/packages/core/bin"

platform_suffix() {
  case "$(uname -s 2>/dev/null || echo unknown)" in
    CYGWIN*|MINGW*|MSYS*)
      echo ".exe"
      ;;
    *)
      if [ "${OS:-}" = "Windows_NT" ]; then
        echo ".exe"
      else
        echo ""
      fi
      ;;
  esac
}

BIN_SUFFIX=$(platform_suffix)
BIN_NAME="munnai-core$BIN_SUFFIX"
TARGET_BIN="$ROOT_DIR/core/target/release/$BIN_NAME"
EXPORT_BIN="$EXPORT_DIR/$BIN_NAME"

cargo build --release --manifest-path "$ROOT_DIR/core/Cargo.toml" --bin munnai-core
mkdir -p "$EXPORT_DIR"
cp "$TARGET_BIN" "$EXPORT_BIN"
chmod 755 "$EXPORT_BIN"

echo "Exported munnai-core to $EXPORT_BIN"
