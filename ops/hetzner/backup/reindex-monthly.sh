#!/usr/bin/env bash
# =============================================================================
# reindex-monthly.sh — reclaim index bloat on the high-churn catalogue tables
# =============================================================================
# cloud_titles runs at ~14% HOT: every non-HOT update writes a new tuple AND an
# entry into EVERY one of its indexes, so bloat is the steady state, not an
# accident. Audit 2026-08-21 found one index 69% bloat (199 -> 62 MB) and a
# REINDEX pass over the four big tables returned 1.1 GB out of 6.8.
#
# REINDEX TABLE CONCURRENTLY takes no exclusive lock, but it does build the new
# index alongside the old one, so it needs headroom equal to the largest index
# being rebuilt. capacity-check.sh watches the bytes-per-title figure that says
# when this is overdue (7000 threshold vs ~5700 fresh).
#
# Run by norva-reindex.timer, monthly. Safe to run by hand at any time.
# =============================================================================
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/lib.sh"

TABLES="${REINDEX_TABLES:-public.cloud_titles public.cloud_media_items public.cloud_title_variants public.catalog_titles}"

q() { docker exec "$DB_CONTAINER" psql -U postgres -Atc "$1"; }
size_of() { q "select pg_indexes_size('$1');"; }

TOTAL_BEFORE=0
TOTAL_AFTER=0
FAILED=""

for t in $TABLES; do
  before="$(size_of "$t" 2>/dev/null || echo 0)"
  if [ "${before:-0}" -eq 0 ]; then
    log "SKIP $t (table absente ou illisible)"
    continue
  fi
  # CONCURRENTLY cannot run inside a transaction block, hence one -c per call.
  if docker exec "$DB_CONTAINER" psql -U supabase_admin -q \
       -c "REINDEX TABLE CONCURRENTLY $t;" >/dev/null 2>&1; then
    after="$(size_of "$t")"
    TOTAL_BEFORE=$((TOTAL_BEFORE + before))
    TOTAL_AFTER=$((TOTAL_AFTER + after))
    log "$t: $(numfmt --to=iec "$before" 2>/dev/null || echo "$before") -> $(numfmt --to=iec "$after" 2>/dev/null || echo "$after")"
  else
    # A failed CONCURRENTLY leaves an INVALID index behind that keeps consuming
    # writes without serving reads. Name it loudly rather than exiting quietly.
    FAILED="$FAILED $t"
    log "ERROR: REINDEX failed on $t"
  fi
done

RECLAIMED=$((TOTAL_BEFORE - TOTAL_AFTER))
log "reclaimed $(numfmt --to=iec "$RECLAIMED" 2>/dev/null || echo "$RECLAIMED")"

if [ -n "$FAILED" ]; then
  log "Check for leftover INVALID indexes:"
  log "  select indexrelid::regclass from pg_index where not indisvalid;"
  echo "REINDEX failed on:$FAILED" >&2
  exit 1
fi
