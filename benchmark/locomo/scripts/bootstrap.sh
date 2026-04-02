#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)
WITH_ZSH_ENV="$SCRIPT_DIR/with-zsh-env.sh"

cd "$ROOT_DIR"
sh "$WITH_ZSH_ENV" pnpm --filter @muninn/core export:daemon
sh "$WITH_ZSH_ENV" pnpm --filter @muninn/benchmark-locomo build
