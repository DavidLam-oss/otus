#!/usr/bin/env bash
set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST_NAME="com.davidlin.otus.plist"
PLIST_SRC="$PROJECT_DIR/launchd/$PLIST_NAME"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME"

echo "==> [Otus] Installing background service..."

# 1. 准备目录
#
# 这里**不再**把代码复制到 ~/.otus/app。
# 原因：复制出的是一份静态快照，之后仓库怎么改都不会同步过去——
# 曾经因此出现过 `otus` 命令跑了 8 天前的代码、报告修复「看不出效果」的假象。
# 现在 launchd 直接执行 /Applications/Otus.app 内的代码，CLI 软链指向仓库，
# 两者都只有一个真实来源，见下方第 4 步。
mkdir -p "$HOME/.otus"
mkdir -p "$HOME/Library/LaunchAgents"

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

# 4. 创建全局 CLI 软链接，指向仓库本体（而不是代码副本）
#
# daemon 由 launchd 从 /Applications/Otus.app 启动（见 launchd/*.plist），
# CLI 直接跑仓库源码。两者各有唯一来源，改完代码后：
#   - `otus` 命令立即生效
#   - daemon 需要重新 build_app.sh 并重启 launchctl
if [ -d "$HOME/.local/bin" ]; then
  ln -sf "$PROJECT_DIR/bin/otus" "$HOME/.local/bin/otus"
  echo "==> CLI linked to $HOME/.local/bin/otus -> $PROJECT_DIR/bin/otus"
fi

echo "==> [Otus] Daemon loaded successfully!"
echo "==> Run 'otus status' to check service health."
