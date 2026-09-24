#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly RELEASE_ROOT="$(cd -- "${SCRIPT_DIR}/../../.." && pwd -P)"
readonly MIGRATION_DIR="${RELEASE_ROOT}/supabase/migrations"
readonly PRIMARY_DB_CONTAINER="${NORVA_MEDIA_CACHE_PRIMARY_DB_CONTAINER:-norva-db}"
readonly CANARY_CONTAINER='norva-media-cache-postgres-canary'
readonly CANARY_VOLUME='norva-media-cache-postgres-canary-data'
readonly CANARY_DATABASE='norva_media_cache_canary'
readonly CANARY_DB_ADMIN='supabase_admin'
readonly MIGRATIONS=(
  20260901203000_media_cache_global_objects_v1.sql
  20260901213000_media_cache_producer_leases_v1.sql
  20260901220000_media_cache_exact_playback_grants_v1.sql
  20260901223000_media_cache_gateway_publication_v1.sql
  20260901224500_media_cache_hot_playback_v1.sql
  20260902093000_media_cache_singleflight_runtime_v1.sql
  20260902094500_media_cache_demand_continuation_v1.sql
  20260902100000_media_cache_live_join_v1.sql
  20260902103000_media_cache_governance_v1.sql
  20260903120000_media_cache_gateway_session_id_cast_v1.sql
)

die() {
  printf 'PRIVATE_MEDIA_CACHE_POSTGRES_CANARY_FAIL:%s\n' "$1" >&2
  exit 1
}

for command_name in docker openssl; do
  command -v "${command_name}" >/dev/null 2>&1 || die "missing-${command_name}"
done
for migration in "${MIGRATIONS[@]}"; do
  [[ -f "${MIGRATION_DIR}/${migration}" ]] || die "missing-${migration}"
done
docker container inspect "${CANARY_CONTAINER}" >/dev/null 2>&1 && die 'container-already-exists'
docker volume inspect "${CANARY_VOLUME}" >/dev/null 2>&1 && die 'volume-already-exists'

[[ "$(docker inspect "${PRIMARY_DB_CONTAINER}" --format '{{.State.Health.Status}}')" == 'healthy' ]] \
  || die 'primary-db-unhealthy'
PRIMARY_IMAGE="$(docker inspect "${PRIMARY_DB_CONTAINER}" --format '{{.Config.Image}}')"
PRIMARY_IMAGE_ID="$(docker inspect "${PRIMARY_DB_CONTAINER}" --format '{{.Image}}')"
PRIMARY_RESTARTS="$(docker inspect "${PRIMARY_DB_CONTAINER}" --format '{{.RestartCount}}')"
PRIMARY_OOM="$(docker inspect "${PRIMARY_DB_CONTAINER}" --format '{{.State.OOMKilled}}')"
readonly PRIMARY_IMAGE PRIMARY_IMAGE_ID PRIMARY_RESTARTS PRIMARY_OOM

# The schema-only clone intentionally omits ACLs. Verify effective permissions
# read-only on production instead of attributing the clone's default PUBLIC
# execute grant to the real service.
rpc_acl="$(docker exec "${PRIMARY_DB_CONTAINER}" psql -X -At -v ON_ERROR_STOP=1 \
  -U "${CANARY_DB_ADMIN}" -d postgres -c "select
  not has_function_privilege('anon','public.norva_authorize_media_cache_playback(uuid,uuid,text,integer)','EXECUTE')
  and not has_function_privilege('authenticated','public.norva_authorize_media_cache_playback(uuid,uuid,text,integer)','EXECUTE')
  and has_function_privilege('service_role','public.norva_authorize_media_cache_playback(uuid,uuid,text,integer)','EXECUTE');")"
[[ "${rpc_acl}" == 't' ]] || die 'production-cache-rpc-acl-invalid'
printf 'production_rpc_acl=verified-read-only\n'

CANARY_DIR="$(mktemp -d /home/adrien/norva-media-cache-postgres-canary.XXXXXX)"
readonly CANARY_DIR
CANARY_STARTED='false'
CANARY_VOLUME_CREATED='false'

cleanup() {
  if [[ "${CANARY_STARTED}" == 'true' ]]; then
    docker stop --time 10 "${CANARY_CONTAINER}" >/dev/null 2>&1 || true
    docker rm -f "${CANARY_CONTAINER}" >/dev/null 2>&1 || true
  fi
  if [[ "${CANARY_VOLUME_CREATED}" == 'true' ]]; then
    docker volume rm -f "${CANARY_VOLUME}" >/dev/null 2>&1 \
      || printf 'PRIVATE_MEDIA_CACHE_POSTGRES_CANARY_WARN:volume-not-removed\n' >&2
  fi
  case "${CANARY_DIR}" in
    /home/adrien/norva-media-cache-postgres-canary.*) rm -rf -- "${CANARY_DIR}" ;;
    *) printf 'PRIVATE_MEDIA_CACHE_POSTGRES_CANARY_WARN:temp-path-not-removed\n' >&2 ;;
  esac
}
trap cleanup EXIT INT TERM

POSTGRES_PASSWORD="$(openssl rand -hex 32)"
readonly POSTGRES_PASSWORD
docker volume create "${CANARY_VOLUME}" >/dev/null
CANARY_VOLUME_CREATED='true'

printf '===START_ISOLATED_POSTGRES===\n'
docker run -d \
  --name "${CANARY_CONTAINER}" \
  --network none \
  --cpus 4 \
  --memory 6g \
  --shm-size 1g \
  --pids-limit 512 \
  -e POSTGRES_PASSWORD="${POSTGRES_PASSWORD}" \
  -e POSTGRES_DB=bootstrap \
  -v "${CANARY_VOLUME}:/var/lib/postgresql/data" \
  "${PRIMARY_IMAGE_ID}" \
  postgres \
    -c config_file=/etc/postgresql/postgresql.conf \
    -c "cron.database_name=${CANARY_DATABASE}" >/dev/null
CANARY_STARTED='true'

ready='false'
for unused in {1..90}; do
  if docker logs "${CANARY_CONTAINER}" 2>&1 \
      | grep -Fq 'PostgreSQL init process complete; ready for start up.' \
    && docker exec "${CANARY_CONTAINER}" psql -X -At \
    -U "${CANARY_DB_ADMIN}" -d bootstrap -c 'select 1' >/dev/null 2>&1; then
    ready='true'
    break
  fi
  sleep 1
done
[[ "${ready}" == 'true' ]] || die 'postgres-start-timeout'
docker exec "${CANARY_CONTAINER}" createdb \
  -U "${CANARY_DB_ADMIN}" -T template0 -O "${CANARY_DB_ADMIN}" "${CANARY_DATABASE}"

printf '===RESTORE_SCHEMA_ONLY===\n'
docker exec "${PRIMARY_DB_CONTAINER}" pg_dump \
  -U postgres -d postgres --schema-only --no-owner --no-privileges \
  > "${CANARY_DIR}/schema.sql"
[[ -s "${CANARY_DIR}/schema.sql" ]] || die 'schema-dump-empty'
if grep -Eq '^COPY |^INSERT INTO ' "${CANARY_DIR}/schema.sql"; then
  die 'schema-dump-contained-data'
fi
docker exec -i "${CANARY_CONTAINER}" psql \
  -X -v ON_ERROR_STOP=1 -U "${CANARY_DB_ADMIN}" -d "${CANARY_DATABASE}" \
  < "${CANARY_DIR}/schema.sql" >/dev/null


printf '===MEDIA_CACHE_AUTHORITY_RUNTIME===\n'
docker exec -i "${CANARY_CONTAINER}" psql -X -v ON_ERROR_STOP=1 -U "${CANARY_DB_ADMIN}" -d "${CANARY_DATABASE}" < "${SCRIPT_DIR}/media-cache-authority-runtime.sql"
[[ "$(docker inspect "${PRIMARY_DB_CONTAINER}" --format '{{.RestartCount}}')" == "${PRIMARY_RESTARTS}" ]] || die 'primary-restarted'
printf 'MEDIA_CACHE_AUTHORITY_RUNTIME_PASS\n'
