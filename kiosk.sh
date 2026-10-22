#!/bin/bash
# Otwiera panel na pełnym ekranie na dedykowanym monitorze.
#
# Który monitor: SCREEN_NAME w kiosk.conf (nazwa jak w Ustawieniach → Wyświetlacze, np. "M14").
# Bez kiosk.conf — pierwszy podłużny ekran (proporcje > 2:1). Główny ekran nigdy nie jest brany.
#
#   kiosk.sh          ręcznie; bez pasującego ekranu otwiera zwykłe okno na głównym ekranie
#   kiosk.sh --auto   tryb dla launchd (co 20 s): uruchamia kiosk, gdy ekran jest podłączony,
#                     i zamyka go, gdy ekran zostanie odłączony
set -euo pipefail
URL="http://127.0.0.1:7319"
PROFILE="$HOME/Library/Application Support/ai-panel/chrome"
AUTO=0
[ "${1:-}" = "--auto" ] && AUTO=1
SCREEN_NAME=""
CONF="$(cd "$(dirname "$0")" && pwd)/kiosk.conf"
# shellcheck source=/dev/null
[ -f "$CONF" ] && . "$CONF"

# Pozycja i rozmiar wybranego ekranu we współrzędnych Chrome (lewy górny róg głównego ekranu = 0,0),
# jako "x,y w,h". Rozmiar jest konieczny: bez niego Chrome przesuwa okno na sąsiedni ekran.
POS=$(SCREEN_NAME="$SCREEN_NAME" osascript -l JavaScript -e '
ObjC.import("AppKit");
const want = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey("SCREEN_NAME")) || "";
const s = $.NSScreen.screens, main = s.objectAtIndex(0).frame;
let out = "";
for (let i = 1; i < s.count; i++) {
  const sc = s.objectAtIndex(i), f = sc.frame;
  if (want ? ObjC.unwrap(sc.localizedName) === want : f.size.width / f.size.height > 2) {
    out = Math.round(f.origin.x) + "," + Math.round(main.size.height - f.origin.y - f.size.height)
        + " " + Math.round(f.size.width) + "," + Math.round(f.size.height);
    break;
  }
}
out;' 2>/dev/null || true)

running() { pgrep -f -- "--user-data-dir=$PROFILE" >/dev/null; }

if [ "$AUTO" = 1 ]; then
  if [ -z "$POS" ]; then
    # Ekran odłączony — nie zostawiaj kiosku na pełnym ekranie głównego monitora.
    running && pkill -f -- "--user-data-dir=$PROFILE" || true
    exit 0
  fi
  running && exit 0
  curl -sf -o /dev/null -m 2 "$URL/api/state" || exit 0 # serwer jeszcze nie wstał
fi

ARGS=(--app="$URL" --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check --disable-session-crashed-bubble)
if [ -n "$POS" ]; then
  ARGS+=(--window-position="${POS% *}" --window-size="${POS#* }" --kiosk)
else
  echo "Nie znaleziono ekranu panelu — otwieram zwykłe okno." >&2
  ARGS+=(--window-size=1920,720)
fi
open -na "Google Chrome" --args "${ARGS[@]}"
