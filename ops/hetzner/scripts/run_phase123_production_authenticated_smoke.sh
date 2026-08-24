#!/usr/bin/env bash
set -Eeuo pipefail

WORKSPACE="${WORKSPACE:-}"
EXPECTED_COMMIT="${EXPECTED_COMMIT:-}"
REPORT_DIR="${REPORT_DIR:-}"
DB_CONTAINER="${DB_CONTAINER:-norva-db}"
FUNCTIONS_CONTAINER="${FUNCTIONS_CONTAINER:-norva-edge-functions}"
API_BASE="${API_BASE:-https://api.norva.tv/functions/v1}"

fail() { printf 'PHASE123_PRODUCTION_AUTH_SMOKE_FAIL %s\n' "$*" >&2; exit 1; }
test -n "$WORKSPACE" || fail 'WORKSPACE is required'
test -n "$EXPECTED_COMMIT" || fail 'EXPECTED_COMMIT is required'
case "$WORKSPACE" in /home/adrien/norva-deployments/phase123-*) ;; *) fail 'unexpected workspace' ;; esac
case "$REPORT_DIR" in /var/lib/norva-phase3-proof/production-auth-smoke-*) ;; *) fail 'unexpected report directory' ;; esac
test "$DB_CONTAINER" = norva-db || fail 'unexpected database container'
test "$FUNCTIONS_CONTAINER" = norva-edge-functions || fail 'unexpected Edge container'
test "$API_BASE" = 'https://api.norva.tv/functions/v1' || fail 'unexpected API base'
test "$(git -C "$WORKSPACE" rev-parse HEAD)" = "$EXPECTED_COMMIT" || fail 'workspace commit mismatch'
test -z "$(git -C "$WORKSPACE" status --porcelain)" || fail 'workspace is dirty'
test "$(docker inspect -f '{{.State.Running}}' "$DB_CONTAINER")" = true || fail 'database is unavailable'
test "$(docker inspect -f '{{.State.Running}}' "$FUNCTIONS_CONTAINER")" = true || fail 'Edge is unavailable'
install -d -m 700 "$REPORT_DIR"
umask 077
exec > >(tee -a "$REPORT_DIR/smoke.log") 2>&1

env_value() {
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" |
    sed -n "s/^${2}=//p" | head -n 1
}
JWT_SECRET="$(env_value "$FUNCTIONS_CONTAINER" JWT_SECRET)"
ANON_KEY="$(env_value "$FUNCTIONS_CONTAINER" SUPABASE_ANON_KEY)"
test -n "$JWT_SECRET" || fail 'JWT secret is unavailable'
test -n "$ANON_KEY" || fail 'anon key is unavailable'

USER_ID="$(cat /proc/sys/kernel/random/uuid)"
USER_EMAIL="phase123-production-smoke-${USER_ID}@invalid.test"
USER_CREATED=false

db_scalar() {
  docker exec "$DB_CONTAINER" psql -X -qAt -v ON_ERROR_STOP=1 \
    -U supabase_admin -d postgres -c "$1"
}

cleanup() {
  local status=$?
  trap - EXIT
  if test "$USER_CREATED" = true; then
    if ! docker exec -i "$DB_CONTAINER" psql -X -v ON_ERROR_STOP=1 \
      -v fixture_user="$USER_ID" -U supabase_admin -d postgres \
      <"$WORKSPACE/ops/hetzner/scripts/phase123-production-smoke-cleanup.sql" \
      >"$REPORT_DIR/cleanup.log" 2>&1; then
      printf 'CLEANUP_FAILED user=%s log=%s\n' "$USER_ID" "$REPORT_DIR/cleanup.log" >&2
      exit 1
    fi
  fi
  exit "$status"
}
trap cleanup EXIT

test "$(db_scalar "select count(*) from public.admin_feature_flags where enabled and key in ('provider_access_v1_enabled','provider_access_auto_detection_v1_enabled','provider_access_notifications_v1_enabled','provider_access_visibility_v1_enabled','provider_credential_transition_v1_enabled','provider_replacement_v1_enabled')")" = 0 || fail 'Provider Access flags are not OFF'
test "$(db_scalar "select phase from public.cloud_catalog_cache_epoch_v2_rollout where singleton")" = installed || fail 'cache rollout is not installed'

docker exec "$DB_CONTAINER" psql -X -q -v ON_ERROR_STOP=1 \
  -v fixture_user="$USER_ID" -v fixture_email="$USER_EMAIL" \
  -U supabase_admin -d postgres <<'SQL'
insert into auth.users(
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values (
  :'fixture_user','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated',:'fixture_email','not-used',clock_timestamp(),
  '{}'::jsonb,'{}'::jsonb,clock_timestamp(),clock_timestamp()
);
SQL
USER_CREATED=true

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
HEADER="$(printf '%s' '{"alg":"HS256","typ":"JWT"}' | b64url)"
NOW="$(date +%s)"; EXP="$((NOW+1800))"
PAYLOAD="$(printf '{"aud":"authenticated","exp":%s,"iat":%s,"sub":"%s","role":"authenticated","email":"%s"}' "$EXP" "$NOW" "$USER_ID" "$USER_EMAIL" | b64url)"
SIGNATURE="$(printf '%s' "$HEADER.$PAYLOAD" | openssl dgst -sha256 -hmac "$JWT_SECRET" -binary | b64url)"
USER_TOKEN="$HEADER.$PAYLOAD.$SIGNATURE"

current_token() {
  db_scalar "select public.norva_catalog_cache_epoch_v2('$USER_ID'::uuid)->>'cacheEpoch'"
}
request() {
  local name="$1" path="$2" expected_status="$3" expected_token="$4"
  local code
  code="$(curl -sS --connect-timeout 3 --max-time 30 \
    -D "$REPORT_DIR/$name.headers" -o "$REPORT_DIR/$name.body" \
    -w '%{http_code}' -H "Authorization: Bearer $USER_TOKEN" \
    -H "apikey: $ANON_KEY" "$API_BASE/$path")"
  test "$code" = "$expected_status" || fail "$name returned HTTP $code"
  grep -Fiq "x-norva-visibility-epoch: $expected_token" "$REPORT_DIR/$name.headers" || fail "$name epoch mismatch"
  grep -Fiq 'x-norva-catalog-cache-contract: v2' "$REPORT_DIR/$name.headers" || fail "$name v2 header missing"
}

BASE_TOKEN="$(current_token)"
[[ "$BASE_TOKEN" =~ ^v2\.[1-9][0-9]*\.[1-9][0-9]*$ ]] || fail 'invalid baseline token'
request cloud_warm_1 'norva-cloud/sources' 200 "$BASE_TOKEN"
request cloud_warm_2 'norva-cloud/sources' 200 "$BASE_TOKEN"
request catalog 'norva-catalog/media-items?itemType=movie&limit=1' 200 "$BASE_TOKEN"
request playback 'norva-playback/generated-subtitle-langs' 200 "$BASE_TOKEN"

db_scalar 'select public.norva_bump_global_catalog_visibility_epoch()' >/dev/null
WARM_BUMP_TOKEN="$(current_token)"
test "$WARM_BUMP_TOKEN" != "$BASE_TOKEN" || fail 'warm bump did not change token'
request cloud_after_warm_bump 'norva-cloud/sources' 200 "$WARM_BUMP_TOKEN"

RACE_PROVED=false
for attempt in $(seq 1 8); do
  race_dir="$REPORT_DIR/race-$attempt"; mkdir -m 700 "$race_dir"
  pids=()
  for request_id in $(seq 1 32); do
    (
      curl -sS --connect-timeout 3 --max-time 30 \
        -D "$race_dir/$request_id.headers" -o "$race_dir/$request_id.body" \
        -w '%{http_code}' -H "Authorization: Bearer $USER_TOKEN" \
        -H "apikey: $ANON_KEY" "$API_BASE/norva-cloud/sources" \
        >"$race_dir/$request_id.status"
    ) & pids+=("$!")
  done
  sleep 0.01
  db_scalar 'select public.norva_bump_global_catalog_visibility_epoch()' >/dev/null
  race_token="$(current_token)"
  for pid in "${pids[@]}"; do wait "$pid"; done
  for request_id in $(seq 1 32); do
    status="$(cat "$race_dir/$request_id.status")"
    case "$status" in
      200) ;;
      409)
        if grep -Fiq "x-norva-visibility-epoch: $race_token" "$race_dir/$request_id.headers" \
           && grep -Fq 'CATALOG_VISIBILITY_EPOCH_CHANGED' "$race_dir/$request_id.body" \
           && grep -Fiq 'cache-control: no-store' "$race_dir/$request_id.headers"; then
          RACE_PROVED=true
        fi
        ;;
      *) fail "race request returned HTTP $status" ;;
    esac
  done
  test "$RACE_PROVED" = false || break
done
test "$RACE_PROVED" = true || fail 'no real midflight cutover was observed'

FINAL_TOKEN="$(current_token)"
request cloud_converged 'norva-cloud/sources' 200 "$FINAL_TOKEN"
test "$(db_scalar "select count(*) from public.admin_feature_flags where enabled and key in ('provider_access_v1_enabled','provider_access_auto_detection_v1_enabled','provider_access_notifications_v1_enabled','provider_access_visibility_v1_enabled','provider_credential_transition_v1_enabled','provider_replacement_v1_enabled')")" = 0 || fail 'a Provider Access flag changed'

printf 'commit=%s\nuser=%s\nbaseline=%s\nafter_warm_bump=%s\nfinal=%s\nmidflight_cutover=409\nflags_enabled=0\n' \
  "$EXPECTED_COMMIT" "$USER_ID" "$BASE_TOKEN" "$WARM_BUMP_TOKEN" "$FINAL_TOKEN" \
  >"$REPORT_DIR/RESULT.txt"
sha256sum "$REPORT_DIR"/*.headers "$REPORT_DIR"/*.body "$REPORT_DIR/RESULT.txt" \
  >"$REPORT_DIR/artifact-sha256.txt"
printf 'PHASE123_PRODUCTION_AUTH_SMOKE_PASS\n'
