#!/bin/bash
# Instaluje AI Panel jako usługi launchd (start przy logowaniu, restart po awarii):
#   local.ai-panel.server    — serwer na http://127.0.0.1:7319
#   local.ai-panel.calendar  — eksport wydarzeń z Kalendarza
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs/ai-panel"
CACHE="$HOME/Library/Caches/ai-panel"
mkdir -p "$AGENTS" "$LOGS" "$CACHE"

"$DIR/calendar/build.sh"

agent() { # label, program args...
  local label="$1"; shift
  local plist="$AGENTS/$label.plist"
  {
    cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
EOF
    for a in "$@"; do echo "    <string>$a</string>"; done
    cat <<EOF
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOGS/$label.log</string>
  <key>StandardErrorPath</key><string>$LOGS/$label.log</string>
</dict>
</plist>
EOF
  } > "$plist"
  launchctl bootout "gui/$UID/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$UID" "$plist"
  echo "✓ $label"
}

agent local.ai-panel.server /usr/bin/python3 "$DIR/server.py"
agent local.ai-panel.calendar "$DIR/bin/calendar-helper" "$CACHE/calendar.json"

echo
echo "Panel: http://127.0.0.1:7319"
echo "Przy pierwszym uruchomieniu macOS zapyta o dostęp do Kalendarza — kliknij „Zezwól”."
