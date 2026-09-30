#!/usr/bin/env bash
# Deploy ClinicOS on the VPS from the git repository.
#
#   scripts/deploy/deploy.sh [branch]     deploy origin/<branch> (default refine/clinic-ops)
#   scripts/deploy/deploy.sh --rollback   put the previous deploy's images back
#
# Run this ON the server. It moves the checkout to a commit, rebuilds the images,
# migrates, and restarts — so what is running can always be traced back to a
# commit instead of to whatever happened to be in somebody's working tree.
#
# Three files on this machine exist nowhere else and are not in git:
#
#   .env                the database password and every API key
#   infra/origin.crt    the origin certificate Caddy serves
#   infra/origin.key    its private key
#
# They are untracked, so `git reset --hard` leaves them alone — but `git clean`
# would not, and neither would a fresh clone into an empty directory. This script
# refuses to run if any of them is missing rather than rebuilding a server that
# cannot then start, and it never cleans.
#
# Patient data lives in the clinicos_pgdata Docker volume. A deploy runs
# migrations against it, so every deploy first takes a full dump into
# $BACKUP_DIR and refuses to go on if that dump is empty or unreadable. The dump
# is taken as the database owner (POSTGRES_USER), never as clinic_app: row-level
# security would hand clinic_app an almost empty file that still looks like a
# backup.
#
# Rollback. Before building, the images currently running are tagged :prev and
# their commit is written to .deploy-prev. `--rollback` puts those images back
# and the checkout back to that commit. It does NOT undo migrations — most down
# migrations drop data. If a migration itself is the problem, restore the
# pre-deploy dump instead (the path is printed below).
set -euo pipefail

cd "$(dirname "$0")/../.."
COMPOSE="docker compose -p clinicos -f compose.yml -f compose.cohost.yml -f compose.standalone.yml"
IMAGES="api web worker migrate"
BACKUP_DIR="${BACKUP_DIR:-$HOME/clinicos-backups/predeploy}"
KEEP_DUMPS="${KEEP_DUMPS:-10}"
PG="clinicos-postgres-1"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# health waits up to a minute for the API itself to answer ready. Probing "/"
# only proved Caddy could serve the static page — a dead API passed.
health() {
  say "Health"
  local body=""
  for _ in $(seq 1 30); do
    body=$(curl -k -s --max-time 3 -H 'Host: app.clinicos.cc' https://localhost:8443/readyz || true)
    case "$body" in *'"ready"'*) break ;; esac
    sleep 2
  done
  $COMPOSE ps --format '  {{.Service}}\t{{.Status}}'
  case "$body" in
    *'"ready"'*) echo "  api: ready" ;;
    *) echo "  api is NOT ready (last answer: ${body:-none}) — check: docker logs clinicos-api-1"
       echo "  to go back: scripts/deploy/deploy.sh --rollback"
       exit 1 ;;
  esac
}

if [ "${1:-}" = "--rollback" ]; then
  [ -s .deploy-prev ] || { echo "No .deploy-prev — nothing recorded to roll back to."; exit 1; }
  PREV=$(cat .deploy-prev)
  for s in $IMAGES; do
    docker image inspect "clinicos-$s:prev" >/dev/null 2>&1 \
      || { echo "MISSING: clinicos-$s:prev — cannot roll back."; exit 1; }
  done
  say "Rolling back to $PREV (migrations are NOT undone)"
  for s in $IMAGES; do docker tag "clinicos-$s:prev" "clinicos-$s:latest"; done
  git reset --hard "$PREV"
  $COMPOSE up -d --no-build
  health
  say "Rolled back to $PREV"
  exit 0
fi

BRANCH="${1:-refine/clinic-ops}"

say "Checking the things that are not in git"
for f in .env infra/origin.crt infra/origin.key; do
  [ -s "$f" ] || { echo "MISSING: $f — refusing to deploy. Restore it first."; exit 1; }
  echo "  ok  $f"
done

say "Backing up the database"
mkdir -p "$BACKUP_DIR" && chmod 700 "$BACKUP_DIR"
DUMP="$BACKUP_DIR/clinic-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker exec "$PG" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$DUMP"
chmod 600 "$DUMP"
# Proof it is a real dump, not just a non-empty file: pg_restore must be able to
# read its table of contents, and it must contain the patients table's data.
toc=$(docker exec -i "$PG" pg_restore --list < "$DUMP") \
  || { echo "BACKUP UNREADABLE: $DUMP — refusing to deploy."; exit 1; }
tables=$(grep -c 'TABLE DATA' <<<"$toc" || true)
grep -q 'TABLE DATA public patients ' <<<"$toc" \
  || { echo "BACKUP INCOMPLETE (no patients data): $DUMP — refusing to deploy."; exit 1; }
echo "  $DUMP ($(du -h "$DUMP" | cut -f1), $tables tables)"
ls -1t "$BACKUP_DIR"/clinic-*.dump | tail -n +"$((KEEP_DUMPS + 1))" | xargs -r rm -f

say "Fetching $BRANCH"
git fetch origin "$BRANCH"
BEFORE=$(git rev-parse --short HEAD 2>/dev/null || echo "none")

say "Keeping the running images for rollback"
for s in $IMAGES; do
  if docker image inspect "clinicos-$s:latest" >/dev/null 2>&1; then
    docker tag "clinicos-$s:latest" "clinicos-$s:prev"
    echo "  clinicos-$s:latest -> :prev"
  fi
done
echo "$BEFORE" > .deploy-prev

git reset --hard "origin/$BRANCH"
AFTER=$(git rev-parse --short HEAD)
echo "  $BEFORE -> $AFTER"
git --no-pager log -1 --format='  %s%n  by %an, %ar'

say "Building"
$COMPOSE build

say "Migrating"
$COMPOSE run --rm migrate

say "Restarting"
$COMPOSE up -d

health

say "Deployed $AFTER"
echo "  pre-deploy backup: $DUMP"
echo "  undo:              scripts/deploy/deploy.sh --rollback"
