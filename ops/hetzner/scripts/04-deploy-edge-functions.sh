#!/usr/bin/env bash
# =============================================================================
# 04-deploy-edge-functions.sh — reload configured norva-* functions on self-host
# =============================================================================
# In the self-host stack, edge functions are NOT "deployed" to a remote — the
# `functions` (edge-runtime) container serves them directly from the repo's
# supabase/functions dir, which the compose mounts read-only. "Deploying" =
# sync the code + recreate each runtime so it re-reads both code and env.
#
# This script:
#   1. sanity-checks that every function in supabase/config.toml has a dir,
#   2. validates the rendered Compose configuration without printing it,
#   3. recreates every configured edge-runtime replica one at a time.
#
# A DB/Edge protocol change must not use the rolling path while an older
# replica could still perform provider I/O. For that case:
#   docker compose --env-file .env -f docker-compose.supabase.yml stop functions functions2
#   # apply the reviewed migrations while both runtimes are stopped
#   NORVA_EDGE_QUIESCED_DEPLOY=1 bash ops/hetzner/scripts/04-deploy-edge-functions.sh
# Quiesced mode refuses to start unless every runtime is stopped and the M3U
# single-flight RPC is already present. This closes the old-code/new-schema
# window instead of relying on health markers after the fact.
#
# GitHub CI validates the functions but does not deploy them to the Hetzner
# runtime. Until an explicit SSH deploy workflow exists, production deployment
# is a reviewed manual operation: update the checkout, then run this script.
# `supabase/config.toml` is only the checked-in function inventory used by the
# sanity check below. Runtime authentication is configured by Compose and by
# each function's own authorization boundary.
# =============================================================================
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
FUNCS_DIR="$REPO/supabase/functions"
CONFIG="$REPO/supabase/config.toml"
COMPOSE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/docker-compose.supabase.yml"
ENV_FILE="$(dirname "$COMPOSE")/.env"
EXPECTED_PLAYBACK_VERSION=80
EXPECTED_PLAYBACK_PROTOCOL=1
EXPECTED_EXACT_TRACK_CRAWLER_PROTOCOL=2
EXPECTED_BASIC_LID_CONSENSUS_PROTOCOL=2
EXPECTED_VOD_CONTAINER_SELF_HEAL_PROTOCOL=1
EXPECTED_MEDIA_GATEWAY_CANARY_ROUTING_PROTOCOL=1
EXPECTED_RELAY_TAKEOVER_PROTOCOL=1
EXPECTED_RELAY_COORDINATOR_LOCK_TTL_MS=120000
EXPECTED_ENGINE_TRACK_PROBE_BLOCKING=false
EXPECTED_EXACT_FILE_CODEC_PROFILE_PROTOCOL=1
EXPECTED_LANGUAGE_VALIDATION_PROTOCOL=2
EXPECTED_LANGUAGE_VALIDATION_PRESENCE_INTENT_PROTOCOL=1
EXPECTED_LANGUAGE_VALIDATION_PLAYBACK_LEASE_PROTOCOL=1
EXPECTED_LANGUAGE_VALIDATION_ACTIVITY_PROTOCOL=1
EXPECTED_LANGUAGE_VALIDATION_DURATION_CLAIM_PROTOCOL=1
EXPECTED_LANGUAGE_VALIDATION_WINDOW_CHECKPOINT_PROTOCOL=1
EXPECTED_LANGUAGE_VALIDATION_TASK_BUDGET_MS=270000
EXPECTED_LANGUAGE_VALIDATION_FETCH_TIMEOUT_MS=240000
EXPECTED_LANGUAGE_VALIDATION_POST_FETCH_RESERVE_MS=30000
EXPECTED_LANGUAGE_VALIDATION_JOB_LEASE_SECONDS=300
EXPECTED_LANGUAGE_VALIDATION_SAMPLE_DURATION_SECONDS=20
EXPECTED_LANGUAGE_VALIDATION_RETRY_WORKER_PROTOCOL=1
EXPECTED_LANGUAGE_VALIDATION_RETRY_WORKER_BATCH=2
EXPECTED_LANGUAGE_VALIDATION_GATEWAY_FAILURE_RETRY_SECONDS=300
EXPECTED_LANGUAGE_VALIDATION_PROVIDER_ATTEMPT_PROTOCOL=1
EXPECTED_LANGUAGE_VALIDATION_VIEWER_PREEMPTION_PROTOCOL=1
EXPECTED_LANGUAGE_VALIDATION_MAX_CONSECUTIVE_PROVIDER_NO_PROGRESS=4
EXPECTED_AUTOMATIC_STRICT_UND_AUDIO_PROTOCOL=1
EXPECTED_AUTOMATIC_STRICT_UND_AUDIO_CONSENSUS=4/6
EXPECTED_CLOUD_VERSION=27
EXPECTED_CLOUD_PROTOCOL=1
EXPECTED_SOURCE_DESIRED_STATE_PROTOCOL=1
EXPECTED_LEGACY_SOURCE_TOGGLE_BRIDGE=1
EXPECTED_CATALOG_VERSION=7
EXPECTED_FLAT_CODEC_PROFILE_PROTOCOL=1
EXPECTED_EXACT_TRACK_PERSISTENCE_PROTOCOL=2
EXPECTED_SOURCE_SYNC_VERSION=17
EXPECTED_CLOUD_AUTO_REFRESH_CLAIM_PROTOCOL=1
EXPECTED_SOURCE_REENABLE_RESUME_PROTOCOL=1
EXPECTED_M3U_SYNC_LEASE_PROTOCOL=2
EXPECTED_M3U_STREAMING_IMPORT_PROTOCOL=1
EXPECTED_FILE_AUDIO_REPAIR_COHORT_PROTOCOL=2
EXPECTED_TMDB_SEARCH_POLICY=promax-multilang-v2
EXPECTED_AUTH_EMAIL_CHALLENGE_PROTOCOL=1
REQUIRE_QUIESCED_EDGE_DEPLOY=1

[[ -d "$FUNCS_DIR" ]] || { echo "ERROR: $FUNCS_DIR not found" >&2; exit 1; }

echo ">> Verifying each configured function has a directory"
missing=0
# Extract [functions.NAME] headers from config.toml and check the dir exists.
mapfile -t configured_functions < <(
  grep -oE '^\[functions\.[a-z0-9-]+\]' "$CONFIG" |
    sed -E 's/^\[functions\.(.*)\]$/\1/'
)
if [[ ${#configured_functions[@]} -eq 0 ]]; then
  echo "ERROR: no functions declared in $CONFIG" >&2
  exit 1
fi

for fn in "${configured_functions[@]}"; do
  if [[ -d "$FUNCS_DIR/$fn" ]]; then
    echo "   ok   $fn"
  else
    echo "   MISS $fn  (declared in config.toml, no dir)" >&2
    missing=1
  fi
done
if (( missing != 0 )); then
  echo "ERROR: one or more functions declared in $CONFIG are missing" >&2
  exit 1
fi

declared=${#configured_functions[@]}
present=$(find "$FUNCS_DIR" -maxdepth 1 -mindepth 1 -type d -name 'norva-*' | wc -l | tr -d ' ')
echo ">> config.toml declares $declared functions; $present norva-* dirs present."

echo ">> Recreating edge-runtime replicas to reload code and environment"
if command -v docker >/dev/null 2>&1 && [[ -f "$COMPOSE" ]]; then
  command -v curl >/dev/null 2>&1 || {
    echo "ERROR: curl is required for per-replica protocol verification" >&2
    exit 1
  }
  [[ -f "$ENV_FILE" ]] || {
    echo "ERROR: $ENV_FILE not found" >&2
    exit 1
  }
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE" config --quiet

  # Kong round-robins across functions, functions2, ... . Discover the compose
  # services so a deploy cannot leave a stale replica serving old code.
  mapfile -t function_services < <(
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE" config --services |
      grep -E '^functions[0-9]*$'
  )
  if [[ ${#function_services[@]} -eq 0 ]]; then
    echo "ERROR: no edge-runtime service found in $COMPOSE" >&2
    exit 1
  fi

  if [[ "$REQUIRE_QUIESCED_EDGE_DEPLOY" == "1" \
      && "${NORVA_EDGE_QUIESCED_DEPLOY:-0}" != "1" ]]; then
    echo "ERROR: this Edge/DB protocol release requires NORVA_EDGE_QUIESCED_DEPLOY=1; rolling deploy is refused" >&2
    exit 1
  fi

  if [[ "${NORVA_EDGE_QUIESCED_DEPLOY:-0}" == "1" ]]; then
    running_services=()
    for service in "${function_services[@]}"; do
      if [[ -n "$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE" ps -q "$service")" ]]; then
        running_services+=("$service")
      fi
    done
    if [[ ${#running_services[@]} -ne 0 ]]; then
      echo "ERROR: quiesced deploy requires every edge-runtime replica to be stopped first: ${running_services[*]}" >&2
      exit 1
    fi

    protocol_rpcs_ready="$({
      docker compose --env-file "$ENV_FILE" -f "$COMPOSE" exec -T db \
        psql -X -A -t -v ON_ERROR_STOP=1 -U supabase_admin -d postgres \
        -c "select bool_and(to_regprocedure(signature) is not null) from unnest(array[
          'public.norva_claim_source_m3u_sync_lease(uuid,uuid,uuid,integer)',
          'public.norva_claim_source_m3u_diagnostic_lease(uuid,uuid,uuid,integer)',
          'public.norva_renew_source_m3u_sync_lease(uuid,uuid,uuid,integer)',
          'public.norva_settle_source_m3u_sync_lease(uuid,uuid,uuid,text,text)',
          'public.norva_settle_cloud_auto_refresh_source(uuid,uuid,text,bigint,text,timestamptz,integer,text)',
          'public.catalog_file_audio_repair_candidates(uuid,uuid,integer)',
          'public.norva_start_catalog_file_audio_repair_attempt(uuid,uuid,uuid,uuid)',
          'public.norva_cancel_catalog_file_audio_repair_pre_spawn_attempt(uuid,uuid,uuid,uuid,text,integer)',
          'public.norva_defer_catalog_file_audio_repair_candidate(uuid,uuid,uuid,uuid,text,integer)',
          'public.start_automatic_catalog_file_audio_validation_job(uuid,uuid,uuid,text,text,text,integer[],jsonb,text,timestamptz,bigint,jsonb,boolean)'
        ]) as required(signature);"
    } | tr -d '[:space:]')"
    [[ "$protocol_rpcs_ready" == "t" ]] || {
      echo "ERROR: quiesced deploy requires every reviewed M3U/repair RPC signature before edge-runtime restart" >&2
      exit 1
    }

    auto_refresh_settle_contract_ready="$({
      docker compose --env-file "$ENV_FILE" -f "$COMPOSE" exec -T db \
        psql -X -A -t -v ON_ERROR_STOP=1 -U supabase_admin -d postgres \
        -c "with installed as (
          select lower(regexp_replace(
            pg_get_functiondef(to_regprocedure('public.norva_settle_cloud_auto_refresh_source(uuid,uuid,text,bigint,text,timestamptz,integer,text)')),
            '[[:space:]]+', ' ', 'g'
          )) as definition
        )
        select coalesce(
          position('p_outcome is null' in definition) > 0
          and position('p_http_status is null' in definition) > 0
          and position('p_error_kind is null' in definition) > 0
          and position('p_outcome = ''action_required''' in definition) > 0
          and position('p_http_status = 409 and p_error_kind = ''m3u_quarantined''' in definition) > 0
          and position('when p_error_kind = ''m3u_quarantined'' then ''toggle_source''' in definition) > 0,
          false
        )
        from installed;"
    } | tr -d '[:space:]')"
    [[ "$auto_refresh_settle_contract_ready" == "t" ]] || {
      echo "ERROR: quiesced deploy requires the reviewed fail-closed M3U quarantine settlement body before edge-runtime restart" >&2
      exit 1
    }
    echo ">> Quiesced protocol deployment verified: all Edge replicas stopped; exact M3U/repair RPC schema and quarantine settlement body present"
  fi

  file_digest_in_service() {
    local service="$1"
    local path="$2"
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE" exec -T "$service" \
      sha256sum "$path" | awk '{print $1}'
  }

  function_health_in_service() {
    local service="$1"
    local function_name="$2"
    local container_id
    local container_ip
    container_id="$(
      docker compose --env-file "$ENV_FILE" -f "$COMPOSE" ps -q "$service"
    )"
    [[ -n "$container_id" ]] || {
      echo "ERROR: $service has no container for health verification" >&2
      return 1
    }
    container_ip="$(
      docker inspect --format \
        '{{range .NetworkSettings.Networks}}{{println .IPAddress}}{{end}}' \
        "$container_id" | sed -n '1p'
    )"
    [[ -n "$container_ip" ]] || {
      echo "ERROR: $service has no container IP for health verification" >&2
      return 1
    }
    curl --fail --silent --show-error --max-time 10 \
      "http://${container_ip}:9000/${function_name}/health"
  }

  verify_function_protocol() {
    local service="$1"
    local playback_path="/home/deno/functions/norva-playback/index.ts"
    local main_path="/home/deno/functions/main/index.ts"
    local cloud_path="/home/deno/functions/norva-cloud/index.ts"
    local catalog_path="/home/deno/functions/norva-catalog/index.ts"
    local provider_access_path="/home/deno/functions/norva-provider-access/index.ts"
    local account_delete_path="/home/deno/functions/norva-account-delete/index.ts"
    local source_sync_path="/home/deno/functions/norva-source-sync/index.ts"
    local auth_challenge_path="/home/deno/functions/norva-auth-challenge/index.ts"
    local database_conflict_path="/home/deno/functions/_shared/database-conflict.ts"
    local live_materialization_path="/home/deno/functions/_shared/live-materialization.ts"
    local expected_playback_digest
    local expected_main_digest
    local expected_cloud_digest
    local expected_catalog_digest
    local expected_provider_access_digest
    local expected_account_delete_digest
    local expected_source_sync_digest
    local expected_auth_challenge_digest
    local expected_database_conflict_digest
    local expected_live_materialization_digest
    local observed_playback_digest
    local observed_main_digest
    local observed_cloud_digest
    local observed_catalog_digest
    local observed_provider_access_digest
    local observed_account_delete_digest
    local observed_source_sync_digest
    local observed_auth_challenge_digest
    local observed_database_conflict_digest
    local observed_live_materialization_digest
    local playback_health
    local cloud_health
    local catalog_health
    local source_sync_health
    local auth_challenge_health

    expected_playback_digest="$(sha256sum "$FUNCS_DIR/norva-playback/index.ts" | awk '{print $1}')"
    expected_main_digest="$(sha256sum "$FUNCS_DIR/main/index.ts" | awk '{print $1}')"
    expected_cloud_digest="$(sha256sum "$FUNCS_DIR/norva-cloud/index.ts" | awk '{print $1}')"
    expected_catalog_digest="$(sha256sum "$FUNCS_DIR/norva-catalog/index.ts" | awk '{print $1}')"
    expected_provider_access_digest="$(sha256sum "$FUNCS_DIR/norva-provider-access/index.ts" | awk '{print $1}')"
    expected_account_delete_digest="$(sha256sum "$FUNCS_DIR/norva-account-delete/index.ts" | awk '{print $1}')"
    expected_source_sync_digest="$(sha256sum "$FUNCS_DIR/norva-source-sync/index.ts" | awk '{print $1}')"
    expected_auth_challenge_digest="$(sha256sum "$FUNCS_DIR/norva-auth-challenge/index.ts" | awk '{print $1}')"
    expected_database_conflict_digest="$(sha256sum "$FUNCS_DIR/_shared/database-conflict.ts" | awk '{print $1}')"
    expected_live_materialization_digest="$(sha256sum "$FUNCS_DIR/_shared/live-materialization.ts" | awk '{print $1}')"
    observed_playback_digest="$(file_digest_in_service "$service" "$playback_path")"
    observed_main_digest="$(file_digest_in_service "$service" "$main_path")"
    observed_cloud_digest="$(file_digest_in_service "$service" "$cloud_path")"
    observed_catalog_digest="$(file_digest_in_service "$service" "$catalog_path")"
    observed_provider_access_digest="$(file_digest_in_service "$service" "$provider_access_path")"
    observed_account_delete_digest="$(file_digest_in_service "$service" "$account_delete_path")"
    observed_source_sync_digest="$(file_digest_in_service "$service" "$source_sync_path")"
    observed_auth_challenge_digest="$(file_digest_in_service "$service" "$auth_challenge_path")"
    observed_database_conflict_digest="$(file_digest_in_service "$service" "$database_conflict_path")"
    observed_live_materialization_digest="$(file_digest_in_service "$service" "$live_materialization_path")"
    [[ "$observed_playback_digest" == "$expected_playback_digest" ]] || {
      echo "ERROR: $service norva-playback source digest mismatch" >&2
      exit 1
    }
    [[ "$observed_main_digest" == "$expected_main_digest" ]] || {
      echo "ERROR: $service main router source digest mismatch" >&2
      exit 1
    }
    [[ "$observed_cloud_digest" == "$expected_cloud_digest" ]] || {
      echo "ERROR: $service norva-cloud source digest mismatch" >&2
      exit 1
    }
    [[ "$observed_catalog_digest" == "$expected_catalog_digest" ]] || {
      echo "ERROR: $service norva-catalog source digest mismatch" >&2
      exit 1
    }
    [[ "$observed_provider_access_digest" == "$expected_provider_access_digest" ]] || {
      echo "ERROR: $service norva-provider-access source digest mismatch" >&2
      exit 1
    }
    [[ "$observed_account_delete_digest" == "$expected_account_delete_digest" ]] || {
      echo "ERROR: $service norva-account-delete source digest mismatch" >&2
      exit 1
    }
    [[ "$observed_source_sync_digest" == "$expected_source_sync_digest" ]] || {
      echo "ERROR: $service norva-source-sync source digest mismatch" >&2
      exit 1
    }
    [[ "$observed_auth_challenge_digest" == "$expected_auth_challenge_digest" ]] || {
      echo "ERROR: $service norva-auth-challenge source digest mismatch" >&2
      exit 1
    }
    [[ "$observed_database_conflict_digest" == "$expected_database_conflict_digest" ]] || {
      echo "ERROR: $service shared database-conflict source digest mismatch" >&2
      exit 1
    }
    [[ "$observed_live_materialization_digest" == "$expected_live_materialization_digest" ]] || {
      echo "ERROR: $service shared live-materialization source digest mismatch" >&2
      exit 1
    }

    playback_health="$(function_health_in_service "$service" norva-playback)"
    cloud_health="$(function_health_in_service "$service" norva-cloud)"
    catalog_health="$(function_health_in_service "$service" norva-catalog)"
    source_sync_health="$(function_health_in_service "$service" norva-source-sync)"
    auth_challenge_health="$(function_health_in_service "$service" norva-auth-challenge)"
    [[ "$playback_health" == *"\"version\":$EXPECTED_PLAYBACK_VERSION"* \
        && "$playback_health" == *"\"providerCircuitProtocol\":$EXPECTED_PLAYBACK_PROTOCOL"* \
        && "$playback_health" == *"\"exactTrackCrawlerProtocol\":$EXPECTED_EXACT_TRACK_CRAWLER_PROTOCOL"* \
        && "$playback_health" == *"\"basicLidConsensusProtocol\":$EXPECTED_BASIC_LID_CONSENSUS_PROTOCOL"* \
        && "$playback_health" == *"\"vodContainerSelfHealProtocol\":$EXPECTED_VOD_CONTAINER_SELF_HEAL_PROTOCOL"* \
        && "$playback_health" == *"\"relayTakeoverProtocol\":$EXPECTED_RELAY_TAKEOVER_PROTOCOL"* \
        && "$playback_health" == *"\"relayCoordinatorLockTtlMs\":$EXPECTED_RELAY_COORDINATOR_LOCK_TTL_MS"* \
        && "$playback_health" == *"\"engineTrackProbeBlocking\":$EXPECTED_ENGINE_TRACK_PROBE_BLOCKING"* \
        && "$playback_health" == *"\"exactFileCodecProfileProtocol\":$EXPECTED_EXACT_FILE_CODEC_PROFILE_PROTOCOL"* \
        && "$playback_health" == *"\"languageValidationProtocol\":$EXPECTED_LANGUAGE_VALIDATION_PROTOCOL"* \
        && "$playback_health" == *"\"languageValidationPresenceIntentProtocol\":$EXPECTED_LANGUAGE_VALIDATION_PRESENCE_INTENT_PROTOCOL"* \
        && "$playback_health" == *"\"languageValidationPlaybackLeaseProtocol\":$EXPECTED_LANGUAGE_VALIDATION_PLAYBACK_LEASE_PROTOCOL"* \
        && "$playback_health" == *"\"languageValidationActivityProtocol\":$EXPECTED_LANGUAGE_VALIDATION_ACTIVITY_PROTOCOL"* \
        && "$playback_health" == *"\"languageValidationDurationClaimProtocol\":$EXPECTED_LANGUAGE_VALIDATION_DURATION_CLAIM_PROTOCOL"* \
        && "$playback_health" == *"\"languageValidationWindowCheckpointProtocol\":$EXPECTED_LANGUAGE_VALIDATION_WINDOW_CHECKPOINT_PROTOCOL"* \
        && "$playback_health" == *"\"languageValidationTaskBudgetMs\":$EXPECTED_LANGUAGE_VALIDATION_TASK_BUDGET_MS"* \
        && "$playback_health" == *"\"languageValidationFetchTimeoutMs\":$EXPECTED_LANGUAGE_VALIDATION_FETCH_TIMEOUT_MS"* \
        && "$playback_health" == *"\"languageValidationPostFetchReserveMs\":$EXPECTED_LANGUAGE_VALIDATION_POST_FETCH_RESERVE_MS"* \
        && "$playback_health" == *"\"languageValidationJobLeaseSeconds\":$EXPECTED_LANGUAGE_VALIDATION_JOB_LEASE_SECONDS"* \
        && "$playback_health" == *"\"languageValidationSampleDurationSeconds\":$EXPECTED_LANGUAGE_VALIDATION_SAMPLE_DURATION_SECONDS"* \
        && "$playback_health" == *"\"languageValidationRetryWorkerProtocol\":$EXPECTED_LANGUAGE_VALIDATION_RETRY_WORKER_PROTOCOL"* \
        && "$playback_health" == *"\"languageValidationRetryWorkerBatch\":$EXPECTED_LANGUAGE_VALIDATION_RETRY_WORKER_BATCH"* \
        && "$playback_health" == *"\"languageValidationGatewayFailureRetrySeconds\":$EXPECTED_LANGUAGE_VALIDATION_GATEWAY_FAILURE_RETRY_SECONDS"* \
        && "$playback_health" == *"\"languageValidationProviderAttemptProtocol\":$EXPECTED_LANGUAGE_VALIDATION_PROVIDER_ATTEMPT_PROTOCOL"* \
        && "$playback_health" == *"\"languageValidationViewerPreemptionProtocol\":$EXPECTED_LANGUAGE_VALIDATION_VIEWER_PREEMPTION_PROTOCOL"* \
        && "$playback_health" == *"\"languageValidationMaxConsecutiveProviderNoProgress\":$EXPECTED_LANGUAGE_VALIDATION_MAX_CONSECUTIVE_PROVIDER_NO_PROGRESS"* \
        && "$playback_health" == *"\"automaticStrictUndAudioProtocol\":$EXPECTED_AUTOMATIC_STRICT_UND_AUDIO_PROTOCOL"* \
        && "$playback_health" == *"\"automaticStrictUndAudioConsensus\":\"$EXPECTED_AUTOMATIC_STRICT_UND_AUDIO_CONSENSUS\""* ]] || {
      echo "ERROR: $service norva-playback protocol marker mismatch" >&2
      exit 1
    }
    [[ "$playback_health" == *"\"mediaGatewayCanaryRouting\":{\"protocol\":$EXPECTED_MEDIA_GATEWAY_CANARY_ROUTING_PROTOCOL"* \
        && "$playback_health" != *"\"state\":\"invalid\""* ]] || {
      echo "ERROR: $service media Gateway canary routing is missing or invalid" >&2
      exit 1
    }
    [[ "$cloud_health" == *"\"version\":$EXPECTED_CLOUD_VERSION"* \
        && "$cloud_health" == *"\"playbackCreationProtocol\":$EXPECTED_CLOUD_PROTOCOL"* \
        && "$cloud_health" == *"\"sourceDesiredStateProtocol\":$EXPECTED_SOURCE_DESIRED_STATE_PROTOCOL"* \
        && "$cloud_health" == *"\"legacySourceToggleBridge\":$EXPECTED_LEGACY_SOURCE_TOGGLE_BRIDGE"* \
        && "$cloud_health" == *"\"m3uSyncLeaseProtocol\":$EXPECTED_M3U_SYNC_LEASE_PROTOCOL"* \
        && "$cloud_health" == *"\"m3uStreamingImportProtocol\":$EXPECTED_M3U_STREAMING_IMPORT_PROTOCOL"* \
        && "$cloud_health" == *"\"relayTakeoverProtocol\":$EXPECTED_RELAY_TAKEOVER_PROTOCOL"* \
        && "$cloud_health" == *"\"relayCoordinatorLockTtlMs\":$EXPECTED_RELAY_COORDINATOR_LOCK_TTL_MS"* ]] || {
      echo "ERROR: $service norva-cloud protocol marker mismatch" >&2
      exit 1
    }
    [[ "$catalog_health" == *"\"version\":$EXPECTED_CATALOG_VERSION"* \
        && "$catalog_health" == *"\"flatCodecProfileProtocol\":$EXPECTED_FLAT_CODEC_PROFILE_PROTOCOL"* \
        && "$catalog_health" == *"\"exactTrackPersistenceProtocol\":$EXPECTED_EXACT_TRACK_PERSISTENCE_PROTOCOL"* ]] || {
      echo "ERROR: $service norva-catalog protocol marker mismatch" >&2
      exit 1
    }
    [[ "$source_sync_health" == *"\"version\":$EXPECTED_SOURCE_SYNC_VERSION"* \
        && "$source_sync_health" == *"\"cloudAutoRefreshClaimProtocol\":$EXPECTED_CLOUD_AUTO_REFRESH_CLAIM_PROTOCOL"* \
        && "$source_sync_health" == *"\"sourceReenableResumeProtocol\":$EXPECTED_SOURCE_REENABLE_RESUME_PROTOCOL"* \
        && "$source_sync_health" == *"\"m3uSyncLeaseProtocol\":$EXPECTED_M3U_SYNC_LEASE_PROTOCOL"* \
        && "$source_sync_health" == *"\"m3uStreamingImportProtocol\":$EXPECTED_M3U_STREAMING_IMPORT_PROTOCOL"* \
        && "$source_sync_health" == *"\"fileAudioRepairCohortProtocol\":$EXPECTED_FILE_AUDIO_REPAIR_COHORT_PROTOCOL"* \
        && "$source_sync_health" == *"\"tmdbSearchPolicy\":\"$EXPECTED_TMDB_SEARCH_POLICY\""* ]] || {
      echo "ERROR: $service norva-source-sync protocol marker mismatch" >&2
      exit 1
    }
    [[ "$auth_challenge_health" == *"\"protocol\":$EXPECTED_AUTH_EMAIL_CHALLENGE_PROTOCOL"* ]] || {
      echo "ERROR: $service norva-auth-challenge protocol marker mismatch" >&2
      exit 1
    }
    echo "   $service source digests and playback/catalog/source-sync/auth-challenge protocols verified"
  }

  for service in "${function_services[@]}"; do
    echo ">> Recreating $service"
    previous_container_id="$(
      docker compose --env-file "$ENV_FILE" -f "$COMPOSE" ps -q "$service"
    )"
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE" \
      up -d --no-deps --force-recreate "$service"

    container_id="$(
      docker compose --env-file "$ENV_FILE" -f "$COMPOSE" ps -q "$service"
    )"
    [[ -n "$container_id" ]] || {
      echo "ERROR: $service has no running container after recreation" >&2
      exit 1
    }
    if [[ -n "$previous_container_id" \
        && "$container_id" == "$previous_container_id" ]]; then
      echo "ERROR: $service was not recreated" >&2
      exit 1
    fi

    deadline=$((SECONDS + 60))
    while true; do
      health=$(docker inspect --format \
        '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
        "$container_id")
      [[ "$health" == "healthy" || "$health" == "running" ]] && break
      if (( SECONDS >= deadline )); then
        echo "ERROR: $service did not become healthy within 60 seconds (status: $health)" >&2
        exit 1
      fi
      sleep 1
    done
    echo "   $service is $health"
    verify_function_protocol "$service"
  done
  echo ">> edge-runtime replicas recreated: ${function_services[*]}."
else
  if [[ "$REQUIRE_QUIESCED_EDGE_DEPLOY" == "1" ]]; then
    echo "ERROR: required quiesced Edge deployment cannot run without Docker and the Compose file" >&2
    exit 1
  fi
  echo "   (docker/compose not found here — run on the box:"
  echo "    docker compose --env-file .env -f docker-compose.supabase.yml up -d --no-deps --force-recreate functions"
  echo "    then verify health before recreating functions2 )"
fi

echo ">> Done. Smoke-test e.g.:  curl -i \$FUNCTIONS_BASE_URL/norva-playback  (expect 401 without auth)"
