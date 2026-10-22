#!/bin/bash
# Installs AI Panel as launchd agents (start at login, restart on failure):
#   local.ai-panel.server    — the server on http://127.0.0.1:7319
#   local.ai-panel.calendar  — the Calendar event exporter
#   local.ai-panel.kiosk     — keeps the kiosk window on the panel display (kiosk.sh --auto, every 20 s)
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs/ai-panel"
CACHE="$HOME/Library/Caches/ai-panel"
mkdir -p "$AGENTS" "$LOGS" "$CACHE"

"$DIR/calendar/build.sh"

KEEP_ALIVE='<key>KeepAlive</key><true/>'
EVERY_20S='<key>StartInterval</key><integer>20</integer>'

agent() { # label, plist launch keys, program args...
  local label="$1" schedule="$2"; shift 2
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
  $schedule
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

agent local.ai-panel.server "$KEEP_ALIVE" /usr/bin/python3 "$DIR/server.py"
agent local.ai-panel.calendar "$KEEP_ALIVE" "$DIR/bin/calendar-helper" "$CACHE/calendar.json"
agent local.ai-panel.kiosk "$EVERY_20S" /bin/bash "$DIR/kiosk.sh" --auto

echo
echo "Panel: http://127.0.0.1:7319"
echo "On first run macOS asks for Calendar access. Click Allow."
