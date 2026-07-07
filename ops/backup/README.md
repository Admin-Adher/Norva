# Offsite DB backup → Cloudflare R2

A scheduled, **read-only** logical backup of the managed Supabase database into a
private R2 bucket. It runs entirely from GitHub Actions — no server needed — so
it works **today**, before the Hetzner box exists.

**Double benefit**
1. **Offsite insurance now.** Independent of Supabase's own PITR/backups. If the
   Supabase account is ever lost or locked, this archive is a full logical restore
   point sitting in *your* storage.
2. **It IS the migration dump.** The archive unpacks to `00-globals.sql`,
   `01-schema.sql`, `02-data.sql` — exactly what `ops/hetzner/scripts/02-restore-hetzner.sh`
   consumes. Running it on a schedule means the Hetzner cutover dump is already
   automated and *proven* the day the box arrives. (Same dump flags as
   `ops/hetzner/scripts/01-dump-prod.sh`.)

Files:
- `backup-to-r2.sh` — the dump + compress + (optional) encrypt + upload script.
- `../../.github/workflows/backup-db-to-r2.yml` — daily 03:15 UTC + manual run.

---

## One-time setup (≈10 min, all in dashboards)

### 1. Create the R2 bucket
Cloudflare dashboard → **R2** → *Create bucket* → name e.g. `norva-db-backups`
→ Location: **Automatic** → Create. Leave it **private** (default).

### 2. Create an R2 API token (scoped to this bucket)
R2 → **Manage R2 API Tokens** → *Create API token*
- Permissions: **Object Read & Write**
- Specify bucket(s): **norva-db-backups** only (least privilege)
- Create → copy the **Access Key ID** and **Secret Access Key** (shown once).
- Note your **Account ID** (R2 overview page, or the S3 endpoint host prefix).

### 3. (Optional but recommended) Create an age key for encryption
Belt-and-suspenders on top of the private bucket, so even a misconfigured ACL
never exposes plaintext DB rows.
```bash
age-keygen -o norva-backup.key      # prints the PUBLIC key (age1...)
# Keep norva-backup.key OFFLINE and safe — it is the ONLY way to decrypt.
```
Put the **public** key (age1…) in the secret below; keep the private key file out
of the repo and out of CI.

### 4. Add the GitHub secrets
Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|---|---|
| `SUPABASE_DB_URL` | **Session pooler** URI (see note) |
| `R2_ACCOUNT_ID` | Cloudflare account id |
| `R2_ACCESS_KEY_ID` | from step 2 |
| `R2_SECRET_ACCESS_KEY` | from step 2 |
| `R2_BUCKET` | `norva-db-backups` |
| `BACKUP_AGE_RECIPIENT` | *(optional)* the `age1…` public key from step 3 |

> **Use the Session pooler URI**, not the direct connection. Supabase dashboard →
> *Project Settings → Database → Connection string → **Session pooler***. It looks
> like `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`.
> Why: GitHub runners are **IPv4-only** and the direct host is often IPv6-only; and
> the **transaction** pooler (port 6543) doesn't support `pg_dump`. The session
> pooler (5432) is IPv4 *and* pg_dump-compatible.

### 5. Test it
Repo → **Actions → Offsite DB backup to R2 → Run workflow**. Watch it go green,
then confirm the object exists in the R2 bucket (`db/norva-db-YYYYMMDD-HHMMSS.tar.gz[.age]`).

---

## Retention

Keep costs flat with an R2 **lifecycle rule** (bucket → Settings → Object lifecycle
rules): e.g. *delete objects older than 30 days* under prefix `db/`. R2 storage is
~$0.015/GB-month and **egress is free**, so a month of a few-GB dumps is cents.

## Restore / verify

```bash
ENDPOINT="https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com"
aws s3 cp s3://norva-db-backups/db/norva-db-YYYYMMDD-HHMMSS.tar.gz.age . --endpoint-url "$ENDPOINT"

# If encrypted:
age -d -i norva-backup.key norva-db-YYYYMMDD-HHMMSS.tar.gz.age > dump.tar.gz
tar -xzf dump.tar.gz && cd norva-db-YYYYMMDD-HHMMSS
sha256sum -c SHA256SUMS       # integrity check

# Into a fresh Postgres (or the Hetzner stack — 02-restore-hetzner.sh does this):
psql "$TARGET_DB_URL" -f 00-globals.sql
psql "$TARGET_DB_URL" -f 01-schema.sql
psql "$TARGET_DB_URL" -f 02-data.sql
```

## Notes / scope

- **Read-only**: the script only runs `pg_dump`/`pg_dumpall`/`psql -c select`. It
  never writes to the source DB.
- **Scope**: globals (roles + role GUCs) + `public` schema + `public` data +
  reference exports (cron jobs, extensions). Supabase-managed schemas
  (`auth`/`storage`/`realtime`/`vault`/`cron`) are recreated by the self-host
  images/extensions on restore, exactly as in the migration runbook — this is a
  *logical app* backup, not a byte-for-byte cluster clone.
- **Local run**: the same script works from any machine with a v17 `pg_dump`, `age`
  and `aws-cli` — export the env vars and `bash ops/backup/backup-to-r2.sh`.
