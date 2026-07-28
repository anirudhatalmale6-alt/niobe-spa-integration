#!/usr/bin/env bash
# Provision a fresh Ubuntu 24.04 server for the Niobe integration service.
# Idempotent — safe to re-run. Run as root:  bash setup.sh
set -euo pipefail

APP_DIR=/opt/niobe-integration
REPO=https://github.com/anirudhatalmale6-alt/niobe-spa-integration.git
DOMAIN=pay.niobebeauty.com

echo "==> Updating packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git nginx ufw

echo "==> Installing Node.js 22 (if missing)"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node --version

echo "==> Creating service user 'niobe' (if missing)"
id niobe >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin niobe

echo "==> Fetching app to $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO" "$APP_DIR"
fi
chown -R niobe:niobe "$APP_DIR"

echo "==> .env"
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  echo "    !! Created $APP_DIR/.env from the example — fill in the real keys, then set PORT=8080, DEMO_MODE=false, PAYMENT_DEMO=false, PUBLIC_URL=https://$DOMAIN"
fi
chown niobe:niobe "$APP_DIR/.env"; chmod 600 "$APP_DIR/.env"

echo "==> systemd service"
cp "$APP_DIR/deploy/niobe-pay.service" /etc/systemd/system/niobe-pay.service
systemctl daemon-reload
systemctl enable niobe-pay
systemctl restart niobe-pay

echo "==> Nginx"
cp "$APP_DIR/deploy/nginx-niobe.conf" /etc/nginx/sites-available/niobe
ln -sf /etc/nginx/sites-available/niobe /etc/nginx/sites-enabled/niobe
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "==> Firewall"
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 'Nginx Full' >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true

echo
echo "==> Base setup done. Remaining (see DEPLOY.md):"
echo "    1) Point DNS: $DOMAIN  A  <this server IP>"
echo "    2) Once DNS resolves:  certbot --nginx -d $DOMAIN   (adds HTTPS)"
echo "    3) Fill $APP_DIR/.env with real keys, then: systemctl restart niobe-pay"
echo "    4) Check: systemctl status niobe-pay   and   curl -s localhost:8080/api/health"
