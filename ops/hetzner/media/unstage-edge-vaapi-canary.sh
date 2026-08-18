#!/usr/bin/env bash
set -Eeuo pipefail

readonly DB_CONTAINER='norva-db'
readonly GATEWAY_ID='a7250ec1-171b-4bcf-ad7d-41bac56130ec'

selected_length="$(
  docker exec "${DB_CONTAINER}" psql -X -U postgres -d postgres -Atc \
    "select coalesce((select length(value) from public.cloud_runtime_config where key='NORVA_MEDIA_GATEWAY_CANARY_USER_HASHES'),0);"
)"
[[ "${selected_length}" == '0' ]] || {
  echo 'EDGE_VAAPI_CANARY_UNSTAGE_FAILED:selected-account-still-active' >&2
  exit 1
}

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

echo '===EDGE_VAAPI_CANARY_UNSTAGED_OK==='
