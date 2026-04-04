#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)

CACHE_DIR=${MUNINN_LOCOMO_DATA_DIR:-"$ROOT_DIR/benchmark/locomo/.cache/data"}
BASE_URL=${MUNINN_LOCOMO_DATA_BASE_URL:-"https://raw.githubusercontent.com/snap-research/locomo/main/data"}

PRINT_DEFAULT_DATA_FILE=0
FORCE=0

usage() {
  cat <<'EOF'
Usage: sh benchmark/locomo/scripts/fetch-data.sh [--force] [--print-default-data-file]

Downloads the LoCoMo benchmark payload into the local cache directory and
verifies SHA256 checksums.

Options:
  --force                    Re-download files even if local checks pass.
  --print-default-data-file  Print the default cached locomo10.json path.
  --help                     Show this help text.
EOF
}

sha256() {
  shasum -a 256 "$1" | awk '{print $1}'
}

verify_file() {
  file_path=$1
  expected_sha=$2

  if [ ! -f "$file_path" ]; then
    return 1
  fi

  actual_sha=$(sha256 "$file_path")
  [ "$actual_sha" = "$expected_sha" ]
}

download_file() {
  relative_path=$1
  expected_sha=$2
  destination_path=$CACHE_DIR/$relative_path
  temp_path=$destination_path.tmp.$$
  source_url=$BASE_URL/$relative_path

  mkdir -p "$(dirname "$destination_path")"

  if [ "$FORCE" -eq 0 ] && verify_file "$destination_path" "$expected_sha"; then
    echo "locomo: using cached $(basename "$destination_path")" >&2
    return
  fi

  echo "locomo: downloading $relative_path" >&2
  curl -L --fail --silent --show-error "$source_url" -o "$temp_path"

  if ! verify_file "$temp_path" "$expected_sha"; then
    rm -f "$temp_path"
    echo "locomo: checksum mismatch for $relative_path" >&2
    exit 1
  fi

  mv "$temp_path" "$destination_path"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --force)
      FORCE=1
      ;;
    --print-default-data-file)
      PRINT_DEFAULT_DATA_FILE=1
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      echo "locomo: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

default_data_file=$CACHE_DIR/locomo10.json

if [ "$PRINT_DEFAULT_DATA_FILE" -eq 1 ]; then
  printf '%s\n' "$default_data_file"
  exit 0
fi

download_file "locomo10.json" "79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4"
download_file "msc_personas_all.json" "75440be006945f5e92141f2374becd551a17a4a98ccd982d1d06c821b40c7dc7"
download_file "multimodal_dialog/example/agent_a.json" "954de63936f73813165644fa0c8773361bb86b9f7b5961990881a718018682b1"
download_file "multimodal_dialog/example/agent_b.json" "7c468baec243af6bc78b0173e180261e1be86c336741edd4cdbf59455e167eba"

echo "locomo: data ready at $CACHE_DIR" >&2
