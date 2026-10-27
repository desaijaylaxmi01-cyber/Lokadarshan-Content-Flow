#!/bin/bash
# Double-click to start Newsdesk on a Mac. If macOS blocks it: right-click > Open.
cd "$(dirname "$0")"
echo "Newsdesk - starting up"

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "Node.js 22 or newer is needed. Download the LTS version from https://nodejs.org, install it, then double-click this file again."
  open https://nodejs.org
  read -r -p "Press Enter to close."
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    brew install ffmpeg
  else
    echo "Note: ffmpeg is not installed, so videos won't be compressed and no screenshots are made."
    echo "Install Homebrew from https://brew.sh, then run: brew install ffmpeg"
  fi
fi

[ -d node_modules ] || npm install --omit=dev --no-audit --no-fund || { read -r -p "Install failed. Press Enter to close."; exit 1; }
[ -f .env ] || printf 'ANTHROPIC_API_KEY=\nPORT=3000\n' > .env

(sleep 4; open http://localhost:3000) &
node src/server.js
read -r -p "Newsdesk has stopped. Press Enter to close."
