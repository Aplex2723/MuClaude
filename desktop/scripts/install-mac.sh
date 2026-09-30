#!/usr/bin/env bash
# Build MuClaude and install it into /Applications (replacing any previous copy).
# Usage:  npm run install:mac      (add --no-build to reuse the last build)
set -euo pipefail
cd "$(dirname "$0")/.."

APP="dist/mac-arm64/MuClaude.app"
DEST="/Applications/MuClaude.app"

if [ "${1:-}" != "--no-build" ]; then
  [ -d node_modules ] || npm install
  npm run --silent dist:mac
fi
[ -d "$APP" ] || { echo "Build not found: $APP"; exit 1; }

if pgrep -xq "MuClaude"; then
  echo "MuClaude is running. Quit it first, then run this again."
  exit 1
fi

rm -rf "$DEST"
ditto "$APP" "$DEST"
codesign --verify --deep --strict "$DEST"
echo "Installed: $DEST"
echo "First launch: right-click the app and choose Open (it is ad-hoc signed, not notarized)."
