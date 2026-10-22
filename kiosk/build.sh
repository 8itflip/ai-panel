#!/bin/bash
# Builds bin/AI Panel Kiosk.app, a small WebKit window that replaces a full browser for the kiosk.
set -euo pipefail
cd "$(dirname "$0")"
APP="../bin/AI Panel Kiosk.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
swiftc -O main.swift -o "$APP/Contents/MacOS/ai-panel-kiosk" -framework AppKit -framework WebKit
cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>local.ai-panel.kiosk</string>
	<key>CFBundleName</key>
	<string>AI Panel Kiosk</string>
	<key>CFBundleExecutable</key>
	<string>ai-panel-kiosk</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>LSUIElement</key>
	<true/>
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSAllowsLocalNetworking</key>
		<true/>
	</dict>
</dict>
</plist>
EOF
codesign --force -s - "$APP"
