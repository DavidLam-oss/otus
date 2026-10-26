#!/usr/bin/env bash
#
# Otus 热更新脚本
#
# 背景：launchd（KeepAlive=true）运行的是 /Applications/Otus.app 内的代码副本，
# 而不是仓库源码。改完 src/ 后必须同步过去并重启，否则改动不生效。
#
# 用法：
#   ./scripts/sync.sh            # 同步 src/ 并重启 daemon
#   ./scripts/sync.sh --dry-run  # 只看会做什么
#
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_ROOT="/Applications/Otus.app/Contents/Resources/app"
APP_SRC="$APP_ROOT/src"
APP_NATIVE="$APP_ROOT/native"
PLIST="com.davidlin.otus.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST"
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

run() {
  if $DRY_RUN; then
    echo "  [dry-run] $*"
  else
    eval "$@"
  fi
}

if [[ ! -d "$APP_SRC" ]]; then
  echo "ERROR: 未找到 $APP_SRC" >&2
  echo "请先运行 scripts/build_app.sh 构建应用。" >&2
  exit 1
fi

echo "========================================="
echo " Otus 热更新"
echo " src:    $PROJECT_DIR/src      → $APP_SRC"
echo " native: $PROJECT_DIR/native   → $APP_NATIVE"
echo "========================================="

# 1. 展示差异（src 与 native 都要检查：改 .swift 后需重新编译辅助二进制）
echo ""
echo "[1/4] 检测变更..."
CHANGED_SRC=$(diff -rq "$PROJECT_DIR/src" "$APP_SRC" 2>/dev/null | grep -v "^Only in $APP_SRC" || true)
CHANGED_NATIVE=""
if [[ -d "$APP_NATIVE" ]]; then
  CHANGED_NATIVE=$(diff -rq "$PROJECT_DIR/native" "$APP_NATIVE" 2>/dev/null | grep -v "^Only in $APP_NATIVE" || true)
fi

if [[ -z "$CHANGED_SRC" && -z "$CHANGED_NATIVE" ]]; then
  echo "  无变更，跳过部署。"
  exit 0
fi
[[ -n "$CHANGED_SRC" ]] && echo "$CHANGED_SRC" | sed 's/^/  /'
[[ -n "$CHANGED_NATIVE" ]] && echo "$CHANGED_NATIVE" | sed 's/^/  /'

# 2. 备份
echo ""
echo "[2/4] 备份现有文件..."
BACKUP_DIR="$HOME/.otus/backups/$(date +%Y%m%d-%H%M%S)"
run "mkdir -p '$BACKUP_DIR'"
run "cp -R '$APP_SRC' '$BACKUP_DIR/src'"
[[ -d "$APP_NATIVE" ]] && run "cp -R '$APP_NATIVE' '$BACKUP_DIR/native'"
echo "  备份至 $BACKUP_DIR"

# 3. 同步
echo ""
echo "[3/4] 同步代码..."
[[ -n "$CHANGED_SRC" ]] && run "rsync -a --delete '$PROJECT_DIR/src/' '$APP_SRC/'"
if [[ -n "$CHANGED_NATIVE" ]]; then
  run "rsync -a --delete '$PROJECT_DIR/native/' '$APP_NATIVE/'"
  # .swift 源码比 ~/.otus/bin 下的旧二进制新时，recorder 启动会自动重新编译
  echo "  native 已更新，辅助二进制将在 daemon 启动时自动重新编译"
fi
echo "  完成"

# 4. 重启
#
# 这里刻意**不用** bootout + bootstrap。
# bootout 会把服务从 launchd 里整个摘掉，之后 bootstrap 若失败（实测报
# "Load failed: 5: Input/output error"），服务就永久消失了，而旧进程还活着
# 变成不受 launchd 管理的孤儿——KeepAlive 也随之失效。
#
# `kickstart -k` 是原子的：只杀掉并立即重启服务，注册关系保持不变。
# 它要求服务已加载，否则会报 "Could not find service"，此时再走一次
# bootstrap 作为兜底。
echo ""
echo "[4/4] 重启 daemon..."
LABEL="com.davidlin.otus"
DOMAIN="gui/$(id -u)"

if $DRY_RUN; then
  echo "  [dry-run] launchctl kickstart -k $DOMAIN/$LABEL"
else
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    if ! launchctl kickstart -k "$DOMAIN/$LABEL" 2>&1 | sed 's/^/  /'; then
      echo "  kickstart 失败，尝试 bootstrap 兜底..." >&2
      launchctl bootstrap "$DOMAIN" "$PLIST_DEST" 2>&1 | sed 's/^/  /' || true
    fi
  else
    echo "  服务未加载，执行 bootstrap..."
    launchctl bootstrap "$DOMAIN" "$PLIST_DEST" 2>&1 | sed 's/^/  /' \
      || launchctl load "$PLIST_DEST" 2>&1 | sed 's/^/  /' || true
  fi
  sleep 2

  # 重启后必须校验：服务真的在 launchd 里，且 PID 真的换新了
  if ! launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    echo "" >&2
    echo "ERROR: daemon 重启后未在 launchd 中找到（$DOMAIN/$LABEL）。" >&2
    echo "请手动执行：launchctl bootstrap $DOMAIN $PLIST_DEST" >&2
    exit 1
  fi
  echo "  launchd 状态：$(launchctl print "$DOMAIN/$LABEL" 2>/dev/null | awk -F'= ' '/state =/{print $2; exit}')"
  echo "  daemon PID：$(cat "$HOME/.otus/otus.pid" 2>/dev/null || echo '未知')"
fi

if $DRY_RUN; then
  echo "  [dry-run] 跳过状态检查"
else
  echo ""
  node --experimental-strip-types "$PROJECT_DIR/src/index.ts" status 2>&1 | grep -E "Daemon Running|Today Sessions" | sed 's/^/  /'
fi

echo ""
echo "回滚命令："
echo "  rsync -a --delete $BACKUP_DIR/src/ $APP_SRC/"
echo "  launchctl kickstart -k gui/\$(id -u)/com.davidlin.otus"
