#!/bin/bash
# Installs AI Panel as launchd agents (start at login, restart on failure):
#   local.ai-panel.server    — the server on http://127.0.0.1:7319
#   local.ai-panel.calendar  — the Calendar event exporter
#   local.ai-panel.kiosk     — the kiosk window on the panel display (bin/AI Panel Kiosk.app)
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs/ai-panel"
CACHE="$HOME/Library/Caches/ai-panel"
mkdir -p "$AGENTS" "$LOGS" "$CACHE"

"$DIR/calendar/build.sh"
"$DIR/kiosk/build.sh"

# The kiosk used to be a Chrome window with its own profile; close it if it is still around.
pkill -f -- "--user-data-dir=$HOME/Library/Application Support/ai-panel/chrome" 2>/dev/null || true

KEEP_ALIVE='<key>KeepAlive</key><true/>'

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
  # bootout returns before launchd has finished removing the service, and bootstrapping too early
  # fails with "Input/output error", so wait for it to disappear and retry a few times.
  launchctl bootout "gui/$UID/$label" 2>/dev/null || true
  for _ in $(seq 1 50); do launchctl print "gui/$UID/$label" >/dev/null 2>&1 || break; sleep 0.1; done
  for attempt in 1 2 3 4 5; do
    launchctl bootstrap "gui/$UID" "$plist" 2>/dev/null && break
    [ "$attempt" = 5 ] && { echo "✗ $label: launchctl bootstrap failed" >&2; return 1; }
    sleep 1
  done
  echo "✓ $label"
}

agent local.ai-panel.server "$KEEP_ALIVE" /usr/bin/python3 "$DIR/server.py"
agent local.ai-panel.calendar "$KEEP_ALIVE" "$DIR/bin/calendar-helper" "$CACHE/calendar.json"
agent local.ai-panel.kiosk "$KEEP_ALIVE" "$DIR/bin/AI Panel Kiosk.app/Contents/MacOS/ai-panel-kiosk" --config "$DIR/kiosk.conf"

echo
echo "Panel: http://127.0.0.1:7319"
echo "On first run macOS asks for Calendar access. Click Allow."
