#!/bin/bash
# Builds the calendar helper with an embedded Info.plist (required for the Calendar access prompt).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p ../bin
# Rebuilding changes the ad-hoc signature, which can make macOS ask for Calendar access again,
# so skip the build when the binary is newer than its sources.
if [ ../bin/calendar-helper -nt calendar-helper.swift ] && [ ../bin/calendar-helper -nt Info.plist ]; then
  exit 0
fi
swiftc -O calendar-helper.swift -o ../bin/calendar-helper \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist
codesign --force -s - --identifier local.ai-panel.calendar ../bin/calendar-helper
