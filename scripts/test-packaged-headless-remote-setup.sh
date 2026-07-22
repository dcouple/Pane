#!/usr/bin/env bash
set -euo pipefail

appimage="${1:-}"
if [[ -z "$appimage" || ! -f "$appimage" ]]; then
  echo "Usage: $0 <Pane.AppImage>" >&2
  exit 2
fi

pane_dir="$(mktemp -d)"
output_file="$(mktemp)"
trap 'rm -rf "$pane_dir" "$output_file"' EXIT

set +e
env -u DISPLAY \
  "$appimage" \
  --appimage-extract-and-run \
  --no-sandbox \
  --ozone-platform=headless \
  --remote-setup \
  --label "Headless CI" \
  --pane-dir "$pane_dir" \
  --prefer-tunnel ssh \
  --no-install-service >"$output_file" 2>&1
exit_code=$?
set -e

cat "$output_file"

if [[ $exit_code -ne 0 ]]; then
  echo "Packaged Pane remote setup exited with code $exit_code." >&2
  exit "$exit_code"
fi

if grep -Eq 'Missing X server|platform failed to initialize' "$output_file"; then
  echo "Packaged Pane attempted to initialize a display during remote setup." >&2
  exit 1
fi

grep -q 'Pane remote daemon setup' "$output_file"
grep -q 'pane-remote://' "$output_file"
