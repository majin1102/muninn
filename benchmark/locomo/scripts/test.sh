#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)

sh "$SCRIPT_DIR/bootstrap.sh"

cd "$ROOT_DIR"
python3 -m unittest discover -s benchmark/locomo/tests -p 'test_*.py'
NODE_BIN=${NODE_BIN:-}
if [ -z "$NODE_BIN" ]; then
  if [ -x /opt/homebrew/bin/node ]; then
    NODE_BIN=/opt/homebrew/bin/node
  else
    NODE_BIN=node
  fi
fi
"$NODE_BIN" --test benchmark/locomo/test/bridge.test.mjs benchmark/locomo/test/gateway-lab.test.mjs
