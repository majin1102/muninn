#!/bin/sh
set -eu

if [ "$#" -eq 0 ]; then
  echo "usage: with-zsh-env.sh <command> [args...]" >&2
  exit 1
fi

if [ -f "$HOME/.zshrc" ]; then
  # Source the user's interactive zsh PATH tweaks before running benchmark tools.
  . "$HOME/.zshrc"
fi

exec "$@"
