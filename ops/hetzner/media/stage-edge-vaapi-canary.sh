#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly DEPLOY_ROOT='/home/adrien/norva-media-deployments/53705bd7e404'
readonly MEDIA_DIR="${DEPLOY_ROOT}/ops/hetzner/media"
readonly MEDIA_ENV="${MEDIA_DIR}/.env.media-vaapi"
readonly MIGRATION="${MEDIA_DIR}/20260817213000_media_gateway_canary_route.sql"
readonly MIGRATION_SHA256='f871981b184dc89c1853e89e2d587bf7cfdbd335785f82bfddd0df6bed400ecf'
readonly GATEWAY_CONTAINER='norva-media-gateway'
readonly GATEWAY_IMAGE='norva-media-gateway:vaapi-53705bd7e404'
readonly GATEWAY_IMAGE_ID='sha256:7d4cd36a567785471be857d4b4464755a36b734dab430eb8f6675b51cd8bf3af'
readonly GATEWAY_ID='a7250ec1-171b-4bcf-ad7d-41bac56130ec'
readonly GATEWAY_URL='http://norva-media-gateway:8080'
readonly DB_CONTAINER='norva-db'
readonly CONFIG_KEYS=(
  NORVA_MEDIA_GATEWAY_CANARY_URL
  NORVA_MEDIA_GATEWAY_CANARY_TOKEN
  NORVA_MEDIA_GATEWAY_CANARY_ID
  NORVA_MEDIA_GATEWAY_CANARY_USER_HASHES
)

stage_mutated=0

rollback_partial_stage() {
  local status="$?"
  trap - EXIT
  unset gateway_token 2>/dev/null || true
  if [[ "${status}" -ne 0 && "${stage_mutated}" -eq 1 ]]; then
    set +e
    docker exec -i "${DB_CONTAINER}" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null <<SQL
begin;
delete from public.cloud_runtime_config
where key in (
  'NORVA_MEDIA_GATEWAY_CANARY_URL',
  'NORVA_MEDIA_GATEWAY_CANARY_TOKEN',
  'NORVA_MEDIA_GATEWAY_CANARY_ID',
  'NORVA_MEDIA_GATEWAY_CANARY_USER_HASHES'
);
update public.media_gateways
set status = 'maintenance', last_seen_at = timezone('utc'::text, now())
where id = '${GATEWAY_ID}'::uuid;
commit;
SQL
    echo 'EDGE_VAAPI_CANARY_PARTIAL_STAGE_ROLLED_BACK' >&2
  fi
  exit "${status}"
}

trap rollback_partial_stage EXIT

die() {
  printf 'EDGE_VAAPI_CANARY_STAGE_FAILED:%s\n' "$1" >&2
  exit 1
}

[[ -f "${MEDIA_ENV}" && "$(stat -c '%a' "${MEDIA_ENV}")" == '600' ]] || die 'media-env'
[[ -f "${MIGRATION}" ]] || die 'migration-missing'
echo "${MIGRATION_SHA256}  ${MIGRATION}" | sha256sum -c - >/dev/null || die 'migration-integrity'
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.Config.Image}}')" == "${GATEWAY_IMAGE}" ]] || die 'gateway-image-tag'
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.Image}}')" == "${GATEWAY_IMAGE_ID}" ]] || die 'gateway-image-id'
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.State.Health.Status}}')" == 'healthy' ]] || die 'gateway-health'
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.RestartCount}}')" == '0' ]] || die 'gateway-restarted'
[[ "$(docker inspect "${GATEWAY_CONTAINER}" --format '{{.State.OOMKilled}}')" == 'false' ]] || die 'gateway-oom'
docker inspect "${GATEWAY_CONTAINER}" --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -qx 'NORVA_EDGE_CALLBACK_BASE=http://127.0.0.1:9' || die 'gateway-callback-not-private'

gateway_token="$(sed -n 's/^GATEWAY_TOKEN=//p' "${MEDIA_ENV}")"
[[ "${gateway_token}" =~ ^[A-Za-z0-9._~-]{32,512}$ ]] || die 'gateway-token-invalid'

existing_count="$(
  docker exec "${DB_CONTAINER}" psql -X -U postgres -d postgres -Atc \
    "select count(*) from public.cloud_runtime_config where key = any(array['${CONFIG_KEYS[0]}','${CONFIG_KEYS[1]}','${CONFIG_KEYS[2]}','${CONFIG_KEYS[3]}']);"
)"
[[ "${existing_count}" == '0' ]] || die 'canary-config-already-exists'

echo '===EDGE_TO_PRIVATE_GATEWAY_CONNECTIVITY==='
for edge in norva-edge-functions norva-edge-functions-2; do
  docker exec "${edge}" bash -lc \
    'exec 3<>/dev/tcp/norva-media-gateway/8080; printf "GET /health HTTP/1.0\r\nHost: norva-media-gateway\r\nConnection: close\r\n\r\n" >&3; IFS= read -r status <&3; [[ "$status" == *" 200 "* ]]' \
    || die "edge-connectivity-${edge}"
  printf '%s=reachable\n' "${edge}"
done

docker exec -i "${DB_CONTAINER}" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres \
  < "${MIGRATION}" >/dev/null
stage_mutated=1

docker exec -i "${DB_CONTAINER}" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null <<SQL
begin;
insert into public.cloud_runtime_config (key, value, is_secret, description)
values
  ('NORVA_MEDIA_GATEWAY_CANARY_URL', '${GATEWAY_URL}', true, 'Internal exact-account VAAPI playback canary URL'),
  ('NORVA_MEDIA_GATEWAY_CANARY_TOKEN', '${gateway_token}', true, 'Internal exact-account VAAPI playback canary bearer'),
  ('NORVA_MEDIA_GATEWAY_CANARY_ID', '${GATEWAY_ID}', true, 'Durable media_gateways route identity for exact cleanup'),
  ('NORVA_MEDIA_GATEWAY_CANARY_USER_HASHES', '', true, 'Comma-separated SHA-256 user UUID allowlist; empty means standby')
on conflict (key) do nothing;
update public.media_gateways
set status = 'online', last_seen_at = timezone('utc'::text, now())
where id = '${GATEWAY_ID}'::uuid;
commit;
SQL
unset gateway_token

staged="$(
  docker exec "${DB_CONTAINER}" psql -X -U postgres -d postgres -Atc \
    "select count(*) from public.cloud_runtime_config where key = any(array['${CONFIG_KEYS[0]}','${CONFIG_KEYS[1]}','${CONFIG_KEYS[2]}','${CONFIG_KEYS[3]}']) and is_secret is true;"
)"
[[ "${staged}" == '4' ]] || die 'config-stage-count'
selected_length="$(
  docker exec "${DB_CONTAINER}" psql -X -U postgres -d postgres -Atc \
    "select coalesce((select length(value) from public.cloud_runtime_config where key='NORVA_MEDIA_GATEWAY_CANARY_USER_HASHES'),-1);"
)"
[[ "${selected_length}" == '0' ]] || die 'canary-unexpectedly-selected'

stage_mutated=0
echo '===EDGE_VAAPI_CANARY_STANDBY_OK==='
echo 'routing=standby selected_users=0 gateway=internal callback=private'
