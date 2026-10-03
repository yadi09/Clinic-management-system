# Shared by backup.sh and restore-from-r2.sh, and checked by test_backup.sh.
#
# Every backup leaves the server encrypted: AES-256, the key stretched from
# BK_ENCRYPTION_PASSPHRASE with PBKDF2 (600,000 rounds), next to FILE.sha256, the
# hash of the plain file. Without the passphrase an off-site copy is noise; with
# it, the hash proves the file that comes back is the file that went out.

BK_CIPHER=(-aes-256-cbc -pbkdf2 -iter 600000)

# encrypt_verified FILE: writes FILE.enc and FILE.sha256, then opens FILE.enc
# again and compares hashes, so a copy that could not be opened never gets uploaded.
encrypt_verified() {
  local f="$1" want got
  [ -n "${BK_ENCRYPTION_PASSPHRASE:-}" ] || return 1
  want=$(sha256sum < "$f" | cut -d' ' -f1)
  BK_PASS="$BK_ENCRYPTION_PASSPHRASE" openssl enc "${BK_CIPHER[@]}" -salt \
    -pass env:BK_PASS -in "$f" -out "$f.enc" || return 1
  got=$(BK_PASS="$BK_ENCRYPTION_PASSPHRASE" openssl enc -d "${BK_CIPHER[@]}" \
    -pass env:BK_PASS -in "$f.enc" | sha256sum | cut -d' ' -f1) || return 1
  [ "$want" = "$got" ] || return 1
  echo "$want  $(basename "$f")" > "$f.sha256"
}

# decrypt_verified FILE.enc FILE.sha256 OUT: opens the copy and refuses it unless
# its hash matches the one written when it was made (wrong passphrase, damaged or
# truncated file).
decrypt_verified() {
  local enc="$1" sum="$2" out="$3" want got
  [ -n "${BK_ENCRYPTION_PASSPHRASE:-}" ] || return 1
  want=$(cut -d' ' -f1 < "$sum")
  BK_PASS="$BK_ENCRYPTION_PASSPHRASE" openssl enc -d "${BK_CIPHER[@]}" \
    -pass env:BK_PASS -in "$enc" -out "$out" 2>/dev/null || { rm -f "$out"; return 1; }
  got=$(sha256sum < "$out" | cut -d' ' -f1)
  [ "$want" = "$got" ] || { rm -f "$out"; return 1; }
}
