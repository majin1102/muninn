#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
INSTALL_DIR=${MUNINN_CORE_INSTALL_DIR:-"$HOME/.local/bin"}

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
BIN_NAME="muninn-core$BIN_SUFFIX"
SOURCE_BIN="$ROOT_DIR/packages/core/bin/$BIN_NAME"
TARGET_BIN="$INSTALL_DIR/$BIN_NAME"

if [ ! -x "$SOURCE_BIN" ]; then
  sh "$ROOT_DIR/scripts/export-daemon.sh"
fi

mkdir -p "$INSTALL_DIR"
cp "$SOURCE_BIN" "$TARGET_BIN"
chmod 755 "$TARGET_BIN"

echo "Installed muninn-core to $TARGET_BIN"
echo "Add $INSTALL_DIR to PATH if it is not already available."
