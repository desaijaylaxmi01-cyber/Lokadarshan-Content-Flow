#!/usr/bin/env bash
# One-time setup of Newsdesk on a fresh Ubuntu 22.04/24.04 server.
#
#   curl -fsSL https://raw.githubusercontent.com/desaijaylaxmi01-cyber/Lokadarshan-Content-Flow/main/deploy/install.sh -o install.sh
#   sudo bash install.sh desk.lokadarshan.news you@example.com
#
# Installs Node.js 22, Nginx and a free HTTPS certificate, runs the portal as a
# background service that restarts automatically, and prints the admin login.
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
REPO="https://github.com/desaijaylaxmi01-cyber/Lokadarshan-Content-Flow.git"
APP_DIR=/opt/newsdesk
DATA_DIR=/var/lib/newsdesk
MAX_UPLOAD_MB=2048

if [[ $EUID -ne 0 ]]; then echo "Run with sudo: sudo bash install.sh <domain> <email>"; exit 1; fi
if [[ -z "$DOMAIN" || -z "$EMAIL" ]]; then
  echo "Usage: sudo bash install.sh <domain> <your-email>"
  echo "Example: sudo bash install.sh desk.lokadarshan.news editor@lokadarshan.news"
  exit 1
fi

echo "==> Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git nginx certbot python3-certbot-nginx ufw ca-certificates ffmpeg

if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
  echo "==> Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "==> Downloading Newsdesk"
id newsdesk >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin newsdesk
if [[ -d "$APP_DIR/.git" ]]; then
  git -c safe.directory="$APP_DIR" -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
npm ci --omit=dev
mkdir -p "$DATA_DIR"

if [[ ! -f "$APP_DIR/.env" ]]; then
  echo
  echo "Paste your Anthropic API key for English translation (from console.anthropic.com),"
  read -rp "or press Enter to skip and add it later: " API_KEY
  ADMIN_PASSWORD="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16)"
  cat > "$APP_DIR/.env" <<EOF
ANTHROPIC_API_KEY=${API_KEY}
ADMIN_EMAIL=${EMAIL}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
PORT=3000
MAX_UPLOAD_MB=${MAX_UPLOAD_MB}
ORIGINAL_RETENTION_DAYS=7
DATA_DIR=${DATA_DIR}
EOF
  NEW_INSTALL=1
fi
chown -R newsdesk:newsdesk "$APP_DIR" "$DATA_DIR"
chmod 600 "$APP_DIR/.env"

echo "==> Creating background service"
cat > /etc/systemd/system/newsdesk.service <<EOF
[Unit]
Description=Newsdesk reporter portal
After=network.target

[Service]
User=newsdesk
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node --env-file=${APP_DIR}/.env src/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now newsdesk
systemctl restart newsdesk

echo "==> Configuring Nginx for ${DOMAIN}"
cat > /etc/nginx/sites-available/newsdesk <<EOF
server {
    listen 80;
    server_name ${DOMAIN};
    client_max_body_size $((MAX_UPLOAD_MB + 50))M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_request_buffering off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
EOF
ln -sf /etc/nginx/sites-available/newsdesk /etc/nginx/sites-enabled/newsdesk
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "==> Opening firewall (SSH, HTTP, HTTPS)"
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null

echo "==> Getting a free HTTPS certificate"
if ! certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos --non-interactive --redirect; then
  echo
  echo "!! HTTPS certificate failed. Check that the DNS record for ${DOMAIN} points to this"
  echo "!! server's IP address, wait a few minutes, then run:"
  echo "!!   sudo certbot --nginx -d ${DOMAIN} -m ${EMAIL} --agree-tos --redirect"
fi

echo
echo "============================================================"
echo " Newsdesk is running at https://${DOMAIN}"
if [[ "${NEW_INSTALL:-}" == 1 ]]; then
  echo " Admin login:    ${EMAIL}"
  echo " Admin password: ${ADMIN_PASSWORD}"
  echo " Write this password down and change it after first login."
fi
echo
echo " Settings file:  ${APP_DIR}/.env   (then: sudo systemctl restart newsdesk)"
echo " Update later:   sudo bash ${APP_DIR}/deploy/update.sh"
echo " View logs:      sudo journalctl -u newsdesk -f"
echo "============================================================"
