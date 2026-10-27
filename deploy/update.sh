#!/usr/bin/env bash
# Pull the latest code from GitHub and restart Newsdesk.  Usage: sudo bash /opt/newsdesk/deploy/update.sh
set -euo pipefail
APP_DIR=/opt/newsdesk
cd "$APP_DIR"
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg >/dev/null
sudo -u newsdesk git pull --ff-only
sudo -u newsdesk npm ci --omit=dev
systemctl restart newsdesk
echo "Updated to $(git log -1 --format='%h %s') and restarted."
