#!/bin/bash
# Stops and removes AI Panel's launchd agents (project files stay).
set -uo pipefail
for label in local.ai-panel.server local.ai-panel.calendar local.ai-panel.kiosk; do
  launchctl bootout "gui/$UID/$label" 2>/dev/null
  rm -f "$HOME/Library/LaunchAgents/$label.plist"
  echo "✗ $label"
done
