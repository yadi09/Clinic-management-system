#!/usr/bin/env bash
# Bring a backup back from the off-site R2 bucket, and prove it opens.
#
#   restore-from-r2.sh                 newest nightly backup: download, decrypt, check
#   restore-from-r2.sh 20261004        that night's backup
#   restore-from-r2.sh --scratch       also load it into a throwaway Postgres and count
#                                      patients, bills and dental visits, then delete it
#   restore-from-r2.sh --with-secrets  also bring back that night's .env + TLS files
#
# It never touches the live database: the real restore steps (stop the API, load the
# file, start again) are in docs/backup-restore.md, done by a person on purpose.
#
# Needs docker, openssl and the r2.env file the backup uses (default
# ~/.config/clinicos-backup/r2.env, or BK_R2_CONF=path). On a new machine after a
# disaster, write that file first from your password manager. If the file has no
# BK_ENCRYPTION_PASSPHRASE, you are asked for it.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"

R2_CONF="${BK_R2_CONF:-$HOME/.config/clinicos-backup/r2.env}"
OUT="${RESTORE_DIR:-$HOME/clinicos-restore}"
DAY="" SCRATCH="" SECRETS=""
for a in "$@"; do
  case "$a" in
    --scratch) SCRATCH=1 ;;
    --with-secrets) SECRETS=1 ;;
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) DAY="$a" ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done

[ -r "$R2_CONF" ] || { echo "no $R2_CONF: write it from your password manager first (docs/backup-restore.md)" >&2; exit 1; }
# shellcheck disable=SC1090
. "$R2_CONF"
if [ -z "${BK_ENCRYPTION_PASSPHRASE:-}" ]; then
  read -rsp "Backup encryption passphrase: " BK_ENCRYPTION_PASSPHRASE; echo
fi
umask 077; mkdir -p "$OUT"

s3() {
  docker run --rm -e AWS_ACCESS_KEY_ID="$BK_R2_ACCESS_KEY_ID" -e AWS_SECRET_ACCESS_KEY="$BK_R2_SECRET_ACCESS_KEY" \
    -e AWS_DEFAULT_REGION=auto -v "$OUT:/data" amazon/aws-cli:2.17.0 \
    s3 "$@" --endpoint-url "https://$BK_R2_ACCOUNT_ID.r2.cloudflarestorage.com"
}

if [ -z "$DAY" ]; then
  DAY=$(s3 ls "s3://$BK_R2_BUCKET/nightly/" | grep -o 'clinic-[0-9]\{8\}\.dump\.enc' | sort | tail -1 | grep -o '[0-9]\{8\}') \
    || { echo "no backups found in r2://$BK_R2_BUCKET/nightly/" >&2; exit 1; }
fi
echo "backup of $DAY"

fetch() { # fetch DIR NAME -> $OUT/NAME, decrypted and checked
  s3 cp "s3://$BK_R2_BUCKET/$1/$2.enc" "/data/$2.enc" --only-show-errors
  s3 cp "s3://$BK_R2_BUCKET/$1/$2.sha256" "/data/$2.sha256" --only-show-errors
  decrypt_verified "$OUT/$2.enc" "$OUT/$2.sha256" "$OUT/$2" \
    || { echo "✗ $2 did not decrypt to the file that was backed up (wrong passphrase, or damaged)" >&2; exit 1; }
  rm -f "$OUT/$2.enc"
  echo "✓ $OUT/$2 ($(du -h "$OUT/$2" | cut -f1)), hash matches the night it was made"
}

DUMP="clinic-$DAY.dump"
fetch nightly "$DUMP"
toc=$(docker run --rm -i postgres:16-alpine pg_restore --list < "$OUT/$DUMP") || { echo "✗ not a readable database dump" >&2; exit 1; }
grep -q 'TABLE DATA public patients ' <<<"$toc" || { echo "✗ dump has no patients data" >&2; exit 1; }
echo "✓ readable: $(grep -c 'TABLE DATA' <<<"$toc") tables of data"

[ -n "$SECRETS" ] && fetch secrets "secrets-$DAY.tgz"

if [ -n "$SCRATCH" ]; then
  name="clinicos-restore-check-$$"
  trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
  docker run -d --name "$name" -e POSTGRES_PASSWORD=check -e POSTGRES_DB=clinic postgres:16-alpine >/dev/null
  until docker exec "$name" pg_isready -U postgres -q 2>/dev/null; do sleep 1; done
  sleep 2
  # The dump names roles (clinic_app); a scratch server lacks them, so ownership and
  # grants are skipped: the data is what is being proven.
  docker exec -i "$name" pg_restore -U postgres -d clinic --no-owner --no-privileges < "$OUT/$DUMP" \
    || echo "  (pg_restore reported warnings; checking the data anyway)"
  docker exec "$name" psql -U postgres -d clinic -Atc "
    SELECT 'clinics',  count(*) FROM tenants UNION ALL
    SELECT 'patients', count(*) FROM patients UNION ALL
    SELECT 'bills',    count(*) FROM charges UNION ALL
    SELECT 'dental visits', count(*) FROM treatment_sessions" | sed 's/|/: /; s/^/  /'
  echo "✓ loaded into a throwaway database, which is now deleted"
fi
