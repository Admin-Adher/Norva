#!/usr/bin/env bash
set -euo pipefail

readonly DB_CONTAINER="${DB_CONTAINER:?DB_CONTAINER is required}"
readonly PREDECESSOR_OBSERVATION_ID="${PREDECESSOR_OBSERVATION_ID:?PREDECESSOR_OBSERVATION_ID is required}"
readonly EXPECTED_ROLLOUT_REVISION="${EXPECTED_ROLLOUT_REVISION:?EXPECTED_ROLLOUT_REVISION is required}"

[[ "$DB_CONTAINER" =~ ^norva-phase123-prod-clone-[a-z0-9-]+-db$ ]]
[[ "$PREDECESSOR_OBSERVATION_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]
[[ "$EXPECTED_ROLLOUT_REVISION" =~ ^[0-9]+$ ]]

readonly PROOF_DIR="$(mktemp -d)"
trap 'rm -rf -- "$PROOF_DIR"' EXIT

race_restart() {
  local actor="$1"
  local output="$2"
  docker exec -i "$DB_CONTAINER" psql -X -U supabase_admin -d postgres \
    -v ON_ERROR_STOP=1 \
    -v predecessor="$PREDECESSOR_OBSERVATION_ID" \
    -v revision="$EXPECTED_ROLLOUT_REVISION" \
    -v actor="$actor" >"$output" 2>&1 <<'SQL'
begin;
set local role service_role;
select public.norva_restart_provider_access_rollout_observation_v2(
  :'predecessor'::uuid, :'revision'::bigint, :'actor'
);
commit;
SQL
}

set +e
race_restart 'codex-v2-race-a' "$PROOF_DIR/a.log" &
readonly PID_A=$!
race_restart 'codex-v2-race-b' "$PROOF_DIR/b.log" &
readonly PID_B=$!
wait "$PID_A"; readonly STATUS_A=$?
wait "$PID_B"; readonly STATUS_B=$?
set -e

cat "$PROOF_DIR/a.log"
cat "$PROOF_DIR/b.log"

if [[ "$STATUS_A" -eq 0 && "$STATUS_B" -eq 0 ]]; then
  echo 'both concurrent restarts committed' >&2
  exit 1
fi
if [[ "$STATUS_A" -ne 0 && "$STATUS_B" -ne 0 ]]; then
  echo 'neither concurrent restart committed' >&2
  exit 1
fi
if ! grep -q 'stale rollout observation predecessor' "$PROOF_DIR/a.log" \
   && ! grep -q 'stale rollout observation predecessor' "$PROOF_DIR/b.log"; then
  echo 'loser did not fail with the expected stale predecessor result' >&2
  exit 1
fi

readonly SNAPSHOT="$(docker exec -i "$DB_CONTAINER" psql -X -U supabase_admin \
  -d postgres -AtF '|' -v ON_ERROR_STOP=1 \
  -v predecessor="$PREDECESSOR_OBSERVATION_ID" \
  -v revision="$EXPECTED_ROLLOUT_REVISION" <<'SQL'
select
  count(*) filter (
    where id = :'predecessor'::uuid
      and state = 'stale'
      and decision_reasons = '["THRESHOLD_CONTRACT_SUPERSEDED"]'::jsonb
  ),
  count(*) filter (
    where supersedes_observation_id = :'predecessor'::uuid
      and state = 'collecting'
      and threshold_contract = 'provider-access-rollout-observation:v2'
  ),
  count(*) filter (
    where rollout_revision = :'revision'::bigint and state = 'collecting'
  )
from public.cloud_provider_access_rollout_observations;
SQL
)"

if [[ "$SNAPSHOT" != '1|1|1' ]]; then
  echo "unexpected final race snapshot: $SNAPSHOT" >&2
  exit 1
fi

printf 'winner_count=1\nloser_result=STALE\nfinal_snapshot=%s\nstatus=PASS\n' "$SNAPSHOT"
