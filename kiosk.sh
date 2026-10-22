#!/bin/bash
# Otwiera panel na pełnym ekranie na podłużnym monitorze (proporcje > 2:1).
# Bez takiego monitora otwiera zwykłe okno aplikacji na głównym ekranie.
set -euo pipefail
URL="http://127.0.0.1:7319"
PROFILE="$HOME/Library/Application Support/ai-panel/chrome"

# Pozycja podłużnego ekranu we współrzędnych Chrome (lewy górny róg głównego ekranu = 0,0).
POS=$(osascript -l JavaScript -e '
ObjC.import("AppKit");
const s = $.NSScreen.screens, main = s.objectAtIndex(0).frame;
let out = "";
for (let i = 0; i < s.count; i++) {
  const f = s.objectAtIndex(i).frame;
  if (f.size.width / f.size.height > 2) {
    out = Math.round(f.origin.x) + "," + Math.round(main.size.height - f.origin.y - f.size.height);
    break;
  }
}
out;')

ARGS=(--app="$URL" --user-data-dir="$PROFILE" --no-first-run --disable-session-crashed-bubble)
if [ -n "$POS" ]; then
  ARGS+=(--window-position="$POS" --kiosk)
else
  echo "Nie znaleziono podłużnego ekranu — otwieram zwykłe okno." >&2
  ARGS+=(--window-size=1920,720)
fi
open -na "Google Chrome" --args "${ARGS[@]}"
