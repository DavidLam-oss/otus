#!/usr/bin/env bash
set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$HOME/.otus/app"
PLIST_NAME="com.davidlin.otus.plist"
PLIST_SRC="$PROJECT_DIR/launchd/$PLIST_NAME"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME"

echo "==> [Otus] Installing background service..."

# 1. 确保目录并同步代码到 ~/.otus/app (避开 macOS ~/Documents 的 TCC 权限限制)
mkdir -p "$HOME/.otus"
mkdir -p "$APP_DIR"
mkdir -p "$HOME/Library/LaunchAgents"

cp -R "$PROJECT_DIR/assets" "$APP_DIR/"
cp -R "$PROJECT_DIR/bin" "$APP_DIR/"
cp -R "$PROJECT_DIR/launchd" "$APP_DIR/"
cp -R "$PROJECT_DIR/native" "$APP_DIR/"
cp "$PROJECT_DIR/package.json" "$APP_DIR/"
cp -R "$PROJECT_DIR/src" "$APP_DIR/"
cp "$PROJECT_DIR/tsconfig.json" "$APP_DIR/"
chmod +x "$APP_DIR/bin/otus"

# 2. 停用旧服务
launchctl unload "$PLIST_DEST" 2>/dev/null || true

# 3. 部署并加载 launchd plist
cp "$PLIST_SRC" "$PLIST_DEST"
launchctl load "$PLIST_DEST"

# 4. 创建全局 CLI 软链接 (若 ~/.local/bin 在 PATH 中)
if [ -d "$HOME/.local/bin" ]; then
  ln -sf "$APP_DIR/bin/otus" "$HOME/.local/bin/otus"
  echo "==> CLI linked to $HOME/.local/bin/otus"
fi

echo "==> [Otus] Daemon loaded successfully!"
echo "==> Run 'otus status' to check service health."
