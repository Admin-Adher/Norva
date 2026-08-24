#!/usr/bin/env bash
set -euo pipefail

DB_CONTAINER="${DB_CONTAINER:-norva-phase3-proof-a-db}"
DB_USER="${DB_USER:-supabase_admin}"
DB_NAME="${DB_NAME:-postgres}"
WORK_DIR="${WORK_DIR:-$(mktemp -d)}"

case "$DB_CONTAINER" in
  norva-phase3-proof-*-db) ;;
  *)
    echo "REFUSED: this destructive proof only accepts a disposable norva-phase3-proof-*-db container" >&2
    exit 64
    ;;
esac

cleanup() {
  rm -rf -- "$WORK_DIR"
}
trap cleanup EXIT

psql_cmd=(docker exec -i "$DB_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME")

expected_revision=$("${psql_cmd[@]}" -At <<'SQL'
select coalesce((
  select revision
  from public.legal_billing_archive_retention_policy
  where record_kind='billing_ledger'
),0);
SQL
)
if [[ ! "$expected_revision" =~ ^[0-9]+$ ]]; then
  echo "FAIL: invalid starting revision: $expected_revision" >&2
  exit 1
fi
next_revision=$((expected_revision + 1))

cat >"$WORK_DIR/call.sql" <<SQL
set "request.jwt.claim.role"='service_role';
select public.norva_configure_legal_billing_archive_policy(
  $expected_revision,
  'fixture-accounting-obligation',
  'fixture://concurrent-reviewed-policy/accounting-v2',
  10,
  12,
  31,
  'legal-policy-v2-race'
);
SQL

set +e
"${psql_cmd[@]}" <"$WORK_DIR/call.sql" >"$WORK_DIR/a.out" 2>"$WORK_DIR/a.err" &
pid_a=$!
"${psql_cmd[@]}" <"$WORK_DIR/call.sql" >"$WORK_DIR/b.out" 2>"$WORK_DIR/b.err" &
pid_b=$!
wait "$pid_a"; status_a=$?
wait "$pid_b"; status_b=$?
set -e

if [[ "$status_a" -eq 0 && "$status_b" -eq 0 ]] ||
   [[ "$status_a" -ne 0 && "$status_b" -ne 0 ]]; then
  echo "FAIL: expected exactly one winner (a=$status_a b=$status_b)" >&2
  cat "$WORK_DIR/a.err" "$WORK_DIR/b.err" >&2
  exit 1
fi
if ! grep -q 'stale legal billing retention policy revision' "$WORK_DIR/a.err" "$WORK_DIR/b.err"; then
  echo 'FAIL: losing session did not return the explicit STALE contract' >&2
  cat "$WORK_DIR/a.err" "$WORK_DIR/b.err" >&2
  exit 1
fi

snapshot=$("${psql_cmd[@]}" -At -v expected_revision="$expected_revision" -v next_revision="$next_revision" <<'SQL'
select concat_ws('|',
  policy.revision,
  policy.calculation_version,
  policy.retention_years,
  policy.fiscal_year_end_month,
  policy.fiscal_year_end_day,
  (select count(*) from public.legal_billing_archive_policy_events
   where previous_revision=:'expected_revision'::bigint
     and revision=:'next_revision'::bigint)
)
from public.legal_billing_archive_retention_policy policy
where record_kind='billing_ledger';
SQL
)

if [[ "$snapshot" != "$next_revision|2|10|12|31|1" ]]; then
  echo "FAIL: unexpected durable snapshot: $snapshot" >&2
  exit 1
fi

echo "LEGAL_BILLING_POLICY_V2_RACE_PASS|winner=$([[ $status_a -eq 0 ]] && echo A || echo B)|loser=STALE|snapshot=$snapshot"
