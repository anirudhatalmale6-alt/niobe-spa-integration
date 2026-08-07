# Deploying the Niobe integration (production)

Target: a small Ubuntu 24.04 server (DigitalOcean/Hetzner, ~$6/mo) behind Nginx + HTTPS,
serving `https://pay.niobebeauty.com`. The app is zero-dependency Node (`node src/server.js`);
Nginx is the public edge and the app listens on `127.0.0.1:8080`.

## 1. Base provisioning
As root on the fresh server:

```bash
curl -fsSL https://raw.githubusercontent.com/anirudhatalmale6-alt/niobe-spa-integration/main/deploy/setup.sh -o setup.sh
bash setup.sh
```

This installs Node 22, Nginx, the systemd service (`niobe-pay`), the Nginx site and firewall.

## 2. DNS
Add one record wherever `niobebeauty.com` is managed:

```
Type: A    Host: pay    Value: <server IP>    TTL: default
```

Wait until `dig +short pay.niobebeauty.com` returns the server IP.

## 3. HTTPS
Once DNS resolves:

```bash
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d pay.niobebeauty.com --redirect -m <admin-email> --agree-tos -n
```

Certbot rewrites the Nginx config to serve 443 with a Let's Encrypt cert and auto-renews.

## 4. Configure `.env`
Edit `/opt/niobe-integration/.env` (chmod 600, owned by `niobe`). Production values:

```
DEMO_MODE=false
PAYMENT_DEMO=false
PORT=8080
PUBLIC_URL=https://pay.niobebeauty.com

# SimpleSpa — one Bearer key per branch (Mode 3)
AFRICAN_REGENT_KEY=... ALISA_HOTEL_KEY=... HFC_C18_KEY=... CANTONMENTS_KEY=... EAST_LEGON_KEY=...

# Hubtel (primary) — Basic base64(API-ID:API-Key), account number in body.
# Real values are kept off-repo (in the operator's private credential store).
PAYMENT_GATEWAY=hubtel
HUBTEL_CLIENT_ID=<hubtel-api-id>
HUBTEL_CLIENT_SECRET=<hubtel-api-key>
HUBTEL_MERCHANT_ACCOUNT=<hubtel-collection-account-no>   # note: no leading zeros

# expressPay (backup) — requires this server's IP whitelisted in the expressPay dashboard
PAYMENT_GATEWAY_BACKUP=expresspay
EXPRESSPAY_MERCHANT_ID=... EXPRESSPAY_API_KEY=... EXPRESSPAY_BASE=https://expresspaygh.com/api

# No-show engine (secure-or-release). Deploy in REPORT-ONLY first: it runs the
# sweep and shows candidates on /holds.html but writes NOTHING to SimpleSpa until
# RELEASE_DRY_RUN is flipped to false after the client signs off.
RELEASE_ENABLED=true
RELEASE_DRY_RUN=true
RELEASE_SCOPE=all
RELEASE_GRACE_MINUTES=60
RELEASE_UNTRACKED_GRACE_MINUTES=540
HOTEL_SUNDAY_OPEN=false
NOTIFY_EMAIL=paidforbooking@niobebeauty.com
```

Then: `systemctl restart niobe-pay`

The no-show holds dashboard is at `https://pay.niobebeauty.com/holds.html`. While
`RELEASE_DRY_RUN=true` it is a read-only report; set it to `false` and restart only
after the client has watched the report-only period and approved auto-release.

## 5. Whitelist the server IP with the gateways
- Hubtel: whitelist this server's IP for the Transaction Status API (`api-txnstatus.hubtel.com`)
  — the checkout `initiate` endpoint is not IP-restricted, but the status re-check is.
- expressPay: whitelist this server's IP in the expressPay merchant dashboard (their API is IP-gated).

## 6. Verify
```bash
systemctl status niobe-pay
curl -s https://pay.niobebeauty.com/api/health      # {"ok":true,"demoMode":false,...}
```
Open `https://pay.niobebeauty.com/` (stock dashboard) and `/availability.html`.

## 7. Wire the deposit link into SimpleSpa emails
In each branch's SimpleSpa "Online Booking → Appointment Notification" template, insert a
"Pay your deposit" link pointing to that branch:

```
https://pay.niobebeauty.com/pay?b=<branch>&ph=[CLIENT_PHONE]
```
`<branch>` = `east_legon | cantonments | african_regent | hfc_c18 | alisa_hotel`.

## 8. Staff holds dashboards (auth + office hours)
Two audiences:
- **All-branch central monitor** — `/holds.html` + `/api/holds*`, behind nginx Basic
  Auth (`/etc/nginx/.niobe_htpasswd`, user `niobe`). Not time-restricted. Bookings can
  be Protected here.
- **Per-branch front-desk view** — `/desk/<branchId>` (read-only), each behind its OWN
  nginx login (`/etc/nginx/.niobe_desk_<branchId>`), and gated in-app to office hours
  `DESK_OPEN_HOUR`–`DESK_CLOSE_HOUR` (Ghana=GMT). Outside hours it serves a "closed"
  page and `/desk/<branchId>/sweep` returns 403.

nginx (in the server block, BEFORE `location /`): a safety-net `location /desk/` using
the central `.niobe_htpasswd` (so no `/desk/*` path is ever unauthenticated), then one
`location /desk/<branchId>` per branch pointing at `.niobe_desk_<branchId>`. Create each
htpasswd with `openssl passwd -apr1 '<pass>'` → `echo 'user:HASH' > /etc/nginx/.niobe_desk_<branchId>`.
The dashboards drive **read-only** sweeps, so opening a view never cancels anything — the
background loop is the sole actor.

## Updating later
```bash
cd /opt/niobe-integration && git pull --ff-only && systemctl restart niobe-pay
```
