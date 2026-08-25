#!/usr/bin/env bash
set -euo pipefail

# Reproducible real-PostgreSQL convergence proof for the pre-READY stale-version
# gate. Every batch is a distinct committed transaction and reconstructs its
# write snapshot from PostgreSQL; no lease or process memory carries authority.

CONTAINER="${CONTAINER:?set CONTAINER}"
SOURCE_ID="${SOURCE_ID:?set SOURCE_ID}"
USER_ID="${USER_ID:?set USER_ID}"
GENERATION_ID="${GENERATION_ID:?set GENERATION_ID}"
EVIDENCE_ROOT="${EVIDENCE_ROOT:-/var/lib/norva-phase3-proof}"
MAX_BATCHES="${MAX_BATCHES:-1000}"
BATCH_LIMIT="${BATCH_LIMIT:-200}"

uuid_re='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
[[ "$SOURCE_ID" =~ $uuid_re ]] || { echo 'invalid SOURCE_ID' >&2; exit 64; }
[[ "$USER_ID" =~ $uuid_re ]] || { echo 'invalid USER_ID' >&2; exit 64; }
[[ "$GENERATION_ID" =~ $uuid_re ]] || { echo 'invalid GENERATION_ID' >&2; exit 64; }
[[ "$MAX_BATCHES" =~ ^[1-9][0-9]*$ ]] || { echo 'invalid MAX_BATCHES' >&2; exit 64; }
[[ "$BATCH_LIMIT" =~ ^[1-9][0-9]*$ ]] || { echo 'invalid BATCH_LIMIT' >&2; exit 64; }
(( BATCH_LIMIT <= 500 )) || { echo 'BATCH_LIMIT exceeds RPC bound' >&2; exit 64; }

evidence="$EVIDENCE_ROOT/catalog-ready-prune-strict-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$evidence"

db() {
  docker exec -u postgres "$CONTAINER" \
    psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres "$@"
}

versions_sql="select catalog_version,count(*) from public.cloud_media_items where source_id='$SOURCE_ID'::uuid and generation_id='$GENERATION_ID'::uuid group by catalog_version order by catalog_version;"
db -P pager=off -F '|' -Atqc "$versions_sql" | tee "$evidence/01-before.txt"

complete=false
for ((batch = 1; batch <= MAX_BATCHES; batch++)); do
  result="$(db -qAtc "
    set statement_timeout='8s';
    select set_config('request.jwt.claim.role','service_role',false);
    with snapshot as (
      select public.norva_get_catalog_write_snapshot(
        '$SOURCE_ID'::uuid,'$USER_ID'::uuid
      ) value
    )
    select public.norva_prune_catalog_generation_before_ready(
      '$SOURCE_ID'::uuid,'$USER_ID'::uuid,'$GENERATION_ID'::uuid,
      (value->>'headRevision')::bigint,
      (value->>'configRevision')::bigint,
      (value->>'sourceVisibilityEpoch')::bigint,
      (value->>'userVisibilityEpoch')::bigint,
      $BATCH_LIMIT
    ) from snapshot;
  " | tail -n 1)"
  deleted="$(sed -n 's/.*"deletedRows": \([0-9][0-9]*\).*/\1/p' <<<"$result")"
  [[ -n "$deleted" ]] || { echo "invalid RPC result: $result" >&2; exit 65; }
  if (( batch % 25 == 0 || deleted == 0 )); then
    printf '%s|%s|%s\n' "$batch" "$deleted" "$result" | tee -a "$evidence/02-batches.txt"
  fi
  if (( deleted == 0 )); then
    complete=true
    break
  fi
done

[[ "$complete" == true ]] || { echo 'prune did not converge within MAX_BATCHES' >&2; exit 75; }
db -P pager=off -F '|' -Atqc "$versions_sql" | tee "$evidence/03-after.txt"
printf '%s\n' "$evidence" | tee "$EVIDENCE_ROOT/catalog-ready-prune-strict-latest.txt"
