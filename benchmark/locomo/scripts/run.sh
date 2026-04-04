#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)
WITH_ZSH_ENV="$SCRIPT_DIR/with-zsh-env.sh"

has_data_file=0
expect_data_file_value=0
for arg in "$@"; do
  if [ "$expect_data_file_value" -eq 1 ]; then
    has_data_file=1
    expect_data_file_value=0
    continue
  fi
  if [ "$arg" = "--data-file" ]; then
    expect_data_file_value=1
  fi
done

sh "$SCRIPT_DIR/bootstrap.sh"

if [ "$has_data_file" -eq 0 ]; then
  sh "$SCRIPT_DIR/fetch-data.sh"
  default_data_file=$(sh "$SCRIPT_DIR/fetch-data.sh" --print-default-data-file)
  set -- --data-file "$default_data_file" "$@"
fi

cd "$ROOT_DIR"
sh "$WITH_ZSH_ENV" python3 benchmark/locomo/run.py "$@"
