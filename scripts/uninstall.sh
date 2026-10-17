#!/usr/bin/env bash
set -e

PLIST_NAME="com.davidlin.otus.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME"

echo "==> [Otus] Unloading and removing daemon..."
launchctl unload "$PLIST_DEST" 2>/dev/null || true
rm -f "$PLIST_DEST"
rm -f "$HOME/.local/bin/otus"
"$HOME/Documents/GitHub/otus/bin/otus" stop 2>/dev/null || true

echo "==> [Otus] Daemon uninstalled."
