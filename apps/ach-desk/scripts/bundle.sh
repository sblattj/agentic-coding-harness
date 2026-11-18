#!/bin/zsh
# Build "build/ach Desk.app" (release, ad-hoc signed).
# Usage: scripts/bundle.sh [--with-ach /path/to/ach]
#   --with-ach copies an ach binary into Contents/Resources/ach (used only when no
#   Settings path or login-shell ach is found). The default is the user's install,
#   because standalone ach builds lack bun-pty.
# CI: the `ach-desk` job in .github/workflows/ci.yml runs this script ("Bundle the app")
#   and checks the bundle's executable, identifier and ad-hoc signature.
set -euo pipefail

here="${0:A:h}"
pkg="${here:h}"
cd "$pkg"

with_ach=""
while (( $# > 0 )); do
  case "$1" in
    --with-ach) with_ach="${2:?--with-ach needs a path}"; shift 2 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

swift build -c release --product AchDesk
bin_dir="$(swift build -c release --show-bin-path)"

app="$pkg/build/ach Desk.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin_dir/AchDesk" "$app/Contents/MacOS/AchDesk"

version="0.1.0"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.ach.desk</string>
  <key>CFBundleExecutable</key><string>AchDesk</string>
  <key>CFBundleName</key><string>ach Desk</string>
  <key>CFBundleDisplayName</key><string>ach Desk</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><false/>
  <key>NSUserNotificationAlertStyle</key><string>alert</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
PLIST

if [[ -n "$with_ach" ]]; then
  [[ -x "$with_ach" ]] || { echo "not executable: $with_ach" >&2; exit 2; }
  cp "$with_ach" "$app/Contents/Resources/ach"
  chmod 755 "$app/Contents/Resources/ach"
fi

codesign -s - --force --deep "$app"
codesign -v "$app"
echo "built: $app"
