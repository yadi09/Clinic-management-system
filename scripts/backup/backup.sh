#!/usr/bin/env bash
# Nightly backup of ClinicOS. Run by cron on the VPS:
#
#   30 23 * * *  /home/themillions/clinicos/scripts/backup/backup.sh >> $HOME/clinicos-backups/backup.log 2>&1
#
# (23:30 UTC = 02:30 Addis, the quietest hour.)
#
# What it keeps, under $BACKUP_ROOT (default ~/clinicos-backups):
#
#   nightly/clinic-YYYYMMDD.dump     the last 14 nights
#   weekly/clinic-YYYYMMDD.dump      one per Sunday, the last 8 weeks
#   secrets/secrets-YYYYMMDD.tgz     .env + infra/origin.* — without these a
#                                    restored database has no server to run on
#   LAST_OK                          when the last good backup finished
#
# A copy on the same disk does not survive the disk. So when
# ~/.config/clinicos-backup/r2.env exists, every night's files are also uploaded
# to a separate, private R2 bucket. That file is NOT the app's R2 key: the app's
# key can presign any object in its own bucket, and its storage keys are not yet
# fully checked (audit D24), so backups must never sit where the app can reach.
# The file holds, and only this user may read it (chmod 600):
#
#   BK_R2_ACCOUNT_ID=...        BK_R2_ACCESS_KEY_ID=...
#   BK_R2_SECRET_ACCESS_KEY=... BK_R2_BUCKET=clinicos-backups
#   BK_ENCRYPTION_PASSPHRASE=...  required: every file is encrypted with it before
#                               it leaves this server (a leaked bucket reads as
#                               noise). Keep a copy OFF this server too: if the
#                               server dies, the backup cannot be opened without it.
#   BK_HEARTBEAT_URL=...        optional: pinged only after a fully good run,
#                               so a monitor notices the night it does NOT come
#
# Restore: scripts/backup/restore-from-r2.sh (see docs/backup-restore.md).
#
# The dump is taken as the database owner, never as clinic_app: row-level
# security would hand clinic_app an almost empty file that still looks like a
# backup. It is then proven readable, and must contain the patients table.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"

APP_DIR="${APP_DIR:-/home/themillions/clinicos}"
BACKUP_ROOT="${BACKUP_ROOT:-$HOME/clinicos-backups}"
PG="clinicos-postgres-1"
R2_CONF="$HOME/.config/clinicos-backup/r2.env"
DAY=$(date -u +%Y%m%d)

log() { echo "$(date -u +%FT%TZ) $*"; }
fail() { log "FAILED: $*"; exit 1; }
# Anything else that stops the run must say so in the log, never stop silently.
trap 'rc=$?; [ $rc -eq 0 ] || log "FAILED: line $LINENO exited $rc"' EXIT

umask 077
mkdir -p "$BACKUP_ROOT"/{nightly,weekly,secrets}
chmod 700 "$BACKUP_ROOT"

DUMP="$BACKUP_ROOT/nightly/clinic-$DAY.dump"
docker exec "$PG" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$DUMP.part" \
  || fail "pg_dump"
toc=$(docker exec -i "$PG" pg_restore --list < "$DUMP.part") || fail "dump unreadable"
grep -q 'TABLE DATA public patients ' <<<"$toc" || fail "dump has no patients data"
mv "$DUMP.part" "$DUMP"
log "dump ok: $DUMP ($(du -h "$DUMP" | cut -f1), $(grep -c 'TABLE DATA' <<<"$toc") tables)"

SECRETS="$BACKUP_ROOT/secrets/secrets-$DAY.tgz"
tar czf "$SECRETS" -C "$APP_DIR" .env infra/origin.crt infra/origin.key || fail "secrets archive"

# Sunday: keep a weekly copy that outlives the 14-day window.
[ "$(date -u +%u)" = "7" ] && cp "$DUMP" "$BACKUP_ROOT/weekly/clinic-$DAY.dump"

# prune DIR PATTERN KEEP — delete all but the newest KEEP files matching PATTERN.
# An empty directory is not an error: `ls` would exit 2 and, under pipefail, end
# the whole run silently before it ever reached the upload.
prune() {
  local files
  files=$(ls -1t "$1"/$2 2>/dev/null) || return 0
  tail -n +"$(( $3 + 1 ))" <<<"$files" | xargs -r rm -f
}
prune "$BACKUP_ROOT/nightly" 'clinic-*.dump' 14
prune "$BACKUP_ROOT/weekly"  'clinic-*.dump' 8
prune "$BACKUP_ROOT/secrets" 'secrets-*.tgz' 14


if [ -r "$R2_CONF" ]; then
  # shellcheck disable=SC1090
  . "$R2_CONF"
  # Never upload a readable copy of every patient's record: no passphrase, no upload.
  [ -n "${BK_ENCRYPTION_PASSPHRASE:-}" ] || fail "BK_ENCRYPTION_PASSPHRASE missing from $R2_CONF: refusing to upload unencrypted"
  for f in "$DUMP" "$SECRETS"; do
    encrypt_verified "$f" || fail "encrypt $(basename "$f")"
    for g in "$f.enc" "$f.sha256"; do
      docker run --rm \
        -e AWS_ACCESS_KEY_ID="$BK_R2_ACCESS_KEY_ID" -e AWS_SECRET_ACCESS_KEY="$BK_R2_SECRET_ACCESS_KEY" \
        -e AWS_DEFAULT_REGION=auto -v "$(dirname "$g"):/data:ro" amazon/aws-cli:2.17.0 \
        s3 cp "/data/$(basename "$g")" "s3://$BK_R2_BUCKET/$(basename "$(dirname "$g")")/$(basename "$g")" \
        --endpoint-url "https://$BK_R2_ACCOUNT_ID.r2.cloudflarestorage.com" --only-show-errors \
        || fail "upload $(basename "$g") to R2"
    done
    rm -f "$f.enc" "$f.sha256"
  done
  log "uploaded to r2://$BK_R2_BUCKET"
  offsite="yes"
else
  log "WARNING: no $R2_CONF — this backup exists on this server only"
  offsite="no"
fi

date -u +%FT%TZ > "$BACKUP_ROOT/LAST_OK"
if [ "$offsite" = "yes" ] && [ -n "${BK_HEARTBEAT_URL:-}" ]; then
  curl -fsS --max-time 10 "$BK_HEARTBEAT_URL" >/dev/null || log "heartbeat ping failed"
fi
log "done (offsite: $offsite)"
