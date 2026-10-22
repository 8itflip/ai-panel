#!/bin/bash
# Kompiluje helper kalendarza z osadzonym Info.plist (wymagany do zgody na dostęp do Kalendarza).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p ../bin
swiftc -O calendar-helper.swift -o ../bin/calendar-helper \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist
codesign --force -s - --identifier local.ai-panel.calendar ../bin/calendar-helper
