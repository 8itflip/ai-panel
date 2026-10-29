#!/bin/bash
# Installs the AI Panel Desk plugin into the Stream Deck app (as a link, so a git pull updates it)
# and restarts the app so it loads. Remove it with: ./install.sh --uninstall
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
NAME="local.ai-panel.desk.sdPlugin"
PLUGINS="$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins"
APP="Elgato Stream Deck"

if [ ! -d "$PLUGINS" ]; then
  echo "Stream Deck app not found (no $PLUGINS). Install it from elgato.com first." >&2
  exit 1
fi

osascript -e "tell application \"$APP\" to quit" 2>/dev/null || true
for _ in $(seq 20); do pgrep -xq "Stream Deck" || break; sleep 0.5; done

rm -rf "${PLUGINS:?}/$NAME"
if [ "${1:-}" != "--uninstall" ]; then
  ln -s "$DIR/$NAME" "$PLUGINS/$NAME"
  echo "Linked $PLUGINS/$NAME -> $DIR/$NAME"
else
  echo "Removed $NAME"
fi

# Stream Deck is a Qt app and `open` passes our environment on: a shell-wide QT_QPA_PLATFORM (e.g. xcb
# for X11 tools) makes it exit right away.
env -u QT_QPA_PLATFORM -u QT_PLUGIN_PATH open -a "$APP"
