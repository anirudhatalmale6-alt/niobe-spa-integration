#!/usr/bin/env bash
# Full backup of the Hostinger-hosted site — files, then database — taken BEFORE
# any change is made to it. Nothing here writes to the server; it only reads.
#
# Credentials come from the environment, never from this file:
#   FTP_HOST FTP_USER FTP_PASS [FTP_PORT=21] [REMOTE_DIR=/public_html]
#   optional, only if the plan has SSH:  SSH_HOST SSH_PORT SSH_USER
#
#   set -a; . ./hostinger.env; set +a; ./deploy/hostinger-backup.sh
#
# A backup is worthless until it has been opened. This script therefore does not
# report success on "the transfer finished" — it counts what arrived, compares it
# against what the server said was there, and fails loudly on a mismatch.

set -uo pipefail

: "${FTP_HOST:?FTP_HOST not set}"
: "${FTP_USER:?FTP_USER not set}"
: "${FTP_PASS:?FTP_PASS not set}"
FTP_PORT="${FTP_PORT:-21}"
REMOTE_DIR="${REMOTE_DIR:-/public_html}"

# Refuse to pull an unexpectedly large site: disk here is shared with other work.
MAX_MB="${MAX_MB:-1024}"

STAMP="$(date +%F-%H%M)"
DEST="${DEST:-/var/lib/freelancer/projects/40608868/backups/hostinger-$STAMP}"
mkdir -p "$DEST/files"
LOG="$DEST/backup.log"
exec > >(tee -a "$LOG") 2>&1

echo "=== Hostinger backup $STAMP ==="
echo "host=$FTP_HOST port=$FTP_PORT user=$FTP_USER remote=$REMOTE_DIR"
echo "dest=$DEST"

lftp_run() { lftp -u "$FTP_USER,$FTP_PASS" -p "$FTP_PORT" "ftp://$FTP_HOST" -e "set ssl:verify-certificate no; $1; bye"; }

# --- 0. Prove the login works and the folder is the right one ------------------
echo; echo "--- remote top level ---"
lftp_run "cd '$REMOTE_DIR'; cls -l --sort=name" || { echo "FAILED: cannot list $REMOTE_DIR"; exit 1; }

# --- 1. Size check BEFORE transferring ----------------------------------------
echo; echo "--- measuring ---"
REMOTE_BYTES=$(lftp_run "cd '$REMOTE_DIR'; du -bs ." 2>/dev/null | awk 'NR==1{print $1}')
if [ -n "${REMOTE_BYTES:-}" ] && [ "$REMOTE_BYTES" -gt 0 ] 2>/dev/null; then
  REMOTE_MB=$(( REMOTE_BYTES / 1048576 ))
  echo "remote size: ${REMOTE_MB} MB"
  if [ "$REMOTE_MB" -gt "$MAX_MB" ]; then
    echo "REFUSING: ${REMOTE_MB} MB exceeds MAX_MB=${MAX_MB}. Use Hostinger's own"
    echo "backup/export for the bulk, or raise MAX_MB deliberately."
    exit 2
  fi
else
  echo "WARNING: server would not report a size (du unsupported) — continuing, but"
  echo "watch the transfer; it is not bounded by the check above."
fi

# --- 2. Mirror ----------------------------------------------------------------
echo; echo "--- mirroring ---"
lftp_run "cd '$REMOTE_DIR'; mirror --continue --parallel=3 --exclude-glob .git/ . '$DEST/files'"
MIRROR_RC=$?

# --- 3. Verify what actually arrived ------------------------------------------
echo; echo "--- verifying ---"
LOCAL_N=$(find "$DEST/files" -type f | wc -l)
LOCAL_MB=$(du -sm "$DEST/files" | awk '{print $1}')
REMOTE_N=$(lftp_run "cd '$REMOTE_DIR'; find" 2>/dev/null | grep -vc '/$')
echo "files local=$LOCAL_N  remote=$REMOTE_N  size=${LOCAL_MB} MB  mirror_rc=$MIRROR_RC"

if [ "$LOCAL_N" -eq 0 ]; then
  echo "FAILED: nothing was downloaded. This backup does not exist — do not proceed."
  exit 3
fi
if [ -n "${REMOTE_N:-}" ] && [ "$REMOTE_N" -gt 0 ] 2>/dev/null && [ "$LOCAL_N" -lt "$REMOTE_N" ]; then
  echo "FAILED: $LOCAL_N of $REMOTE_N files arrived. A partial backup that reports"
  echo "success is worse than none. Re-run before changing anything."
  exit 4
fi

# --- 4. Database --------------------------------------------------------------
# Hostinger blocks remote MySQL from unlisted IPs, so the dump is taken over SSH
# when the plan has it. Otherwise it must be exported from hPanel by hand — and
# that is stated as an OUTSTANDING step, never assumed done.
echo; echo "--- database ---"
CFG=$(find "$DEST/files" -maxdepth 2 -name wp-config.php -o -maxdepth 2 -name 'config*.php' | head -1)
if [ -n "$CFG" ]; then
  echo "found config: ${CFG#$DEST/files/}  (DB name/user/host read from it, not printed here)"
  DB_NAME=$(grep -oP "DB_NAME'\s*,\s*'\K[^']+" "$CFG" | head -1)
  DB_USER=$(grep -oP "DB_USER'\s*,\s*'\K[^']+" "$CFG" | head -1)
  DB_PASS=$(grep -oP "DB_PASSWORD'\s*,\s*'\K[^']+" "$CFG" | head -1)
else
  echo "no wp-config.php/config*.php found at the top level — identify the DB by hand"
fi

if [ -n "${SSH_HOST:-}" ] && [ -n "${DB_NAME:-}" ]; then
  echo "dumping $DB_NAME over SSH..."
  sshpass -p "$FTP_PASS" ssh -o StrictHostKeyChecking=no -p "${SSH_PORT:-65002}" \
    "${SSH_USER:-$FTP_USER}@$SSH_HOST" \
    "mysqldump --single-transaction --routines --triggers -u'$DB_USER' -p'$DB_PASS' '$DB_NAME'" \
    | gzip > "$DEST/$DB_NAME-$STAMP.sql.gz"
  # gzip -t passes on an EMPTY archive, so count rows instead of trusting the format.
  TABLES=$(zcat "$DEST/$DB_NAME-$STAMP.sql.gz" 2>/dev/null | grep -c '^CREATE TABLE')
  BYTES=$(stat -c %s "$DEST/$DB_NAME-$STAMP.sql.gz" 2>/dev/null || echo 0)
  echo "dump: ${BYTES} bytes, $TABLES CREATE TABLE statements"
  [ "$TABLES" -eq 0 ] && { echo "FAILED: the dump contains no tables. Treat the DB as NOT backed up."; exit 5; }
else
  echo "OUTSTANDING: no SSH — export the database from hPanel > Databases >"
  echo "phpMyAdmin > Export (Custom, gzip) and place the .sql.gz beside this log."
  echo "The file backup above is complete; the DB backup is NOT."
fi

echo; echo "=== done: $DEST ==="
