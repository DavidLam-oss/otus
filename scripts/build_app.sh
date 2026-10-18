#!/usr/bin/env bash
set -e

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGO_SRC="${1:-$SOURCE_DIR/assets/AppIcon.png}"
APP_BUNDLE="/Applications/Otus.app"
CONTENTS="$APP_BUNDLE/Contents"
RESOURCES="$CONTENTS/Resources"
MACOS_DIR="$CONTENTS/MacOS"
APP_DIR="$RESOURCES/app"

echo "========================================="
echo " Building Otus.app (Lightweight macOS App)"
echo " Logo: $LOGO_SRC"
echo " Destination: $APP_BUNDLE"
echo "========================================="

# 1. 准备目录结构
rm -rf "$APP_BUNDLE"
mkdir -p "$MACOS_DIR"
mkdir -p "$RESOURCES"
mkdir -p "$APP_DIR"

# 2. 生成多分辨率 AppIcon.icns (裁剪去除外围暗色画布，生成符合 Apple HIG 规范的纯净透明圆角图标)
TMP_DIR_BUILD=$(mktemp -d)
CLEAN_PNG="$TMP_DIR_BUILD/app_icon_clean.png"
TMP_ICONSET="$TMP_DIR_BUILD/icon.iconset"
mkdir -p "$TMP_ICONSET"

echo "[1/4] Generating AppIcon.icns (Apple HIG transparent squircle)..."
if [[ "$LOGO_SRC" == *.png ]] && [[ "$LOGO_SRC" == *"AppIcon.png"* ]]; then
  cp "$LOGO_SRC" "$CLEAN_PNG"
else
  swift "$SOURCE_DIR/native/clean-icon.swift" "$LOGO_SRC" "$CLEAN_PNG"
fi

sips -s format png -z 16 16     "$CLEAN_PNG" --out "$TMP_ICONSET/icon_16x16.png" >/dev/null
sips -s format png -z 32 32     "$CLEAN_PNG" --out "$TMP_ICONSET/icon_16x16@2x.png" >/dev/null
sips -s format png -z 32 32     "$CLEAN_PNG" --out "$TMP_ICONSET/icon_32x32.png" >/dev/null
sips -s format png -z 64 64     "$CLEAN_PNG" --out "$TMP_ICONSET/icon_32x32@2x.png" >/dev/null
sips -s format png -z 128 128   "$CLEAN_PNG" --out "$TMP_ICONSET/icon_128x128.png" >/dev/null
sips -s format png -z 256 256   "$CLEAN_PNG" --out "$TMP_ICONSET/icon_128x128@2x.png" >/dev/null
sips -s format png -z 256 256   "$CLEAN_PNG" --out "$TMP_ICONSET/icon_256x256.png" >/dev/null
sips -s format png -z 512 512   "$CLEAN_PNG" --out "$TMP_ICONSET/icon_256x256@2x.png" >/dev/null
sips -s format png -z 512 512   "$CLEAN_PNG" --out "$TMP_ICONSET/icon_512x512.png" >/dev/null
sips -s format png -z 1024 1024 "$CLEAN_PNG" --out "$TMP_ICONSET/icon_512x512@2x.png" >/dev/null

iconutil -c icns "$TMP_ICONSET" -o "$RESOURCES/AppIcon.icns"
cp "$CLEAN_PNG" "$SOURCE_DIR/assets/AppIcon.png"
rm -rf "$TMP_DIR_BUILD"

# 3. 生成 Info.plist (指定 LSUIElement=true，纯静默后台，不占 Dock)
echo "[2/4] Writing Info.plist..."
cat << 'EOF' > "$CONTENTS/Info.plist"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>com.davidlin.otus</string>
    <key>CFBundleName</key>
    <string>Otus</string>
    <key>CFBundleDisplayName</key>
    <string>Otus</string>
    <key>CFBundleExecutable</key>
    <string>Otus</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>0.2.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>12.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSSupportsAutomaticGraphicsSwitching</key>
    <true/>
    <key>NSScreenCaptureUsageDescription</key>
    <string>Otus captures local compressed screenshots for generating your personal developer journal.</string>
    <key>NSAppleEventsUsageDescription</key>
    <string>Otus reads active browser URLs and window titles for journaling.</string>
</dict>
</plist>
EOF

# 4. 同步应用源码与二进制
echo "[3/4] Packaging application files..."
rsync -a --exclude ".*" --exclude "docs" --exclude "archive" "$SOURCE_DIR/" "$APP_DIR/"

# 预编译所有 Swift 原生组件
mkdir -p "$APP_DIR/bin"
swiftc -O "$SOURCE_DIR/native/ocr.swift" -o "$APP_DIR/bin/otus-ocr"
swiftc -O "$SOURCE_DIR/native/input-monitor.swift" -o "$APP_DIR/bin/otus-input-monitor"
swiftc -O "$SOURCE_DIR/native/browser-tab.swift" -o "$APP_DIR/bin/otus-browser-tab"
swiftc -O "$SOURCE_DIR/native/img-diff.swift" -o "$APP_DIR/bin/otus-diff"
swiftc -O "$SOURCE_DIR/native/perms-check.swift" -o "$APP_DIR/bin/otus-perms"
swiftc -O "$SOURCE_DIR/native/menu-bar.swift" -o "$APP_DIR/bin/otus-menu-bar"

# 5. 写入启动二进制
echo "[4/4] Creating launcher binary..."
cat << 'EOF' > "$MACOS_DIR/Otus"
#!/usr/bin/env bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../Resources/app" && pwd)"
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

if [ $# -eq 0 ]; then
  exec "$DIR/bin/otus" open-latest
else
  exec "$DIR/bin/otus" "$@"
fi
EOF
chmod +x "$MACOS_DIR/Otus"
chmod +x "$APP_DIR/bin/otus"
chmod +x "$APP_DIR/bin/"*

# 6. Ad-hoc 代码签名 (保证在 Apple Silicon 芯片与无证书 Mac 上合法加载)
echo "[5/5] Applying ad-hoc code signature..."
codesign --force --deep -s - "$APP_BUNDLE" 2>/dev/null || true

echo "========================================="
echo " Otus.app successfully created!"
echo " Path: $APP_BUNDLE"
echo " Bundle ID: com.davidlin.otus"
echo "========================================="
