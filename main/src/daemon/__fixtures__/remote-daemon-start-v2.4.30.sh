#!/usr/bin/env sh
set -eu
export PANE_DIR='/home/test/.pane_remote'
exec /bin/sh -lc 'PANE_DIR='"'"'/home/test/.pane_remote'"'"' ELECTRON_OZONE_PLATFORM_HINT=headless '"'"'/opt/Pane/Pane'"'"' --daemon-headless --pane-dir '"'"'/home/test/.pane_remote'"'"''
