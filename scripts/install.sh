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

# launchctl 现代/旧版双写：macOS 10.10+ 推荐 bootstrap/bootout，
# 但 `load/unload` 至今仍可用，且 bootout 在“服务未加载”时返回非 0。
# 因此统一用 `modern || legacy || true` 的写法，两边都试一遍，任何一边成功即可。
LAUNCHD_LABEL="com.davidlin.otus"
LAUNCHD_DOMAIN="gui/$(id -u)"

unload_otus_daemon() {
  launchctl bootout "$LAUNCHD_DOMAIN/$LAUNCHD_LABEL" 2>/dev/null \
    || launchctl unload "$PLIST_DEST" 2>/dev/null \
    || true
}

load_otus_daemon() {
  launchctl bootstrap "$LAUNCHD_DOMAIN" "$PLIST_DEST" 2>/dev/null \
    || launchctl load "$PLIST_DEST"
}

# 2. 停用旧服务
unload_otus_daemon

# 3. 部署并加载 launchd plist
cp "$PLIST_SRC" "$PLIST_DEST"
load_otus_daemon

# 4. 创建全局 CLI 软链接 (若 ~/.local/bin 在 PATH 中)
if [ -d "$HOME/.local/bin" ]; then
  ln -sf "$APP_DIR/bin/otus" "$HOME/.local/bin/otus"
  echo "==> CLI linked to $HOME/.local/bin/otus"
fi

echo "==> [Otus] Daemon loaded successfully!"
echo "==> Run 'otus status' to check service health."
