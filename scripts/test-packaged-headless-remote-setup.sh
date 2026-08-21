#!/usr/bin/env bash
set -euo pipefail

appimage="${1:-}"
if [[ -z "$appimage" || ! -f "$appimage" ]]; then
  echo "Usage: $0 <Pane.AppImage>" >&2
  exit 2
fi
appimage_dir="$(cd "$(dirname "$appimage")" && pwd)"
appimage="$appimage_dir/$(basename "$appimage")"

pane_dir="$(mktemp -d)"
output_file="$(mktemp)"
extract_dir="$(mktemp -d)"
trap 'rm -rf "$pane_dir" "$output_file" "$extract_dir"' EXIT

(
  cd "$extract_dir"
  "$appimage" --appimage-extract >/dev/null
  test -x squashfs-root/pane
  test -L squashfs-root/Pane
  test "$(readlink squashfs-root/Pane)" = pane
)

# Bounded: remote setup is a print-and-exit path that takes seconds. Without a
# limit a packaged app that never exits hangs the release job until the runner
# times out, with the app's own output still trapped in $output_file and never
# printed, which leaves nothing to debug from.
timeout_seconds="${PANE_HEADLESS_SETUP_TIMEOUT:-180}"

set +e
timeout --kill-after=15s "$timeout_seconds" \
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

echo "--- packaged Pane remote setup output (exit $exit_code) ---"
cat "$output_file"
echo "--- end output ---"

if [[ $exit_code -eq 124 || $exit_code -eq 137 ]]; then
  echo "Packaged Pane remote setup did not exit within ${timeout_seconds}s." >&2
  echo "Setup is a print-and-exit path, so this means it blocked or threw without exiting." >&2
  exit 1
fi

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
