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

printf '===APPLY_MEDIA_CACHE_MIGRATIONS===\n'
for migration in "${MIGRATIONS[@]}"; do
  docker exec -i "${CANARY_CONTAINER}" psql \
    -X -v ON_ERROR_STOP=1 -U "${CANARY_DB_ADMIN}" -d "${CANARY_DATABASE}" \
    < "${MIGRATION_DIR}/${migration}" >/dev/null
  printf 'applied=%s\n' "${migration}"
done

printf '===SEED_GOVERNANCE_CONCURRENCY===\n'
docker exec -i "${CANARY_CONTAINER}" psql \
  -X -v ON_ERROR_STOP=1 -U "${CANARY_DB_ADMIN}" -d "${CANARY_DATABASE}" >/dev/null <<'SQL'
create function public.norva_media_cache_canary_seed_object(
  p_object_key text,
  p_identity_digest text,
  p_total_bytes bigint,
  p_retention_expired boolean default false
) returns void
language plpgsql
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
begin
  insert into public.media_cache_objects (
    object_key, content_sha256, file_size_bytes, video_profile_sha256,
    audio_topology_sha256, subtitle_topology_sha256, duration_milliseconds,
    pipeline_build, segmenter_build, state, storage_backend, object_prefix,
    root_playlist, manifest_sha256, total_bytes, file_count, popularity_count,
    created_at, ready_at, expires_at, retention_until, last_verified_at
  ) values (
    p_object_key, p_identity_digest, greatest(p_total_bytes, 1024),
    p_identity_digest, p_identity_digest, p_identity_digest, 60000,
    'canary-pipeline-v1', 'canary-segmenter-v1', 'ready', 'r2',
    'media-cache/v1/' || substr(p_object_key, 1, 2) || '/' || p_object_key || '/',
    'index.m3u8', p_identity_digest, p_total_bytes, 4, 0,
    v_now - interval '2 days', v_now - interval '2 days', v_now + interval '7 days',
    case when p_retention_expired then v_now - interval '1 minute' else v_now + interval '1 day' end,
    v_now
  );
end
$function$;

select public.norva_media_cache_canary_seed_object(
  repeat('a1', 32), repeat('b1', 32), 1048576, false
);

do $canary$
begin
  if to_regclass('public.media_cache_governance_policy') is null
     or to_regclass('public.media_cache_purge_jobs') is null
     or to_regprocedure('public.norva_commit_admitted_media_cache_publication(uuid,uuid,uuid,text,text,bigint,text,text,text,bigint,text,text,text,text,text,bigint,integer,timestamp with time zone)') is null then
    raise exception 'governance objects missing after migration';
  end if;
  if (select admission_mode from public.media_cache_governance_policy where singleton) <> 'off' then
    raise exception 'admission did not default fail-closed';
  end if;
end
$canary$;
SQL

docker exec "${CANARY_CONTAINER}" psql -X -At -v ON_ERROR_STOP=1 \
  -U "${CANARY_DB_ADMIN}" -d "${CANARY_DATABASE}" \
  -c "select public.norva_enqueue_media_cache_purge(repeat('a1', 32), 'corruption');" \
  > "${CANARY_DIR}/enqueue-corruption.out" &
enqueue_corruption_pid=$!
docker exec "${CANARY_CONTAINER}" psql -X -At -v ON_ERROR_STOP=1 \
  -U "${CANARY_DB_ADMIN}" -d "${CANARY_DATABASE}" \
  -c "select public.norva_enqueue_media_cache_purge(repeat('a1', 32), 'security');" \
  > "${CANARY_DIR}/enqueue-security.out" &
enqueue_security_pid=$!
wait "${enqueue_corruption_pid}"
wait "${enqueue_security_pid}"

docker exec -i "${CANARY_CONTAINER}" psql \
  -X -v ON_ERROR_STOP=1 -U "${CANARY_DB_ADMIN}" -d "${CANARY_DATABASE}" >/dev/null <<'SQL'
do $canary$
begin
  if (select count(*) from public.media_cache_purge_jobs
       where object_key = repeat('a1', 32) and state in ('queued', 'leased', 'retry')) <> 1 then
    raise exception 'concurrent enqueue did not converge on one active job';
  end if;
  if (select reason from public.media_cache_purge_jobs
       where object_key = repeat('a1', 32) and state in ('queued', 'leased', 'retry')) <> 'security' then
    raise exception 'strongest concurrent purge reason did not win';
  end if;
end
$canary$;
SQL

printf '===CLAIM_SKIP_LOCKED_CONCURRENCY===\n'
docker exec "${CANARY_CONTAINER}" psql -X -At -F '|' -v ON_ERROR_STOP=1 \
  -U "${CANARY_DB_ADMIN}" -d "${CANARY_DATABASE}" \
  -c "select * from public.norva_claim_media_cache_purge(repeat('11', 32), 120);" \
  > "${CANARY_DIR}/claim-one.out" &
claim_one_pid=$!
docker exec "${CANARY_CONTAINER}" psql -X -At -F '|' -v ON_ERROR_STOP=1 \
  -U "${CANARY_DB_ADMIN}" -d "${CANARY_DATABASE}" \
  -c "select * from public.norva_claim_media_cache_purge(repeat('22', 32), 120);" \
  > "${CANARY_DIR}/claim-two.out" &
claim_two_pid=$!
wait "${claim_one_pid}"
wait "${claim_two_pid}"
claim_count=0
[[ -s "${CANARY_DIR}/claim-one.out" ]] && claim_count=$((claim_count + 1))
[[ -s "${CANARY_DIR}/claim-two.out" ]] && claim_count=$((claim_count + 1))
[[ "${claim_count}" == '1' ]] || die 'skip-locked-double-claim'

printf '===PURGE_RECOVERY_RETRY_QUOTA===\n'
docker exec -i "${CANARY_CONTAINER}" psql \
  -X -v ON_ERROR_STOP=1 -U "${CANARY_DB_ADMIN}" -d "${CANARY_DATABASE}" <<'SQL'
do $canary$
declare
  v_claim record;
  v_status text;
  v_job uuid;
  v_recovered boolean;
  v_iteration integer;
  v_scheduled integer;
  v_summary jsonb;
begin
  select * into v_claim
    from public.media_cache_purge_jobs job
   where job.object_key = repeat('a1', 32) and job.state = 'leased';
  if not found then raise exception 'security purge was not leased'; end if;
  v_status := public.norva_complete_media_cache_purge(
    v_claim.id, v_claim.lease_owner_fingerprint, v_claim.lease_token,
    v_claim.reason, true, null
  );
  if v_status <> 'completed' then raise exception 'security purge completion failed: %', v_status; end if;
  if (select state from public.media_cache_objects where object_key = repeat('a1', 32)) <> 'purged' then
    raise exception 'security object was not physically purged';
  end if;
  v_recovered := public.norva_recover_media_cache_object(
    repeat('a1', 32), repeat('b1', 32), repeat('b1', 32), repeat('b1', 32),
    repeat('b1', 32), 'index.m3u8', repeat('b1', 32), 1048576, 4,
    clock_timestamp() + interval '1 day'
  );
  if v_recovered then raise exception 'security tombstone recovered'; end if;

  perform public.norva_media_cache_canary_seed_object(
    repeat('a2', 32), repeat('b2', 32), 2097152, false
  );
  v_job := public.norva_enqueue_media_cache_purge(repeat('a2', 32), 'corruption');
  select * into v_claim from public.norva_claim_media_cache_purge(repeat('33', 32), 120);
  if v_claim.job_id <> v_job then raise exception 'corruption purge was not claimed'; end if;
  v_status := public.norva_complete_media_cache_purge(
    v_claim.job_id, repeat('33', 32), v_claim.lease_token, 'corruption', true, null
  );
  if v_status <> 'completed' then raise exception 'corruption purge completion failed: %', v_status; end if;
  v_recovered := public.norva_recover_media_cache_object(
    repeat('a2', 32), repeat('b2', 32), repeat('b2', 32), repeat('b2', 32),
    repeat('b2', 32), 'index.m3u8', repeat('c2', 32), 2097152, 4,
    clock_timestamp() + interval '1 day'
  );
  if not v_recovered then raise exception 'verified corruption recovery failed'; end if;

  perform public.norva_media_cache_canary_seed_object(
    repeat('a6', 32), repeat('b6', 32), 3145728, false
  );
  v_job := public.norva_enqueue_media_cache_purge(repeat('a6', 32), 'security');
  for v_iteration in 1..12 loop
    update public.media_cache_purge_jobs set available_at = clock_timestamp() where id = v_job;
    select * into v_claim from public.norva_claim_media_cache_purge(repeat('66', 32), 120);
    if v_claim.job_id <> v_job then raise exception 'critical retry claim % failed', v_iteration; end if;
    v_status := public.norva_complete_media_cache_purge(
      v_claim.job_id, repeat('66', 32), v_claim.lease_token, 'security', false, 'simulated_outage'
    );
    if v_iteration < 12 and v_status <> 'retry' then
      raise exception 'critical retry % returned %', v_iteration, v_status;
    end if;
    if v_iteration = 12 and v_status <> 'failed' then
      raise exception 'critical retry exhaustion returned %', v_status;
    end if;
  end loop;
  update public.media_cache_purge_jobs set available_at = clock_timestamp() where id = v_job;
  v_scheduled := public.norva_schedule_media_cache_evictions(25);
  if (select state from public.media_cache_purge_jobs where id = v_job) <> 'queued'
     or (select attempts from public.media_cache_purge_jobs where id = v_job) <> 0 then
    raise exception 'critical purge did not rearm';
  end if;
  select * into v_claim from public.norva_claim_media_cache_purge(repeat('66', 32), 120);
  v_status := public.norva_complete_media_cache_purge(
    v_claim.job_id, repeat('66', 32), v_claim.lease_token, 'security', true, null
  );
  if v_status <> 'completed' then raise exception 'rearmed critical purge failed: %', v_status; end if;

  v_job := public.norva_enqueue_media_cache_purge(repeat('af', 32), 'orphan');
  if v_job is null or not exists (
    select 1 from public.media_cache_purge_jobs
     where id = v_job and reason = 'orphan'
       and available_at >= clock_timestamp() + interval '14 minutes'
  ) then raise exception 'orphan purge was not delayed'; end if;

  perform public.norva_media_cache_canary_seed_object(
    repeat('a3', 32), repeat('b3', 32), 629145600, true
  );
  perform public.norva_media_cache_canary_seed_object(
    repeat('a4', 32), repeat('b4', 32), 629145600, true
  );
  update public.media_cache_governance_policy
     set r2_max_bytes = 1073741824, r2_max_objects = 1000
   where singleton;
  v_scheduled := public.norva_schedule_media_cache_evictions(25);
  if v_scheduled < 1 or not exists (
    select 1 from public.media_cache_purge_jobs where reason = 'eviction'
      and state in ('queued', 'leased', 'retry')
  ) then raise exception 'quota eviction was not scheduled'; end if;

  if not public.norva_record_media_cache_metric(
    'storage_bytes', 100, 1, 'l2', 'global', 'none', 'none', 'none', null, null
  ) or not public.norva_record_media_cache_metric(
    'storage_bytes', 20, 1, 'l2', 'global', 'none', 'none', 'none', null, null
  ) then raise exception 'storage gauge was rejected'; end if;
  v_summary := public.norva_media_cache_observability_summary(24);
  if (v_summary #>> '{metrics,storage_bytes,value}')::numeric <> 20 then
    raise exception 'storage metric was not a gauge: %', v_summary;
  end if;

  update public.media_cache_governance_policy set admission_mode = 'enforced' where singleton;
  perform * from public.norva_record_media_cache_demand(repeat('d1', 32), repeat('e1', 32), 20);
  perform * from public.norva_record_media_cache_demand(repeat('d1', 32), repeat('e1', 32), 20);
  if not exists (
    select 1 from public.media_cache_admission_decisions
     where work_fingerprint = repeat('d1', 32)
       and recommended and admitted and reason = 'repeated'
  ) then raise exception 'enforced repeated demand was not admitted'; end if;
end
$canary$;

select jsonb_build_object(
  'ok', true,
  'protocol', 1,
  'migrations', 10,
  'activePurgeJobs', count(*) filter (where state in ('queued', 'leased', 'retry')),
  'completedPurges', count(*) filter (where state = 'completed'),
  'failedPurges', count(*) filter (where state = 'failed'),
  'securityTombstones', count(*) filter (where reason = 'security'),
  'corruptionRecovered', count(*) filter (where reason = 'corruption' and recovery_cleared_at is not null)
) as canary_receipt
from public.media_cache_purge_jobs;

drop function public.norva_media_cache_canary_seed_object(text, text, bigint, boolean);
SQL

[[ "$(docker inspect "${PRIMARY_DB_CONTAINER}" --format '{{.Config.Image}}')" == "${PRIMARY_IMAGE}" ]] \
  || die 'primary-db-image-drift'
[[ "$(docker inspect "${PRIMARY_DB_CONTAINER}" --format '{{.Image}}')" == "${PRIMARY_IMAGE_ID}" ]] \
  || die 'primary-db-id-drift'
[[ "$(docker inspect "${PRIMARY_DB_CONTAINER}" --format '{{.State.Health.Status}}')" == 'healthy' ]] \
  || die 'primary-db-health-drift'
[[ "$(docker inspect "${PRIMARY_DB_CONTAINER}" --format '{{.RestartCount}}')" == "${PRIMARY_RESTARTS}" ]] \
  || die 'primary-db-restart-drift'
[[ "$(docker inspect "${PRIMARY_DB_CONTAINER}" --format '{{.State.OOMKilled}}')" == "${PRIMARY_OOM}" ]] \
  || die 'primary-db-oom-drift'

printf '===PRIVATE_MEDIA_CACHE_POSTGRES_CANARY_OK===\n'
printf 'primary_image=%s primary_id=%s migrations=%s schema_bytes=%s\n' \
  "${PRIMARY_IMAGE}" "${PRIMARY_IMAGE_ID}" "${#MIGRATIONS[@]}" "$(wc -c < "${CANARY_DIR}/schema.sql")"
