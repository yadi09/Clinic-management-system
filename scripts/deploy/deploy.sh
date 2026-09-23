#!/usr/bin/env bash
# Deploy ClinicOS on the VPS from the git repository.
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
# Patient data is not here at all: it lives in the clinicos_pgdata Docker volume,
# which nothing in this script touches.
set -euo pipefail

cd "$(dirname "$0")/../.."
BRANCH="${1:-refine/clinic-ops}"
COMPOSE="docker compose -p clinicos -f compose.yml -f compose.cohost.yml -f compose.standalone.yml"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

say "Checking the things that are not in git"
for f in .env infra/origin.crt infra/origin.key; do
  [ -s "$f" ] || { echo "MISSING: $f — refusing to deploy. Restore it first."; exit 1; }
  echo "  ok  $f"
done

say "Fetching $BRANCH"
git fetch origin "$BRANCH"
BEFORE=$(git rev-parse --short HEAD 2>/dev/null || echo "none")
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

say "Health"
sleep 4
$COMPOSE ps --format '  {{.Service}}\t{{.Status}}'
code=$(curl -k -s -o /dev/null -w '%{http_code}' -H 'Host: app.clinicos.cc' https://localhost:8443/ || echo 000)
echo "  app responds: $code"
[ "$code" = "200" ] || { echo "  the app is not answering — check: docker logs clinicos-api-1"; exit 1; }

say "Deployed $AFTER"
