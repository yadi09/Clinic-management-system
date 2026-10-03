# Backups: where they are, and how to bring them back

## What happens every night

At 02:30 Addis, `scripts/backup/backup.sh` runs on the server:

1. It saves the whole database and checks the file opens and contains patients.
2. It saves the server's secrets: `.env` plus the TLS certificate and key.
3. It keeps 14 nightly copies and 8 Sunday copies on the server.
4. It encrypts both files with your backup passphrase, opens them again to prove they decrypt, and uploads them to the private R2 bucket `clinicos-backups`.
5. Only after a fully good night does it ping the heartbeat monitor, if one is set. A silent night is how you find out something broke.

The log is `~/clinicos-backups/backup.log` on the server. Its last line should end `done (offsite: yes)`.

## The three things that must survive the server

Keep all three in your password manager, **not only on the server**:

| What | Why |
|---|---|
| R2 account ID, access key ID, secret access key | to download the backups |
| `BK_ENCRYPTION_PASSPHRASE` | without it the backups are unreadable noise, even to you |
| the file `~/.config/clinicos-backup/r2.env` (it holds all of the above) | the restore script reads it |

## Check a backup (safe, any time)

Run this on the server, or on any machine with Docker after writing `r2.env`:

```bash
scripts/backup/restore-from-r2.sh --scratch
```

It downloads the newest backup, decrypts it, checks the hash matches the night it was made, and loads it into a throwaway database. It prints how many clinics, patients, bills and dental visits are in it, then deletes that database. **The live system is never touched.** Do this once a month. A backup nobody has restored is only a hope.

Add a date (`restore-from-r2.sh 20261004 --scratch`) to check one particular night.

## Real restore (the server or its disk is lost)

Do this calmly, one step at a time.

1. **Get a server** with Docker, then copy the code onto it as for a normal deploy.
2. **Write `~/.config/clinicos-backup/r2.env`** from your password manager, then run `chmod 600` on it.
3. **Bring the backup back with the secrets:**

   ```bash
   scripts/backup/restore-from-r2.sh --with-secrets
   ```

   The files land in `~/clinicos-restore/`.
4. **Put the secrets in place:**

   ```bash
   tar xzf ~/clinicos-restore/secrets-<DAY>.tgz -C ~/clinicos
   ```

   This restores `.env` and `infra/origin.*`.
5. **Start only the database:**

   ```bash
   docker compose up -d postgres
   ```

6. **Load the backup:**

   ```bash
   docker exec -i clinicos-postgres-1 sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' \
     < ~/clinicos-restore/clinic-<DAY>.dump
   ```

7. **Start everything:**

   ```bash
   docker compose up -d
   ```

   Then open `https://app.clinicos.cc/readyz`. It should say `ready`.
8. **Sign in as a clinic** and check that yesterday's patients and payments are there. Anything entered after 02:30 that night must be re-entered from paper.
9. **Point DNS** at the new server, if the IP changed.

To roll back one bad change on a healthy server, do not overwrite the live database. Restore into `--scratch`, find the rows you need, and copy them back by hand.
