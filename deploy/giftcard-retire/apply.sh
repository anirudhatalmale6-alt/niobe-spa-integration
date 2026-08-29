#!/usr/bin/env bash
# Put the legacy niobespagiftcard.com application behind a holding page.
#
#   set -a; . ./hostinger.env; set +a; ./apply.sh          # shut it
#   set -a; . ./hostinger.env; set +a; ./apply.sh --revert  # put it back
#
# Needs: FTP_HOST FTP_USER FTP_PASS [FTP_PORT=21]
#        [REMOTE_DIR=/domains/niobespagiftcard.com/public_html]
#        [SITE_URL=https://niobespagiftcard.com]
#
# This uploads TWO new files and overwrites nothing. Reverting deletes the
# .htaccess, at which point the site is byte-for-byte what it was.
#
# Do not run this until the database dump exists and has been counted. Shutting
# the door is reversible; being unable to read what was behind it is not.

set -uo pipefail

: "${FTP_HOST:?FTP_HOST not set}"
: "${FTP_USER:?FTP_USER not set}"
: "${FTP_PASS:?FTP_PASS not set}"
FTP_PORT="${FTP_PORT:-21}"
REMOTE_DIR="${REMOTE_DIR:-/domains/niobespagiftcard.com/public_html}"
SITE_URL="${SITE_URL:-https://niobespagiftcard.com}"
HERE="$(cd "$(dirname "$0")" && pwd)"

lftp_run() {
  lftp -u "$FTP_USER,$FTP_PASS" -p "$FTP_PORT" "ftp://$FTP_HOST" \
       -e "set ssl:verify-certificate no; set net:timeout 20; $1; bye"
}

# Hostinger sits behind its own CDN, so a stale edge copy can make either state
# look like it did not take. Ask for the origin's answer, not a cached one.
code() { curl -s -o /dev/null -w '%{http_code}' -H 'Cache-Control: no-cache' "$1?_=$$"; }

if [ "${1:-}" = "--revert" ]; then
  echo "=== reverting: removing .htaccess and holding.html ==="
  lftp_run "cd '$REMOTE_DIR'; rm -f .htaccess; rm -f holding.html"
  echo "root=$(code "$SITE_URL/")  api=$(code "$SITE_URL/api/callback.php")"
  echo "Expect the site to behave exactly as before. Done."
  exit 0
fi

echo "=== shutting the legacy gift-card application ==="
lftp_run "cd '$REMOTE_DIR'; put -O . '$HERE/holding.html'; put -O . '$HERE/.htaccess'" \
  || { echo "FAILED: upload did not complete — the site is UNCHANGED."; exit 1; }

echo
echo "--- verifying from the outside ---"
# A deploy is not proven by the upload succeeding. These three must all hold, and
# the callback one is the whole point of the exercise.
ROOT=$(code "$SITE_URL/")
API=$(code "$SITE_URL/api/callback.php")
BO=$(code "$SITE_URL/backoffice/login.php")
CRON=$(code "$SITE_URL/cron/orders_cron.php")
HOLD=$(curl -s -H 'Cache-Control: no-cache' "$SITE_URL/?_=$$" | grep -ci "gift card service is being moved")

echo "root=$ROOT  api/callback.php=$API  backoffice/login.php=$BO  cron/orders_cron.php=$CRON"
echo "holding page served at root: $HOLD"

FAIL=0
[ "$API"  = "410" ] || { echo "NOT SHUT: api/callback.php answered $API, expected 410."; FAIL=1; }
[ "$BO"   = "410" ] || { echo "NOT SHUT: backoffice/login.php answered $BO, expected 410."; FAIL=1; }
[ "$CRON" = "410" ] || { echo "NOT SHUT: cron/orders_cron.php answered $CRON, expected 410."; FAIL=1; }
[ "$HOLD" -ge 1 ]   || { echo "NOT SHUT: the root is not serving the holding page."; FAIL=1; }

if [ "$FAIL" -ne 0 ]; then
  echo
  echo "The gate is NOT in place. Most likely mod_rewrite is off, or the host"
  echo "ignores .htaccess in this directory. Do not report this as done."
  echo "Revert with:  $0 --revert"
  exit 2
fi

echo
echo "=== shut, and verified from outside. Reverse with: $0 --revert ==="
echo "Still outstanding: the hPanel cron entries. .htaccess blocks the HTTP route"
echo "to cron/, but the SCHEDULER runs the PHP file directly and is unaffected —"
echo "those must be removed in hPanel > Advanced > Cron Jobs (or via crontab -r"
echo "over SSH), or the reminder and expiry emails keep going out."
