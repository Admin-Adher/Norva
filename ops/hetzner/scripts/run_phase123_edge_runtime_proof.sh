#!/usr/bin/env bash
set -Eeuo pipefail

# Runtime acceptance proof for the Phase 1-3 catalog-cache epoch contract.
# This script is deliberately restricted to the disposable Phase 3 proof stack.

SOURCE_DIR="${1:-/home/adrien/norva-phase3-proof/source-fbb6e95c}"
EXPECTED_COMMIT="${EXPECTED_COMMIT:-fbb6e95c58c5019e2d4fd0b0233c1e1d34ca3477}"
DB_CONTAINER="${DB_CONTAINER:-norva-phase3-proof-db}"
KONG_CONTAINER="${KONG_CONTAINER:-norva-phase3-proof-kong}"
REST_CONTAINER="${REST_CONTAINER:-norva-phase3-proof-rest}"
TEMP_REST_CONTAINER="${TEMP_REST_CONTAINER:-norva-phase123-rest-proof}"
REST_PROXY_CONTAINER="${REST_PROXY_CONTAINER:-norva-phase123-rest-proxy-proof}"
EDGE_CONTAINER="${EDGE_CONTAINER:-norva-phase123-edge-proof}"
PROOF_NETWORK="${PROOF_NETWORK:-norva-phase3-proof-net}"
CACHE_VOLUME="${CACHE_VOLUME:-norva-phase123-deno-cache-proof}"
POSTGREST_PASSWD="${POSTGREST_PASSWD:-/home/adrien/norva-phase3-proof/input/postgrest.passwd}"
REST_PROXY_CONFIG="${REST_PROXY_CONFIG:-/home/adrien/norva-phase3-proof/input/nginx-rest-prefix.conf}"
CURL_IMAGE="${CURL_IMAGE:-curlimages/curl@sha256:d9b4541e214bcd85196d6e92e2753ac6d0ea699f0af5741f8c6cccbfcf00ef4b}"
EDGE_IMAGE="${EDGE_IMAGE:-supabase/edge-runtime:v1.74.0}"
REST_PROXY_IMAGE="${REST_PROXY_IMAGE:-nginx:1.27.5-alpine}"
USER_ID="94000000-0000-4000-8000-000000000111"
USER_EMAIL="phase123-edge-proof@invalid.test"
TMP_DIR="$(mktemp -d)"
LOCKER_PID=""
REQUEST_PID=""

cleanup() {
  set +e
  test -z "$REQUEST_PID" || kill "$REQUEST_PID" >/dev/null 2>&1
  test -z "$LOCKER_PID" || kill "$LOCKER_PID" >/dev/null 2>&1
  rm -rf -- "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  printf 'PHASE123_EDGE_RUNTIME_PROOF_FAIL: %s\n' "$*" >&2
  if docker ps -a --format '{{.Names}}' | grep -Fxq "$TEMP_REST_CONTAINER"; then
    printf '%s\n' '--- temporary PostgREST log ---' >&2
    docker logs --tail 80 "$TEMP_REST_CONTAINER" >&2 || true
  fi
  if docker ps -a --format '{{.Names}}' | grep -Fxq "$REST_PROXY_CONTAINER"; then
    printf '%s\n' '--- proof REST proxy log ---' >&2
    docker logs --tail 80 "$REST_PROXY_CONTAINER" >&2 || true
  fi
  if docker ps -a --format '{{.Names}}' | grep -Fxq "$EDGE_CONTAINER"; then
    printf '%s\n' '--- proof Edge log ---' >&2
    docker logs --tail 80 "$EDGE_CONTAINER" >&2 || true
  fi
  exit 1
}

case "$SOURCE_DIR" in
  /home/adrien/norva-phase3-proof/*) ;;
  *) fail "source directory is outside the proof workspace" ;;
esac
case "$DB_CONTAINER|$KONG_CONTAINER|$REST_CONTAINER|$TEMP_REST_CONTAINER|$REST_PROXY_CONTAINER|$EDGE_CONTAINER|$PROOF_NETWORK|$CACHE_VOLUME" in
  norva-phase3-proof-*\|norva-phase3-proof-*\|norva-phase3-proof-rest\|norva-phase123-rest-proof\|norva-phase123-rest-proxy-proof\|norva-phase123-edge-proof\|norva-phase3-proof-net\|norva-phase123-deno-cache-proof) ;;
  *) fail "container/network/volume scope is not the disposable proof stack" ;;
esac

test -d "$SOURCE_DIR/.git" || fail "proof checkout is missing"
test "$(git -C "$SOURCE_DIR" rev-parse HEAD)" = "$EXPECTED_COMMIT" || fail "unexpected proof commit"
git -C "$SOURCE_DIR" diff-index --quiet HEAD -- || fail "proof checkout has tracked changes"
test -z "$(git -C "$SOURCE_DIR" ls-files --others --exclude-standard)" || fail "proof checkout has untracked files"
docker inspect "$DB_CONTAINER" "$KONG_CONTAINER" "$REST_CONTAINER" >/dev/null
docker network inspect "$PROOF_NETWORK" >/dev/null
test -f "$POSTGREST_PASSWD" || fail "proof PostgREST passwd file is missing"
test -f "$REST_PROXY_CONFIG" || fail "proof REST proxy config is missing"

env_value() {
  local container="$1" name="$2"
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$container" |
    sed -n "s/^${name}=//p" | head -n 1
}

JWT_SECRET="$(env_value "$KONG_CONTAINER" JWT_SECRET)"
ANON_KEY="$(env_value "$KONG_CONTAINER" SUPABASE_ANON_KEY)"
SERVICE_KEY="$(env_value "$KONG_CONTAINER" SUPABASE_SERVICE_KEY)"
test -n "$JWT_SECRET" || fail "proof JWT secret is missing"
test -n "$ANON_KEY" || fail "proof anon key is missing"
test -n "$SERVICE_KEY" || fail "proof service key is missing"

# The historical proof compose interpolated a base64 password directly into a
# URI. Characters such as '/' and '+' make that URI ambiguous on a fresh
# libpq parse. Build a quoted key/value conninfo and supply the passwd entry
# required by the distroless PostgREST image instead.
ORIGINAL_DB_URI="$(env_value "$REST_CONTAINER" PGRST_DB_URI)"
DB_CREDENTIALS="${ORIGINAL_DB_URI#*://}"
DB_CREDENTIALS="${DB_CREDENTIALS%@*}"
DB_PASSWORD="${DB_CREDENTIALS#*:}"
test -n "$DB_PASSWORD" || fail "proof database password is missing"
case "$DB_PASSWORD" in
  *"'"*) fail "proof database password cannot be represented safely" ;;
esac
REST_CONNINFO="user=authenticator password='$DB_PASSWORD' host=$DB_CONTAINER port=5432 dbname=postgres sslmode=disable"

if docker ps -a --format '{{.Names}}' | grep -Fxq "$TEMP_REST_CONTAINER"; then
  test "$(docker inspect -f '{{.Config.Image}}' "$TEMP_REST_CONTAINER")" = postgrest/postgrest:v14.12 ||
    fail "refusing to remove an unexpected temporary REST image"
  docker rm -f "$TEMP_REST_CONTAINER" >/dev/null
fi
if docker ps -a --format '{{.Names}}' | grep -Fxq "$REST_PROXY_CONTAINER"; then
  test "$(docker inspect -f '{{.Config.Image}}' "$REST_PROXY_CONTAINER")" = "$REST_PROXY_IMAGE" ||
    fail "refusing to remove an unexpected REST proxy image"
  mounted_proxy_config="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/nginx/nginx.conf"}}{{.Source}}{{end}}{{end}}' "$REST_PROXY_CONTAINER")"
  test "$mounted_proxy_config" = "$REST_PROXY_CONFIG" ||
    fail "refusing to replace a REST proxy mounted from another config"
  docker rm -f "$REST_PROXY_CONTAINER" >/dev/null
fi
docker run -d \
  --name "$TEMP_REST_CONTAINER" \
  --network "$PROOF_NETWORK" \
  --network-alias rest \
  --restart no \
  -v "$POSTGREST_PASSWD:/etc/passwd:ro" \
  -e PGRST_DB_URI="$REST_CONNINFO" \
  -e PGRST_DB_ANON_ROLE="$(env_value "$REST_CONTAINER" PGRST_DB_ANON_ROLE)" \
  -e PGRST_DB_SCHEMAS="$(env_value "$REST_CONTAINER" PGRST_DB_SCHEMAS)" \
  -e PGRST_DB_EXTRA_SEARCH_PATH="$(env_value "$REST_CONTAINER" PGRST_DB_EXTRA_SEARCH_PATH)" \
  -e PGRST_DB_POOL="$(env_value "$REST_CONTAINER" PGRST_DB_POOL)" \
  -e PGRST_JWT_SECRET="$(env_value "$REST_CONTAINER" PGRST_JWT_SECRET)" \
  -e PGRST_APP_SETTINGS_JWT_SECRET="$(env_value "$REST_CONTAINER" PGRST_APP_SETTINGS_JWT_SECRET)" \
  -e PGRST_APP_SETTINGS_JWT_EXP="$(env_value "$REST_CONTAINER" PGRST_APP_SETTINGS_JWT_EXP)" \
  -e PGRST_DB_USE_LEGACY_GUCS=false \
  postgrest/postgrest:v14.12 >/dev/null

for _ in $(seq 1 30); do
  if docker run --rm --network "$PROOF_NETWORK" "$CURL_IMAGE" -fsS \
    --connect-timeout 2 --max-time 5 \
    "http://$TEMP_REST_CONTAINER:3000/" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker run --rm --network "$PROOF_NETWORK" "$CURL_IMAGE" -fsS \
  --connect-timeout 2 --max-time 5 \
  "http://$TEMP_REST_CONTAINER:3000/" >/dev/null || {
    docker logs --tail 120 "$TEMP_REST_CONTAINER" >&2
    fail "temporary PostgREST did not become healthy"
  }

docker run -d \
  --name "$REST_PROXY_CONTAINER" \
  --network "$PROOF_NETWORK" \
  --restart no \
  -v "$REST_PROXY_CONFIG:/etc/nginx/nginx.conf:ro" \
  "$REST_PROXY_IMAGE" >/dev/null
for _ in $(seq 1 30); do
  if docker run --rm --network "$PROOF_NETWORK" "$CURL_IMAGE" -fsS \
    --connect-timeout 1 --max-time 2 \
    "http://$REST_PROXY_CONTAINER:8000/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
docker run --rm --network "$PROOF_NETWORK" "$CURL_IMAGE" -fsS \
  --connect-timeout 2 --max-time 5 \
  "http://$REST_PROXY_CONTAINER:8000/health" >/dev/null || fail "proof REST proxy did not become ready"

# The fixture is synthetic and exists only in the isolated proof database.
docker exec "$DB_CONTAINER" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
  -v fixture_user="$USER_ID" -v fixture_email="$USER_EMAIL" <<'SQL' >/dev/null
insert into auth.users(
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values (
  :'fixture_user','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated',:'fixture_email','not-used',clock_timestamp(),
  '{}'::jsonb,'{}'::jsonb,clock_timestamp(),clock_timestamp()
) on conflict (id) do update set email=excluded.email,updated_at=clock_timestamp();
notify pgrst, 'reload schema';
SQL

docker run --rm --network "$PROOF_NETWORK" "$CURL_IMAGE" -sS -i \
  --connect-timeout 2 --max-time 10 \
  -H "Authorization: Bearer $SERVICE_KEY" \
  -H "apikey: $SERVICE_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"p_user_id\":\"$USER_ID\"}" \
  "http://$TEMP_REST_CONTAINER:3000/rpc/norva_catalog_cache_epoch_v2" |
  tr -d '\r' >"$TMP_DIR/direct-rpc.txt"
grep -Fq 'HTTP/1.1 200' "$TMP_DIR/direct-rpc.txt" || {
  sed -n '1,80p' "$TMP_DIR/direct-rpc.txt" >&2
  fail "direct PostgREST epoch RPC failed"
}

docker run --rm --network "$PROOF_NETWORK" "$CURL_IMAGE" -sS -i \
  --connect-timeout 2 --max-time 10 \
  -H "Authorization: Bearer $SERVICE_KEY" \
  -H "apikey: $SERVICE_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"p_user_id\":\"$USER_ID\"}" \
  "http://$REST_PROXY_CONTAINER:8000/rest/v1/rpc/norva_catalog_cache_epoch_v2" |
  tr -d '\r' >"$TMP_DIR/kong-rpc.txt"
grep -Fq 'HTTP/1.1 200' "$TMP_DIR/kong-rpc.txt" || {
  sed -n '1,80p' "$TMP_DIR/kong-rpc.txt" >&2
  fail "REST-prefix proxy epoch RPC failed"
}

if docker ps -a --format '{{.Names}}' | grep -Fxq "$EDGE_CONTAINER"; then
  test "$(docker inspect -f '{{.Config.Image}}' "$EDGE_CONTAINER")" = "$EDGE_IMAGE" ||
    fail "refusing to replace an unexpected container image"
  mounted_source="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/home/deno/functions"}}{{.Source}}{{end}}{{end}}' "$EDGE_CONTAINER")"
  test "$mounted_source" = "$SOURCE_DIR/supabase/functions" ||
    fail "refusing to replace a container mounted from another source"
  docker rm -f "$EDGE_CONTAINER" >/dev/null
fi

if docker volume inspect "$CACHE_VOLUME" >/dev/null 2>&1; then
  docker volume rm "$CACHE_VOLUME" >/dev/null || fail "proof cache volume is still in use"
fi
docker volume create "$CACHE_VOLUME" >/dev/null
docker run --rm \
  -v norva_deno-cache:/src:ro \
  -v "$CACHE_VOLUME":/dst \
  alpine:3.20 sh -c 'cp -a /src/. /dst/'

docker run -d \
  --name "$EDGE_CONTAINER" \
  --network "$PROOF_NETWORK" \
  --restart no \
  -v "$SOURCE_DIR/supabase/functions:/home/deno/functions:ro" \
  -v "$CACHE_VOLUME:/root/.cache/deno" \
  -e JWT_SECRET="$JWT_SECRET" \
  -e SUPABASE_ANON_KEY="$ANON_KEY" \
  -e SUPABASE_SERVICE_ROLE_KEY="$SERVICE_KEY" \
  -e SUPABASE_URL="http://$REST_PROXY_CONTAINER:8000" \
  -e SUPABASE_PUBLIC_URL="http://$REST_PROXY_CONTAINER:8000" \
  -e VERIFY_JWT=false \
  "$EDGE_IMAGE" start --main-service /home/deno/functions/main >/dev/null

curl_from_proof_network() {
  docker run --rm --network "$PROOF_NETWORK" "$CURL_IMAGE" \
    --connect-timeout 3 --max-time 30 "$@"
}

for _ in $(seq 1 45); do
  if curl_from_proof_network -fsS "http://$EDGE_CONTAINER:9000/norva-catalog/health" >/dev/null 2>&1; then
    break
  fi
  test "$(docker inspect -f '{{.State.Status}}' "$EDGE_CONTAINER")" != exited || {
    docker logs --tail 120 "$EDGE_CONTAINER" >&2
    fail "Edge Runtime exited during bootstrap"
  }
  sleep 2
done
curl_from_proof_network -fsS "http://$EDGE_CONTAINER:9000/norva-catalog/health" >/dev/null ||
  fail "Edge Runtime did not become healthy"

b64url() {
  openssl base64 -A | tr '+/' '-_' | tr -d '='
}

HEADER="$(printf '%s' '{"alg":"HS256","typ":"JWT"}' | b64url)"
NOW="$(date +%s)"
EXP="$((NOW + 3600))"
PAYLOAD="$(printf '{"aud":"authenticated","exp":%s,"iat":%s,"sub":"%s","role":"authenticated","email":"%s"}' \
  "$EXP" "$NOW" "$USER_ID" "$USER_EMAIL" | b64url)"
SIGNATURE="$(printf '%s' "$HEADER.$PAYLOAD" | openssl dgst -sha256 -hmac "$JWT_SECRET" -binary | b64url)"
USER_TOKEN="$HEADER.$PAYLOAD.$SIGNATURE"

db_scalar() {
  docker exec "$DB_CONTAINER" psql -U supabase_admin -d postgres -Atc "$1"
}

current_token() {
  db_scalar "select public.norva_catalog_cache_epoch_v2('$USER_ID'::uuid)->>'cacheEpoch';"
}

request() {
  local path="$1" output="$2"
  curl_from_proof_network -sS -i \
    -H "Authorization: Bearer $USER_TOKEN" \
    -H "apikey: $ANON_KEY" \
    "http://$EDGE_CONTAINER:9000/$path" | tr -d '\r' >"$output"
}

assert_response() {
  local file="$1" status="$2" token="$3"
  grep -Fq "HTTP/1.1 $status" "$file" || {
    sed -n '1,80p' "$file" >&2
    fail "unexpected HTTP status in $file"
  }
  grep -Fiq "x-norva-visibility-epoch: $token" "$file" || fail "composite epoch header mismatch"
  grep -Fiq "x-norva-user-visibility-epoch: ${token##*.}" "$file" || fail "user epoch header mismatch"
  local global_part="${token#v2.}"
  global_part="${global_part%%.*}"
  grep -Fiq "x-norva-global-visibility-epoch: $global_part" "$file" || fail "global epoch header mismatch"
  grep -Fiq 'x-norva-catalog-cache-contract: v2' "$file" || fail "v2 contract header missing"
}

BASE_TOKEN="$(current_token)"
[[ "$BASE_TOKEN" =~ ^v2\.[1-9][0-9]*\.[1-9][0-9]*$ ]] || fail "invalid baseline token"

request 'norva-cloud/sources' "$TMP_DIR/cloud-1.txt"
assert_response "$TMP_DIR/cloud-1.txt" 200 "$BASE_TOKEN"
request 'norva-cloud/sources' "$TMP_DIR/cloud-2.txt"
assert_response "$TMP_DIR/cloud-2.txt" 200 "$BASE_TOKEN"
request 'norva-catalog/media-items?itemType=movie&limit=1' "$TMP_DIR/catalog.txt"
assert_response "$TMP_DIR/catalog.txt" 200 "$BASE_TOKEN"
request 'norva-playback/generated-subtitle-langs' "$TMP_DIR/playback.txt"
assert_response "$TMP_DIR/playback.txt" 200 "$BASE_TOKEN"

db_scalar 'select public.norva_bump_global_catalog_visibility_epoch();' >/dev/null
AFTER_WARM_BUMP="$(current_token)"
test "$AFTER_WARM_BUMP" != "$BASE_TOKEN" || fail "global bump did not change the cache token"
request 'norva-cloud/sources' "$TMP_DIR/cloud-after-bump.txt"
assert_response "$TMP_DIR/cloud-after-bump.txt" 200 "$AFTER_WARM_BUMP"

# Real TOCTOU proof: bind the request, block its source query, advance the global
# authority in another session, then let the response reach the final recheck.
docker exec "$DB_CONTAINER" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
  -c "begin; lock table public.cloud_sources in access exclusive mode; select pg_sleep(8); commit;" \
  >"$TMP_DIR/locker.log" 2>&1 &
LOCKER_PID=$!

lock_ready=0
for _ in $(seq 1 30); do
  if test "$(db_scalar "select count(*) from pg_locks l join pg_class c on c.oid=l.relation where c.oid='public.cloud_sources'::regclass and l.mode='AccessExclusiveLock' and l.granted;")" -ge 1; then
    lock_ready=1
    break
  fi
  sleep 0.1
done
test "$lock_ready" = 1 || fail "source-table lock was not acquired"

request 'norva-cloud/sources' "$TMP_DIR/cutover.txt" &
REQUEST_PID=$!
request_waiting=0
for _ in $(seq 1 60); do
  if test "$(db_scalar "select count(*) from pg_stat_activity where usename='authenticator' and wait_event_type='Lock';")" -ge 1; then
    request_waiting=1
    break
  fi
  sleep 0.1
done
test "$request_waiting" = 1 || fail "Edge request did not reach the locked catalog query"

db_scalar 'select public.norva_bump_global_catalog_visibility_epoch();' >/dev/null
CUTOVER_TOKEN="$(current_token)"
wait "$LOCKER_PID"
wait "$REQUEST_PID"
assert_response "$TMP_DIR/cutover.txt" 409 "$CUTOVER_TOKEN"
grep -Fq 'CATALOG_VISIBILITY_EPOCH_CHANGED' "$TMP_DIR/cutover.txt" ||
  fail "cutover response did not fail closed with the public epoch-change code"
grep -Fiq 'cache-control: no-store' "$TMP_DIR/cutover.txt" ||
  fail "cutover response is cacheable"
grep -Fiq 'retry-after: 0' "$TMP_DIR/cutover.txt" ||
  fail "cutover response is not marked immediately retryable"

request 'norva-cloud/sources' "$TMP_DIR/cloud-converged.txt"
assert_response "$TMP_DIR/cloud-converged.txt" 200 "$CUTOVER_TOKEN"

test "$(db_scalar "select count(*) from public.admin_feature_flags where enabled and key in ('provider_access_v1_enabled','provider_access_auto_detection_v1_enabled','provider_access_notifications_v1_enabled','provider_access_visibility_v1_enabled','provider_credential_transition_v1_enabled','provider_replacement_v1_enabled');")" = 0 ||
  fail "a Provider Access flag became enabled"
test "$(db_scalar "select phase from public.cloud_catalog_cache_epoch_v2_rollout where singleton;")" = installed ||
  fail "runtime proof completed the rollout unexpectedly"

printf 'PHASE123_EDGE_RUNTIME_PROOF_PASS\n'
printf 'commit=%s\n' "$EXPECTED_COMMIT"
printf 'baseline=%s\n' "$BASE_TOKEN"
printf 'after_warm_bump=%s\n' "$AFTER_WARM_BUMP"
printf 'after_midflight_cutover=%s\n' "$CUTOVER_TOKEN"
printf 'authenticated_surfaces=3\n'
printf 'midflight_cutover_status=409\n'
printf 'provider_access_flags_enabled=0\n'
printf 'rollout_phase=installed\n'
