#!/usr/bin/env bash
# Point niobespagiftcard.com at the live checkout, leaving the retirement gate intact.
#
#   set -a; . ./hostinger.env; set +a; ./forward.sh            # forward the domain
#   set -a; . ./hostinger.env; set +a; ./forward.sh --holding  # back to the holding page
#
# Needs the same variables as apply.sh:
#   FTP_HOST FTP_USER FTP_PASS [FTP_PORT=21]
#   [REMOTE_DIR=/domains/niobespagiftcard.com/public_html]
#   [SITE_URL=https://niobespagiftcard.com] [TARGET=https://pay.niobebeauty.com/gift-card]
#
# This overwrites ONE file, .htaccess, with a variant of itself. It uploads no code
# and touches nothing else, so --holding puts the site back to the state apply.sh
# left it in.
#
# The point of this script is the verification below, not the upload. Turning the
# domain back on is exactly the moment the old application could come back with it,
# so the retired surfaces are re-checked afterwards and a redirect that arrives
# alongside a live api/callback.php is treated as a FAILURE, not a partial success.

set -uo pipefail

: "${FTP_HOST:?FTP_HOST not set}"
: "${FTP_USER:?FTP_USER not set}"
: "${FTP_PASS:?FTP_PASS not set}"
FTP_PORT="${FTP_PORT:-21}"
REMOTE_DIR="${REMOTE_DIR:-/domains/niobespagiftcard.com/public_html}"
SITE_URL="${SITE_URL:-https://niobespagiftcard.com}"
TARGET="${TARGET:-https://pay.niobebeauty.com/gift-card}"
HERE="$(cd "$(dirname "$0")" && pwd)"

lftp_run() {
  lftp -u "$FTP_USER,$FTP_PASS" -p "$FTP_PORT" "ftp://$FTP_HOST" \
       -e "set ssl:verify-certificate no; set net:timeout 20; $1; bye"
}

# Hostinger sits behind its own CDN, so a stale edge copy can make either state look
# like it did not take. Ask for the origin's answer, not a cached one.
code() { curl -s -o /dev/null -w '%{http_code}' -H 'Cache-Control: no-cache' "$1?_=$$"; }
location() { curl -s -o /dev/null -w '%{redirect_url}' -H 'Cache-Control: no-cache' "$1?_=$$"; }

if [ "${1:-}" = "--holding" ]; then
  echo "=== restoring the holding page ==="
  lftp_run "cd '$REMOTE_DIR'; put '$HERE/.htaccess' -o .htaccess" \
    || { echo "FAILED: upload did not complete — the site is UNCHANGED."; exit 1; }
  echo "root=$(code "$SITE_URL/")  api=$(code "$SITE_URL/api/callback.php")"
  echo "Expect root=200 serving holding.html, api=410. Done."
  exit 0
fi

echo "=== forwarding $SITE_URL -> $TARGET ==="
lftp_run "cd '$REMOTE_DIR'; put '$HERE/forward.htaccess' -o .htaccess" \
  || { echo "FAILED: upload did not complete — the site is UNCHANGED."; exit 1; }

echo
echo "--- verifying from the outside ---"
ROOT=$(code "$SITE_URL/")
DEST=$(location "$SITE_URL/")
DEEP=$(code "$SITE_URL/giftcard.html")
API=$(code "$SITE_URL/api/callback.php")
BO=$(code "$SITE_URL/backoffice/login.php")
BOSUB=$(code "https://backoffice.niobespagiftcard.com/login.php")
CRON=$(code "$SITE_URL/cron/orders_cron.php")

echo "root=$ROOT -> $DEST"
echo "giftcard.html=$DEEP  api/callback.php=$API  backoffice/login.php=$BO"
echo "backoffice subdomain=$BOSUB  cron/orders_cron.php=$CRON"

FAIL=0
[ "$ROOT" = "301" ] || { echo "NOT FORWARDED: root answered $ROOT, expected 301."; FAIL=1; }
case "$DEST" in
  "$TARGET"*) ;;
  *) echo "WRONG TARGET: root redirects to '$DEST', expected $TARGET"; FAIL=1;;
esac
[ "$DEEP" = "301" ] || { echo "NOT FORWARDED: an old deep link answered $DEEP, expected 301."; FAIL=1; }

# The gate. A working redirect on a site whose callback is answering again is worse
# than no redirect at all, so these are failures rather than warnings.
[ "$API"   = "410" ] || { echo "GATE BROKEN: api/callback.php answered $API, expected 410."; FAIL=1; }
[ "$BO"    = "410" ] || { echo "GATE BROKEN: backoffice/login.php answered $BO, expected 410."; FAIL=1; }
[ "$BOSUB" = "410" ] || { echo "GATE BROKEN: backoffice subdomain answered $BOSUB, expected 410."; FAIL=1; }
[ "$CRON"  = "410" ] || { echo "GATE BROKEN: cron/orders_cron.php answered $CRON, expected 410."; FAIL=1; }

if [ "$FAIL" -ne 0 ]; then
  echo
  echo "Not done. Put it back with:  $0 --holding"
  exit 2
fi

echo
echo "=== forwarded, and the retirement gate still holds. Reverse with: $0 --holding ==="
echo
echo "Reminder, unaffected by this script: the hPanel cron entries. .htaccess blocks"
echo "the HTTP route to cron/, but the SCHEDULER runs the PHP directly and does not"
echo "go through Apache at all. Until those entries are removed in hPanel > Advanced >"
echo "Cron Jobs, the reminder and expiry emails can still go out to customers."
