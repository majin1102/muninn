#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)

sh "$SCRIPT_DIR/bootstrap.sh"

cd "$ROOT_DIR"
python3 -m unittest discover -s benchmark/locomo/tests -p 'test_*.py'
node --test benchmark/locomo/test/bridge.test.mjs
