#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)
WITH_ZSH_ENV="$SCRIPT_DIR/with-zsh-env.sh"

sh "$SCRIPT_DIR/bootstrap.sh"

cd "$ROOT_DIR"
sh "$WITH_ZSH_ENV" python3 -m unittest benchmark.locomo.tests.test_scoring
sh "$WITH_ZSH_ENV" node --test benchmark/locomo/test/bridge.test.mjs
