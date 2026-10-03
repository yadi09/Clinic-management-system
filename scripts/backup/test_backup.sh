#!/usr/bin/env bash
# Proves the backup encryption round-trips, and refuses what it must refuse.
# No server, no bucket: run by scripts/test/regress.sh (static step).
#
# With TEST_DATABASE_URL set it also dumps that (throwaway) database, encrypts the
# dump, opens it again and checks pg_restore can read it: the same path a real
# off-site backup travels.
set -uo pipefail
. "$(dirname "$(readlink -f "$0")")/lib.sh"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fails=0
ok()  { echo "  ✓ $1"; }
bad() { echo "  ✗ $1"; fails=$((fails + 1)); }

head -c 300000 /dev/urandom > "$T/clinic.dump"
export BK_ENCRYPTION_PASSPHRASE="correct horse battery staple"

encrypt_verified "$T/clinic.dump" && ok "encrypts and re-opens before upload" || bad "encrypt_verified failed"
cmp -s "$T/clinic.dump" "$T/clinic.dump.enc" && bad "encrypted copy equals the plain file" || ok "the uploaded copy is not the plain file"
grep -q "  clinic.dump$" "$T/clinic.dump.sha256" && ok "hash file names the backup" || bad "hash file malformed"

decrypt_verified "$T/clinic.dump.enc" "$T/clinic.dump.sha256" "$T/back.dump" && cmp -s "$T/clinic.dump" "$T/back.dump" \
  && ok "restore gives back the identical file" || bad "restore did not give back the identical file"

BK_ENCRYPTION_PASSPHRASE="wrong" decrypt_verified "$T/clinic.dump.enc" "$T/clinic.dump.sha256" "$T/x" \
  && bad "a wrong passphrase was accepted" || ok "a wrong passphrase is refused"
[ ! -e "$T/x" ] && ok "a refused restore leaves no half-file" || bad "a refused restore left a file behind"

cp "$T/clinic.dump.enc" "$T/damaged.enc"; printf 'XXXX' | dd of="$T/damaged.enc" bs=1 seek=150000 conv=notrunc 2>/dev/null
decrypt_verified "$T/damaged.enc" "$T/clinic.dump.sha256" "$T/y" && bad "a damaged backup was accepted" || ok "a damaged backup is refused"

head -c 200000 "$T/clinic.dump.enc" > "$T/short.enc"
decrypt_verified "$T/short.enc" "$T/clinic.dump.sha256" "$T/z" && bad "a cut-off backup was accepted" || ok "a cut-off backup is refused"

BK_ENCRYPTION_PASSPHRASE="" encrypt_verified "$T/clinic.dump" && bad "encrypted with an empty passphrase" || ok "no passphrase, no encryption (and so no upload)"

grep -q 'refusing to upload unencrypted' "$(dirname "$(readlink -f "$0")")/backup.sh" \
  && ok "backup.sh refuses to upload without a passphrase" || bad "backup.sh lost its no-passphrase guard"

if [ -n "${TEST_DATABASE_URL:-}" ] && command -v pg_dump >/dev/null; then
  if pg_dump -Fc "$TEST_DATABASE_URL" > "$T/real.dump" 2>/dev/null; then
    encrypt_verified "$T/real.dump" && decrypt_verified "$T/real.dump.enc" "$T/real.dump.sha256" "$T/real.back" \
      && toc=$(pg_restore --list "$T/real.back") && grep -q 'TABLE DATA public patients ' <<<"$toc" \
      && ok "a real database dump survives the round trip and still lists patients" \
      || bad "a real database dump did not survive the round trip"
  else
    echo "  - skipped the real-dump check: pg_dump could not read TEST_DATABASE_URL"
  fi
fi

[ $fails -eq 0 ] && echo "backup encryption: all checks pass" || { echo "backup encryption: $fails check(s) FAILED"; exit 1; }
