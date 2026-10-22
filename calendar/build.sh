#!/bin/bash
# Builds the calendar helper with an embedded Info.plist (required for the Calendar access prompt).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p ../bin
swiftc -O calendar-helper.swift -o ../bin/calendar-helper \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist
codesign --force -s - --identifier local.ai-panel.calendar ../bin/calendar-helper
