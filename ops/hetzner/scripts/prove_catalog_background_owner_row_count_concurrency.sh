#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || -z "$1" ]]; then
  echo "usage: $0 <disposable-postgres-container>" >&2
  exit 64
fi

DB_CONTAINER="$1"
if ! docker inspect "$DB_CONTAINER" >/dev/null 2>&1; then
  echo "container not found: $DB_CONTAINER" >&2
  exit 66
fi

PSQL=(docker exec -i "$DB_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres)
SNAPSHOT_ID=""
LOG_A="$(mktemp)"
LOG_B="$(mktemp)"

cleanup() {
  if [[ -n "$SNAPSHOT_ID" ]]; then
    "${PSQL[@]}" -qAtc "
      delete from public.cloud_catalog_background_owner_snapshot_rows
      where snapshot_id = '$SNAPSHOT_ID';
      delete from public.cloud_catalog_background_owner_snapshot_sources
      where snapshot_id = '$SNAPSHOT_ID';
      delete from public.cloud_catalog_background_owner_snapshots
      where id = '$SNAPSHOT_ID';
    " >/dev/null 2>&1 || true
  fi
  rm -f -- "$LOG_A" "$LOG_B"
}
trap cleanup EXIT

IFS='|' read -r USER_ID SOURCE_ID GENERATION_ID < <(
  "${PSQL[@]}" -qAtF '|' -c "
    select generation.user_id,generation.source_id,generation.id
    from public.cloud_source_catalog_generations generation
    join public.cloud_title_variants variant
      on variant.user_id = generation.user_id
     and variant.source_id = generation.source_id
     and variant.generation_id = generation.id
    where generation.state = 'active'
    group by generation.user_id,generation.source_id,generation.id
    having count(distinct variant.title_id) >= 2
    order by generation.user_id,generation.source_id,generation.id
    limit 1;
  "
)

if [[ -z "${USER_ID:-}" || -z "${SOURCE_ID:-}" || -z "${GENERATION_ID:-}" ]]; then
  echo "no active generation with two titles is available" >&2
  exit 65
fi

SNAPSHOT_ID="$("${PSQL[@]}" -qAtc "
  insert into public.cloud_catalog_background_owner_snapshots (
    user_id,snapshot_kind,state,build_visibility_epoch,
    applied_visibility_epoch,row_count,completed_at,activated_at
  ) values ('$USER_ID','baseline','active',1,1,0,now(),now())
  returning id;
")"

"${PSQL[@]}" -qAtc "
  insert into public.cloud_catalog_background_owner_snapshot_sources (
    snapshot_id,user_id,source_id,generation_id
  ) values ('$SNAPSHOT_ID','$USER_ID','$SOURCE_ID','$GENERATION_ID');
" >/dev/null

mapfile -t TITLE_IDS < <(
  "${PSQL[@]}" -qAtc "
    select distinct variant.title_id
    from public.cloud_title_variants variant
    where variant.user_id = '$USER_ID'
      and variant.source_id = '$SOURCE_ID'
      and variant.generation_id = '$GENERATION_ID'
    order by variant.title_id
    limit 2;
  "
)
if [[ ${#TITLE_IDS[@]} -ne 2 ]]; then
  echo "fixture did not produce two title ids" >&2
  exit 65
fi

insert_sql() {
  local title_id="$1"
  local hold_seconds="$2"
  cat <<SQL
begin;
insert into public.cloud_catalog_background_owner_snapshot_rows (
  snapshot_id,user_id,title_id,is_present,
  owner_source_id,owner_generation_id,storage_kind,
  item_type,provider_tmdb_id,match_status,title,original_title,
  release_year,poster_url,backdrop_url,catalog_metadata,
  payload_updated_at,year_backfill_attempted_at,
  revalidate_attempted_at,search_match_attempted_at
)
select '$SNAPSHOT_ID','$USER_ID',title.id,true,
  '$SOURCE_ID','$GENERATION_ID','global',
  title.item_type,title.provider_tmdb_id,title.match_status,title.title,
  title.original_title,title.release_year,title.poster_url,title.backdrop_url,
  title.metadata,title.updated_at,title.year_backfill_attempted_at,
  title.revalidate_attempted_at,title.search_match_attempted_at
from public.cloud_titles title
where title.id = '$title_id' and title.user_id = '$USER_ID';
select pg_sleep($hold_seconds);
commit;
SQL
}

START_A="$(date +%s%N)"
insert_sql "${TITLE_IDS[0]}" 2 | "${PSQL[@]}" >"$LOG_A" 2>&1 &
PID_A=$!
sleep 0.2
START_B="$(date +%s%N)"
insert_sql "${TITLE_IDS[1]}" 0 | "${PSQL[@]}" >"$LOG_B" 2>&1 &
PID_B=$!

wait "$PID_A"
END_A="$(date +%s%N)"
wait "$PID_B"
END_B="$(date +%s%N)"

COUNTS="$("${PSQL[@]}" -qAtF '|' -c "
  select snapshot.row_count,
    count(owner_row.title_id) filter (where owner_row.is_present)
  from public.cloud_catalog_background_owner_snapshots snapshot
  left join public.cloud_catalog_background_owner_snapshot_rows owner_row
    on owner_row.snapshot_id = snapshot.id
  where snapshot.id = '$SNAPSHOT_ID'
  group by snapshot.id,snapshot.row_count;
")"

if [[ "$COUNTS" != "2|2" ]]; then
  echo "concurrent counter mismatch: $COUNTS" >&2
  echo "--- session A ---" >&2
  sed -n '1,80p' "$LOG_A" >&2
  echo "--- session B ---" >&2
  sed -n '1,80p' "$LOG_B" >&2
  exit 1
fi

printf '%s\n' \
  "CATALOG_BACKGROUND_OWNER_ROW_COUNT_CONCURRENCY_PASS" \
  "session_a_start_ns=$START_A" \
  "session_a_end_ns=$END_A" \
  "session_b_start_ns=$START_B" \
  "session_b_end_ns=$END_B" \
  "declared_present_rows=2" \
  "actual_present_rows=2"
