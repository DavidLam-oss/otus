#!/usr/bin/env bash
set -e

PLIST_NAME="com.davidlin.otus.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME"

echo "==> [Otus] Unloading and removing daemon..."
# 现代写法优先，失败回退旧写法；两者都失败也不阻断卸载
launchctl bootout "gui/$(id -u)/com.davidlin.otus" 2>/dev/null \
  || launchctl unload "$PLIST_DEST" 2>/dev/null \
  || true
rm -f "$PLIST_DEST"
rm -f "$HOME/.local/bin/otus"
"$HOME/Documents/GitHub/otus/bin/otus" stop 2>/dev/null || true

echo "==> [Otus] Daemon uninstalled."
