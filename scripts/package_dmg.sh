#!/usr/bin/env bash
set -e

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUNDLE="/Applications/Otus.app"
DMG_NAME="Otus-Installer.dmg"
OUTPUT_DMG="$SOURCE_DIR/$DMG_NAME"

echo "========================================="
echo " Packaging Otus.dmg for Distribution"
echo "========================================="

# 1. 确保最新应用已被构建
if [ ! -d "$APP_BUNDLE" ]; then
  echo "[1/3] Building Otus.app first..."
  "$SOURCE_DIR/scripts/build_app.sh"
else
  echo "[1/3] Found existing $APP_BUNDLE"
fi

# 2. 准备临时 DMG 目录
echo "[2/3] Setting up staging directory..."
STAGING_DIR=$(mktemp -d)
cp -R "$APP_BUNDLE" "$STAGING_DIR/Otus.app"
ln -s /Applications "$STAGING_DIR/Applications"

# 3. 使用 macOS 原生 hdiutil 生成压缩 DMG
echo "[3/3] Generating $DMG_NAME..."
rm -f "$OUTPUT_DMG"
hdiutil create -volname "Otus" -srcfolder "$STAGING_DIR" -ov -format UDZO "$OUTPUT_DMG" >/dev/null

rm -rf "$STAGING_DIR"

echo "========================================="
echo " DMG Successfully Created!"
echo " Path: $OUTPUT_DMG"
echo " File Size: $(du -sh "$OUTPUT_DMG" | awk '{print $1}')"
echo "========================================="
echo ""
echo "用户免签安装与 Gatekeeper 绕行提示（已写入发布说明）："
echo "1. 首次打开若提示'无法验证开发者'，在访达中【按住 Control 键点按应用】选择【打开】即可；"
echo "2. 或在终端执行一行命令移除隔离属性: xattr -cr /Applications/Otus.app"
echo "========================================="
