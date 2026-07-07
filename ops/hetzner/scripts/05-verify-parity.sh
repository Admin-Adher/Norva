#!/usr/bin/env bash
# =============================================================================
# 05-verify-parity.sh — prove the self-host DB matches the managed one
# =============================================================================
# Compares managed (source) vs self-host (target) on the things that silently
# break a migration: row counts, extensions, cron jobs, RLS policies, role GUCs,
# and the couche-B dual-write flag. Run BEFORE cutting DNS over.
#
#   MANAGED_DB_URL and the local TARGET both come from ops/hetzner/.env, or pass:
#     SRC="postgresql://...managed..." DST="postgresql://...selfhost..." \
#       scripts/05-verify-parity.sh
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$HERE/.env}"
[[ -f "$ENV_FILE" ]] && { set -a; source "$ENV_FILE"; set +a; }

SRC="${SRC:-${MANAGED_DB_URL:-}}"
DST="${DST:-postgresql://postgres:${POSTGRES_PASSWORD:-}@127.0.0.1:5432/${POSTGRES_DB:-postgres}}"
: "${SRC:?Set SRC or MANAGED_DB_URL (managed connection string)}"

q() { psql "$1" -At -c "$2" 2>/dev/null; }

hr() { printf '%.0s-' {1..60}; echo; }

# The tables whose counts must match exactly after restore.
TABLES=(cloud_media_items cloud_titles cloud_title_variants cloud_sources
        cloud_live_streams catalog_titles catalog_file_tracks
        catalog_provider_identities subtitle_tracks)

echo "PARITY CHECK  $(date -u +%FT%TZ)"
hr
printf "%-32s %14s %14s %4s\n" "CHECK" "MANAGED" "SELFHOST" "OK?"
hr

check() { # label, sql
  local label="$1" sql="$2" a b ok
  a="$(q "$SRC" "$sql")"; b="$(q "$DST" "$sql")"
  [[ "$a" == "$b" ]] && ok="✓" || ok="✗"
  printf "%-32s %14s %14s %4s\n" "$label" "${a:-?}" "${b:-?}" "$ok"
}

for t in "${TABLES[@]}"; do
  check "rows: $t" "select count(*) from public.$t"
done

hr
check "extensions (count)"        "select count(*) from pg_extension"
check "cron jobs (total)"         "select count(*) from cron.job"
check "cron jobs (active)"        "select count(*) from cron.job where active"
check "RLS policies (public)"     "select count(*) from pg_policies where schemaname='public'"
check "vault secrets"             "select count(*) from vault.secrets"
check "anon statement_timeout"    "select setting from pg_settings where name='statement_timeout'"  # session-level; role GUC checked below

hr
echo "Role GUCs (should be anon=3s, authenticated=8s on both):"
for role in anon authenticated; do
  echo "  $role:"
  echo "    managed : $(q "$SRC" "select array_to_string(setconfig,'; ') from pg_db_role_setting s join pg_roles r on r.oid=s.setrole where r.rolname='$role'")"
  echo "    selfhost: $(q "$DST" "select array_to_string(setconfig,'; ') from pg_db_role_setting s join pg_roles r on r.oid=s.setrole where r.rolname='$role'")"
done

hr
echo "couche-B dual-write flag (expect '0' = dormant on both):"
echo "    managed : $(q "$SRC" "select current_setting('app.norva_catalog_dual_write', true)")"
echo "    selfhost: $(q "$DST" "select current_setting('app.norva_catalog_dual_write', true)")"

hr
echo "Any ✗ above = investigate before cutover. Row-count drift on cloud_* usually"
echo "means the dump ran while imports were still live — re-freeze and re-dump."
