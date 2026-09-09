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

### The two gift-card domains

Niobe owns two other names. **Neither hosts anything — both forward here.**

| domain | what it is | what it should do |
|---|---|---|
| `niobespagiftcard.com` | the retired legacy PHP site, on Hostinger | 301 to `pay.niobebeauty.com/gift-card` via `giftcard-retire/forward.sh` |
| `niobegiftcard.com` | registered defensively 3 Sep 2026 (Hostinger), never used | hPanel → Domain Forwarding → same target |

They forward rather than host on purpose. The checkout stays on a **subdomain of
the domain customers already know**, because that is the part a customer can
actually verify. A standalone gift-card domain is structurally indistinguishable
from one a scammer would register — worth owning so nobody else does, not worth
advertising.

`niobegiftcard.com` needs no files and no hosting plan, only a forwarding rule.
Confirm it took with `curl -sSI https://niobegiftcard.com/ | head -1` — expect a
`301`, not a parking page.

## 3. HTTPS
Once DNS resolves:

```bash
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d pay.niobebeauty.com --redirect -m <admin-email> --agree-tos -n
```

Certbot rewrites the Nginx config to serve 443 with a Let's Encrypt cert and auto-renews.

## 3b. Protect the staff pages

`/holds.html`, `/desk/*`, `/abroad.html` and `/api/intl-payments*` are served through nginx
Basic Auth (`/etc/nginx/.niobe_htpasswd`). `/abroad.html` shows customer names, email
addresses and payment amounts, so it must never be added to the site without its
`auth_basic` block — the app itself does no authentication.

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
# Per branch, so each branch's deposits settle into its own account. BOTH values or
# neither — a branch missing either one falls back to the central account.
{EAST_LEGON,CANTONMENTS,AFRICAN_REGENT,HFC_C18,ALISA_HOTEL}_EXPRESSPAY_MERCHANT_ID=...
{EAST_LEGON,CANTONMENTS,AFRICAN_REGENT,HFC_C18,ALISA_HOTEL}_EXPRESSPAY_API_KEY=...
# Gift cards belong to no branch and settle into their own account. Kept SEPARATE from
# the central fallback on purpose: as the fallback, a branch that lost its own key would
# pay treatment deposits into the gift-card ledger and nobody would notice until
# reconciliation. Separate = that branch just uses Hubtel instead.
GIFTCARD_EXPRESSPAY_MERCHANT_ID=...
GIFTCARD_EXPRESSPAY_API_KEY=...
#
# WARNING: expressPay authenticates on the api-key ALONE and ignores the merchant-id
# it is sent. A key paired with the wrong branch's merchant-id is accepted with
# status 1 "Success" and settles that branch's money into the key owner's account.
# After editing any *_EXPRESSPAY_* line, run this ON THIS SERVER (it is IP-gated):
#     node scripts/check-expresspay-accounts.mjs
# EXPRESSPAY_BASE defaults to the SANDBOX. Real deposits through the sandbox confirm
# bookings nobody paid for, so the adapter refuses to run unless the live base is set
# (override for testing only with EXPRESSPAY_ALLOW_SANDBOX=true).

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

## Monthly payroll (commission report)

```bash
node scripts/payroll-report.mjs 2026-08     # writes data/payroll-2026-08.csv
```

Consolidates every therapist's paid treatments across all five branches into one line
each. Read-only against SimpleSpa.

**It depends on `data/staff-map.json`, which is NOT in this repo and never should be.**
It holds 36 employees' names and commission rates; the repo is public. It is also the
single thing that makes the report correct, so it must be backed up somewhere Niobe
controls — losing it does not break the script, it makes the script quietly pay the
wrong people.

Why it exists: each branch issues its own `staff_id`, so a therapist working two
branches has two ids and the NAME is the only key that joins her work. The names are
not written the same way everywhere, and an appointment stores the therapist's name
**as it stood when the booking was made** — so renaming someone in SimpleSpa never
fixes past months. Aliases in this file do.

```json
{
  "people": [
    { "name": "Priscilla Enyonam Zekpe",
      "aliases": ["priscella zekpe", "princella zekpe", "priscella", "princella"],
      "commissionPct": 10 },
    { "name": "Amelia Nkansah", "former": true, "leftOn": "2026-07-15" }
  ],
  "exclude": ["niobe el service", "niobe staff 1"]
}
```

- `aliases` — every spelling that appears in the appointment history, lower-case. Take
  them from the data, not from memory: scan several months, because a variant can exist
  in June and not in August.
- `exclude` — house and front-desk logins that are not people.
- `former` / `leftOn` — a leaver is still computed, but into her own section, never the
  pay run. `leftOn` also flags work booked under her login after she left.
- An alias must never duplicate another person's name or alias, or the later entry
  silently wins the lookup and one person is paid for another's work.

### Editing the staff list without touching JSON

```bash
node scripts/staff-map-csv.mjs --export                       # -> data/staff-map.csv
node scripts/staff-map-csv.mjs --import data/staff-map.csv    # check it, save nothing
node scripts/staff-map-csv.mjs --import data/staff-map.csv --write
```

JSON is the right storage format and the wrong editing format for anyone who is not a
programmer: one missing comma stops the file parsing, with no clue which line. The CSV
opens in Excel and cannot break that way.

The export also reads the CURRENT staff names live from all five branches, so the sheet
shows which branch spells each therapist which way — which turns "make the names tally"
into reading a column rather than an exercise in memory. Anyone in SimpleSpa but not on
the payroll is listed at the bottom under **NEW**; the house and front-desk logins are
listed separately under **IGNORED ON PURPOSE**, so nobody puts a till account on the pay
run while trying to be helpful.

Import validates and **refuses to write anything at all** if any row is wrong — bad
percentage, bad date format, or, the one that matters, two people claiming the same name
or alias. That last case is why the check exists: one lookup key with two owners means
the later entry silently wins, so one therapist is paid for another's work and nothing on
the payroll looks wrong. Verified by feeding it a deliberately broken sheet: three errors
reported, exit code 2, live list untouched.

Export → import → export is lossless, and `rates` and `exclude` survive a round trip
untouched (neither is editable from the sheet by design).

The report refuses to be quietly wrong: it lists therapists it could not match, names
that may be one person twice, treatments with no rate, and any branch that failed to
answer. Read the `CHECKS` block at the bottom of the CSV before paying from it.

## Updating later
```bash
cd /opt/niobe-integration && git pull --ff-only && systemctl restart niobe-pay
```
