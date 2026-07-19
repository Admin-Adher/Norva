#!/usr/bin/env bash
# =============================================================================
# 17-run-lid-benchmark.sh — read-only, real-provider LID benchmark
# =============================================================================
# Runs one extraction per exact sample, then compares on that exact same WAV:
#   - the current full Whisper small transcription path
#   - whisper.cpp small --detect-language
#   - persistent SpeechBrain ECAPA/VoxLingua107
#   - persistent sherpa-onnx Whisper tiny/int8
#
# Corpus:
#   - every cached audio track of every "In the Hand of Dante" variant
#   - 12 exact tracks whose ffprobe language is unknown
#   - 4 historical language corrections
#
# This runner deliberately reports cache agreement, NOT accuracy. Accuracy needs
# a separately blind-reviewed human label. It also fingerprints the relevant
# catalogue language fields before and after the run. A difference makes the run
# inconclusive (it can also be caused by a concurrent enrichment cron).
#
# Usage:
#   ./17-run-lid-benchmark.sh [limit]       # 0 = whole corpus
# Env:
#   FUNCTIONS_BASE=https://api.norva.tv/functions/v1
#   GATEWAY_HEALTH=https://norva-production.up.railway.app/health
#   MIN_COMPLETION_PCT=80
#   BENCH_OFFSET=0   # skip N deterministic corpus rows for a targeted smoke
#   LID_WORKER_ENABLED=1
#   LID_WORKER_URL=http://127.0.0.1:8091
# =============================================================================
set -euo pipefail
umask 077
export PATH="$HOME/.local/bin:$PATH"

LIMIT="${1:-0}"
BENCH_OFFSET="${BENCH_OFFSET:-0}"
LID_WORKER_ENABLED="${LID_WORKER_ENABLED:-1}"
[[ "$LIMIT" =~ ^[0-9]+$ ]] || { echo "limit must be a non-negative integer" >&2; exit 2; }
[[ "$BENCH_OFFSET" =~ ^[0-9]+$ ]] || { echo "BENCH_OFFSET must be a non-negative integer" >&2; exit 2; }
[[ "$LID_WORKER_ENABLED" == "0" || "$LID_WORKER_ENABLED" == "1" ]] || {
  echo "LID_WORKER_ENABLED must be 0 or 1" >&2
  exit 2
}
command -v curl >/dev/null || { echo "curl is required" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }
command -v base64 >/dev/null || { echo "base64 is required" >&2; exit 2; }
command -v sha256sum >/dev/null || { echo "sha256sum is required" >&2; exit 2; }

FUNCTIONS_BASE="${FUNCTIONS_BASE:-https://api.norva.tv/functions/v1}"
GATEWAY_HEALTH="${GATEWAY_HEALTH:-https://norva-production.up.railway.app/health}"
PLAYBACK_HEALTH="${PLAYBACK_HEALTH:-$FUNCTIONS_BASE/norva-playback/health}"
LID_WORKER_URL="${LID_WORKER_URL:-http://127.0.0.1:8091}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LID_WORKER_ENV="${LID_WORKER_ENV:-$SCRIPT_DIR/../lid-benchmark/.env}"
EXPECTED_WHISPER_COMMIT="080bbbe85230f624f0b52127f1ae1218247989f9"
EXPECTED_ECAPA_REVISION="0253049ae131d6a4be1c4f0d8b0ff483a0f8c8e9"
EXPECTED_SHERPA_REVISION="65176e2deb88badc814a94058666cadccc29b61c"
EXPECTED_SHERPA_ENCODER_SHA="d24fb083ae3b1041fc24e97971d60e280c9342201fbb67b0ab428a8b4a51a434"
EXPECTED_SHERPA_DECODER_SHA="d2fece8dd42771f1df975c6c0445770d0c292bf7547c2cae04a6c0cc57540925"
MIN_COMPLETION_PCT="${MIN_COMPLETION_PCT:-80}"
[[ "$MIN_COMPLETION_PCT" =~ ^[0-9]+$ && "$MIN_COMPLETION_PCT" -le 100 ]] || {
  echo "MIN_COMPLETION_PCT must be between 0 and 100" >&2
  exit 2
}
# Keep benchmark bookkeeping strictly serial and low-memory: production can
# already be using PostgreSQL's small 64 MiB container /dev/shm.
PSQL=(
  docker exec -i
  -e "PGOPTIONS=-c max_parallel_workers_per_gather=0 -c jit=off -c work_mem=8MB"
  norva-db psql -U postgres -d postgres -Atq -v ON_ERROR_STOP=1
)
RESULT_DIR="${RESULT_DIR:-$HOME/.local/state/norva/lid-benchmarks}"
mkdir -p "$RESULT_DIR"
chmod 700 "$RESULT_DIR"
RESULTS="$RESULT_DIR/$(date -u +%Y%m%dT%H%M%SZ)-whisper-detect-only.ndjson"
AUTH_HEADER="$(mktemp /tmp/norva-lid-auth.XXXXXX)"
WORKER_AUTH_HEADER=""
SAMPLE_WAV=""
FLAG_ENABLED=0

disable_flag() {
  if [[ "$FLAG_ENABLED" == "1" ]]; then
    "${PSQL[@]}" -c \
      "update public.admin_feature_flags set enabled=false, updated_at=now(), updated_by='ops-lid-benchmark' where key='lid_benchmark_enabled';" \
      >/dev/null 2>&1 || true
  fi
  rm -f "$AUTH_HEADER"
  [[ -z "$WORKER_AUTH_HEADER" ]] || rm -f "$WORKER_AUTH_HEADER"
  [[ -z "$SAMPLE_WAV" ]] || rm -f "$SAMPLE_WAV"
}
trap disable_flag EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

EDGE_HEALTH="$(curl -fsS --max-time 30 "$PLAYBACK_HEALTH")"
printf '%s' "$EDGE_HEALTH" | jq -e '
  .ok == true and
  .version >= 30 and
  .lidBenchmarkProtocol >= 2
' >/dev/null || {
  echo "norva-playback does not expose the read-only LID benchmark protocol" >&2
  printf '%s\n' "$EDGE_HEALTH" | jq '{version, lidBenchmarkProtocol}' >&2
  exit 1
}

HEALTH="$(curl -fsS --max-time 30 "$GATEWAY_HEALTH")"
printf '%s' "$HEALTH" | jq -e --arg commit "$EXPECTED_WHISPER_COMMIT" '
  .ok == true and
  .version >= 73 and
  .languageDetectEngine.detectOnlyBenchmark == true and
  .languageDetectEngine.runtimeVerified == true and
  .languageDetectEngine.model == "small" and
  .languageDetectEngine.commit == $commit and
  (.languageDetectEngine.binarySha256 | test("^[a-f0-9]{64}$")) and
  (.languageDetectEngine.modelSha256 | test("^[a-f0-9]{64}$"))
' >/dev/null || {
  echo "gateway is not the pinned LID benchmark build" >&2
  printf '%s\n' "$HEALTH" | jq '{version, languageDetectEngine}' >&2
  exit 1
}

WORKER_HEALTH='null'
if [[ "$LID_WORKER_ENABLED" == "1" ]]; then
  [[ -r "$LID_WORKER_ENV" ]] || {
    echo "LID worker secret file is missing: $LID_WORKER_ENV" >&2
    exit 1
  }
  WORKER_TOKEN="$(sed -n 's/^LID_BENCHMARK_WORKER_TOKEN=//p' "$LID_WORKER_ENV" | tail -n 1)"
  [[ "${#WORKER_TOKEN}" -ge 32 && "$WORKER_TOKEN" != *$'\n'* && "$WORKER_TOKEN" != *$'\r'* ]] || {
    echo "LID worker token is missing or invalid" >&2
    exit 1
  }
  WORKER_AUTH_HEADER="$(mktemp /tmp/norva-lid-worker-auth.XXXXXX)"
  printf 'Authorization: Bearer %s\n' "$WORKER_TOKEN" >"$WORKER_AUTH_HEADER"
  chmod 600 "$WORKER_AUTH_HEADER"
  unset WORKER_TOKEN

  WORKER_HEALTH="$(curl -fsS --max-time 30 "$LID_WORKER_URL/health")"
  printf '%s' "$WORKER_HEALTH" | jq -e \
    --arg ecapa "$EXPECTED_ECAPA_REVISION" \
    --arg sherpa "$EXPECTED_SHERPA_REVISION" \
    --arg encoder "$EXPECTED_SHERPA_ENCODER_SHA" \
    --arg decoder "$EXPECTED_SHERPA_DECODER_SHA" '
      .ok == true and
      .schemaVersion == 1 and
      .busy == false and
      .engines.ecapa.ready == true and
      .engines.sherpa.ready == true and
      .models.ecapa.revision == $ecapa and
      .models.sherpa.revision == $sherpa and
      any(.models.sherpa.files[]; .name == "tiny-encoder.int8.onnx" and .sha256 == $encoder) and
      any(.models.sherpa.files[]; .name == "tiny-decoder.int8.onnx" and .sha256 == $decoder)
    ' >/dev/null || {
      echo "the persistent LID worker is not the pinned benchmark build" >&2
      printf '%s\n' "$WORKER_HEALTH" | jq '{schemaVersion, busy, models}' >&2
      exit 1
    }
fi

TOKEN=$("${PSQL[@]}" -c \
  "select decrypted_secret from vault.decrypted_secrets where name='norva_backfill_token'")
[[ -n "$TOKEN" ]] || { echo "norva_backfill_token is missing" >&2; exit 1; }
printf 'Authorization: Bearer %s\n' "$TOKEN" >"$AUTH_HEADER"
chmod 600 "$AUTH_HEADER"
unset TOKEN

gateway_is_idle() {
  printf '%s' "$1" | jq -e '
    .activeSessions == 0 and
    .rawPumpCount == 0 and
    .transcribeQueueDepth == 0 and
    .ocrQueueDepth == 0 and
    .translateQueueDepth == 0 and
    .transcribeBusy == false and
    .ocrBusy == false and
    .translateBusy == false and
    .whisperInferenceActive == 0 and
    .argosInferenceActive == 0 and
    .lidBenchmarkBusy == false
  ' >/dev/null
}

for _ in $(seq 1 30); do
  HEALTH="$(curl -fsS --max-time 30 "$GATEWAY_HEALTH")"
  gateway_is_idle "$HEALTH" && break
  sleep 10
done
gateway_is_idle "$HEALTH" || {
  echo "gateway did not become idle within five minutes" >&2
  printf '%s\n' "$HEALTH" | jq '{
    activeSessions, rawPumpCount, transcribeQueueDepth, ocrQueueDepth,
    translateQueueDepth, transcribeBusy, ocrBusy, translateBusy,
    whisperInferenceActive, argosInferenceActive, lidBenchmarkBusy
  }' >&2
  exit 1
}

catalogue_fingerprint() {
  "${PSQL[@]}" <<'SQL'
with relevant_variants as (
  select v.id, v.source_id, v.user_id, v.item_type, v.external_id
  from public.cloud_title_variants v
  join public.cloud_titles t on t.id = v.title_id
  where lower(t.title) like '%in the hand of dante%'
     or v.id = any(array[
       '8eda33ae-1998-4fa0-98a6-d54c9516741d'::uuid,
       '2c6b8cb3-c938-40d4-b249-7728355e8204'::uuid,
       '3c64489e-bf10-4bc4-8c87-30c62c243d7c'::uuid,
       'dce64812-5e24-4bac-8ce1-e5cfffa007f0'::uuid,
       '37527bf4-4f62-4b9f-bf10-5b44d91676da'::uuid,
       'ea48e260-8e8a-4816-8764-a9780eb8092a'::uuid,
       'c836ee36-dddd-4174-857f-192fd4c38843'::uuid,
       '97d3aa33-9a45-44cf-b26d-8caebb9364c5'::uuid,
       '140fc535-e30c-4cf9-8836-6fd1ae3a8b27'::uuid,
       '56e65ecd-6a2a-482d-b645-80c44f2871df'::uuid,
       '869c0af5-bbc6-4c59-be43-7abd45111272'::uuid,
       '1e6264d9-4cc9-481d-9300-2e2262382b05'::uuid,
       'f728c785-0064-490c-8981-6f6e576ebd76'::uuid,
       '2f328905-d54b-4e0a-932a-344fdfab661c'::uuid,
       '05cda9cd-777d-4bef-8ec4-b55552f5740f'::uuid,
       '11c57205-44cb-42db-833e-5b6bf618d849'::uuid
     ])
), rows as (
  select
    'file:' || jsonb_build_object(
      'server_host', ft.server_host,
      'item_type', ft.item_type,
      'external_id', ft.external_id,
      'audio_tracks', ft.audio_tracks,
      'audio_probed_at', ft.audio_probed_at
    )::text as value
  from relevant_variants v
  join public.catalog_source_provider_identities spi
    on spi.source_id = v.source_id and spi.user_id = v.user_id
  join public.catalog_file_tracks ft
    on ft.server_host = spi.identity_id::text
   and ft.item_type = v.item_type
   and ft.external_id = v.external_id
  union all
  select 'variant:' || jsonb_build_object(
    'id', v.id,
    'language', v.language
  )::text
  from public.cloud_title_variants v
  where v.id in (select id from relevant_variants)
  union all
  select 'title:' || jsonb_build_object(
    'id', t.id,
    'audio_languages', t.audio_languages,
    'audio_tracks', t.audio_tracks,
    'audio_probed_at', t.audio_probed_at
  )::text
  from public.cloud_titles t
  where t.id in (
    select distinct v.title_id
    from public.cloud_title_variants v
    where v.id in (select id from relevant_variants)
  )
)
select md5(coalesce(string_agg(
  value, E'\n' order by value
), '')) from rows;
SQL
}

mapfile -t SAMPLES < <("${PSQL[@]}" <<SQL
with controls(variant_id, track_index, cohort, expected_hint) as (
  values
    ('8eda33ae-1998-4fa0-98a6-d54c9516741d'::uuid, 1, 'unknown', null),
    ('2c6b8cb3-c938-40d4-b249-7728355e8204'::uuid, 1, 'unknown', null),
    ('3c64489e-bf10-4bc4-8c87-30c62c243d7c'::uuid, 5, 'unknown', null),
    ('dce64812-5e24-4bac-8ce1-e5cfffa007f0'::uuid, 24, 'unknown', null),
    ('37527bf4-4f62-4b9f-bf10-5b44d91676da'::uuid, 1, 'unknown', null),
    ('ea48e260-8e8a-4816-8764-a9780eb8092a'::uuid, 3, 'unknown', null),
    ('c836ee36-dddd-4174-857f-192fd4c38843'::uuid, 1, 'unknown', null),
    ('97d3aa33-9a45-44cf-b26d-8caebb9364c5'::uuid, 3, 'unknown', null),
    ('140fc535-e30c-4cf9-8836-6fd1ae3a8b27'::uuid, 26, 'unknown', null),
    ('56e65ecd-6a2a-482d-b645-80c44f2871df'::uuid, 16, 'unknown', null),
    ('869c0af5-bbc6-4c59-be43-7abd45111272'::uuid, 3, 'unknown', null),
    ('1e6264d9-4cc9-481d-9300-2e2262382b05'::uuid, 2, 'unknown', null),
    ('f728c785-0064-490c-8981-6f6e576ebd76'::uuid, 1, 'historical-correction', 'ar'),
    ('2f328905-d54b-4e0a-932a-344fdfab661c'::uuid, 1, 'historical-correction', 'ar'),
    ('05cda9cd-777d-4bef-8ec4-b55552f5740f'::uuid, 1, 'historical-correction', 'ko'),
    ('11c57205-44cb-42db-833e-5b6bf618d849'::uuid, 1, 'historical-correction', 'fa')
), dante as (
  select
    v.user_id,
    v.id as variant_id,
    (a.value->>'index')::int as track_index,
    'dante'::text as cohort,
    nullif(a.value->>'lang', '') as cached_hint,
    null::text as expected_hint
  from public.cloud_titles t
  join public.cloud_title_variants v on v.title_id = t.id
  join public.catalog_source_provider_identities spi
    on spi.source_id = v.source_id and spi.user_id = v.user_id
  join public.catalog_file_tracks ft
    on ft.server_host = spi.identity_id::text
   and ft.item_type = v.item_type
   and ft.external_id = v.external_id
  cross join lateral jsonb_array_elements(ft.audio_tracks) a(value)
  where lower(t.title) like '%in the hand of dante%'
    and coalesce(a.value->>'index', '') ~ '^[0-9]+$'
), control_rows as (
  select
    v.user_id,
    v.id as variant_id,
    c.track_index,
    c.cohort,
    nullif(a.value->>'lang', '') as cached_hint,
    c.expected_hint
  from controls c
  join public.cloud_title_variants v on v.id = c.variant_id
  join public.catalog_source_provider_identities spi
    on spi.source_id = v.source_id and spi.user_id = v.user_id
  join public.catalog_file_tracks ft
    on ft.server_host = spi.identity_id::text
   and ft.item_type = v.item_type
   and ft.external_id = v.external_id
  cross join lateral jsonb_array_elements(ft.audio_tracks) a(value)
  where coalesce(a.value->>'index', '') ~ '^[0-9]+$'
    and (a.value->>'index')::int = c.track_index
), samples as (
  select * from dante
  union all
  select * from control_rows
), numbered as (
  select *, row_number() over (order by cohort, user_id, variant_id, track_index) as n
  from samples
)
select jsonb_build_object(
  'sampleKey', variant_id::text || ':' || track_index::text || ':600',
  'cohort', cohort,
  'cachedLanguageHint', cached_hint,
  'expectedHistoricalHint', expected_hint,
  'payload', jsonb_build_object(
    'mode', 'lid-benchmark',
    'userId', user_id,
    'variantId', variant_id,
    'index', track_index,
    'start', 600,
    'dur', 20,
    'order', case when n % 2 = 0 then 'detect-first' else 'current-first' end
  )
)
from numbered
order by n
limit $( [[ "$LIMIT" -gt 0 ]] && printf '%s' "$LIMIT" || printf '1000000' )
offset $BENCH_OFFSET;
SQL
)

[[ "${#SAMPLES[@]}" -gt 0 ]] || { echo "the real corpus is empty" >&2; exit 1; }
if [[ "$LIMIT" == "0" && "$BENCH_OFFSET" == "0" ]]; then
  DANTE_COUNT="$(printf '%s\n' "${SAMPLES[@]}" | jq -s '[.[] | select(.cohort == "dante")] | length')"
  UNKNOWN_COUNT="$(printf '%s\n' "${SAMPLES[@]}" | jq -s '[.[] | select(.cohort == "unknown")] | length')"
  HISTORICAL_COUNT="$(printf '%s\n' "${SAMPLES[@]}" | jq -s '[.[] | select(.cohort == "historical-correction")] | length')"
  UNKNOWN_DRIFT="$(printf '%s\n' "${SAMPLES[@]}" | jq -s '[.[] | select(.cohort == "unknown" and .cachedLanguageHint != null)] | length')"
  HISTORICAL_DRIFT="$(printf '%s\n' "${SAMPLES[@]}" | jq -s '[.[] | select(
    .cohort == "historical-correction" and .cachedLanguageHint != .expectedHistoricalHint
  )] | length')"
  [[ "$DANTE_COUNT" -ge 39 && "$UNKNOWN_COUNT" == "12" && "$HISTORICAL_COUNT" == "4" ]] || {
    echo "corpus cardinality drift: dante=$DANTE_COUNT unknown=$UNKNOWN_COUNT historical=$HISTORICAL_COUNT" >&2
    exit 1
  }
  [[ "$UNKNOWN_DRIFT" == "0" && "$HISTORICAL_DRIFT" == "0" ]] || {
    echo "control state drift: unknown=$UNKNOWN_DRIFT historical=$HISTORICAL_DRIFT" >&2
    exit 1
  }
fi

BEFORE_FINGERPRINT="$(catalogue_fingerprint)"
[[ -n "$BEFORE_FINGERPRINT" ]] || { echo "unable to fingerprint the corpus" >&2; exit 1; }

"${PSQL[@]}" -c "
insert into public.admin_feature_flags(key, enabled, description, updated_at, updated_by)
values ('lid_benchmark_enabled', true, 'Autorise temporairement le benchmark LID audio en lecture seule', now(), 'ops-lid-benchmark')
on conflict (key) do update
set enabled=true, updated_at=now(), updated_by='ops-lid-benchmark';" >/dev/null
FLAG_ENABLED=1

echo "gateway v$(printf '%s' "$HEALTH" | jq -r '.version'), pinned model $(printf '%s' "$HEALTH" | jq -r '.languageDetectEngine.model')"
echo "running ${#SAMPLES[@]} real samples; catalogue fingerprint $BEFORE_FINGERPRINT"
echo "detailed evidence: $RESULTS"

completed=0
for sample in "${SAMPLES[@]}"; do
  key="$(printf '%s' "$sample" | jq -r '.sampleKey')"
  cohort="$(printf '%s' "$sample" | jq -r '.cohort')"
  payload="$(printf '%s' "$sample" | jq -c '.payload')"
  if [[ "$LID_WORKER_ENABLED" == "1" ]]; then
    payload="$(printf '%s' "$payload" | jq -c '. + {captureWav:true}')"
  fi
  response='{"runnerError":"request-not-run"}'
  http_status=0
  attempt=0
  while [[ "$attempt" -lt 3 ]]; do
    attempt=$((attempt + 1))
    set +e
    raw="$(printf '%s' "$payload" | curl -sS --max-time 190 -X POST \
      "$FUNCTIONS_BASE/norva-playback/lid-benchmark" \
      --header "@$AUTH_HEADER" \
      -H 'Content-Type: application/json' \
      --data-binary @- \
      --write-out $'\n%{http_code}')"
    curl_exit=$?
    set -e
    if [[ "$curl_exit" -ne 0 ]]; then
      response="$(jq -cn --arg error "curl-exit-$curl_exit" '{runnerError:$error}')"
      http_status=0
      transient=true
    else
      http_status="${raw##*$'\n'}"
      response="${raw%$'\n'*}"
      if ! printf '%s' "$response" | jq -e . >/dev/null 2>&1; then
        response='{"runnerError":"non-json-response"}'
      fi
      provider_auth_terminal="$(printf '%s' "$response" | jq -r '
        ((.details // "") | test("(401|403|unauthorized|forbidden|authorization failed)"; "i"))
      ')"
      if [[ "$provider_auth_terminal" == "true" ]]; then
        transient=false
      elif [[ "$http_status" == "408" || "$http_status" == "429" || "$http_status" =~ ^5[0-9][0-9]$ ]]; then
        transient=true
      else
        transient="$(printf '%s' "$response" | jq -r '
          ((.status // 0) == 408 or (.status // 0) == 429 or
            ((.status // 0) >= 500 and (.status // 0) <= 599)) or
          ((.skipped // "") | test("^(live-session|live-session-race|pregen-active|pregen-active-race|provider-account-busy|provider-account-busy-race|provider-lease-busy)$")) or
          (.runnerError != null)
        ')"
      fi
    fi
    [[ "$transient" == "true" && "$attempt" -lt 3 ]] || break
    retry_after="$(printf '%s' "$response" | jq -r '(.retryAfter // 10) | tonumber? // 10')"
    [[ "$retry_after" =~ ^[0-9]+$ ]] || retry_after=10
    (( retry_after > 20 )) && retry_after=20
    sleep $((retry_after + attempt))
  done

  if [[ "$LID_WORKER_ENABLED" == "1" ]] \
      && printf '%s' "$response" | jq -e '.benchmark.wavCapture != null' >/dev/null 2>&1; then
    SAMPLE_WAV="$(mktemp --suffix=.wav "$RESULT_DIR/.lid-sample.XXXXXX")"
    chmod 600 "$SAMPLE_WAV"
    expected_digest="$(printf '%s' "$response" | jq -r '.benchmark.wavCapture.digest // ""')"
    expected_bytes="$(printf '%s' "$response" | jq -r '.benchmark.wavCapture.bytes // 0')"
    capture_error=""
    if ! printf '%s' "$response" | jq -er '.benchmark.wavCapture.base64' \
        | base64 --decode >"$SAMPLE_WAV"; then
      capture_error="capture-decode-failed"
    elif [[ "$(wc -c <"$SAMPLE_WAV" | tr -d ' ')" != "$expected_bytes" ]]; then
      capture_error="capture-size-mismatch"
    elif [[ "$(sha256sum "$SAMPLE_WAV" | cut -d' ' -f1)" != "$expected_digest" ]]; then
      capture_error="capture-digest-mismatch"
    fi

    if [[ -n "$capture_error" ]]; then
      worker_response="$(jq -cn --arg error "$capture_error" \
        '{ok:false,persisted:false,runnerError:$error}')"
    else
      if (( completed % 2 == 0 )); then
        worker_order="ecapa-first"
      else
        worker_order="sherpa-first"
      fi
      set +e
      worker_raw="$(curl -sS --max-time 300 -X POST \
        "$LID_WORKER_URL/benchmark?order=$worker_order" \
        --header "@$WORKER_AUTH_HEADER" \
        -H 'Content-Type: audio/wav' \
        -H "X-Norva-Sample-Sha256: $expected_digest" \
        --data-binary "@$SAMPLE_WAV" \
        --write-out $'\n%{http_code}')"
      worker_curl_exit=$?
      set -e
      if [[ "$worker_curl_exit" -ne 0 ]]; then
        worker_response="$(jq -cn --arg error "worker-curl-exit-$worker_curl_exit" \
          '{ok:false,persisted:false,runnerError:$error}')"
      else
        worker_http_status="${worker_raw##*$'\n'}"
        worker_response="${worker_raw%$'\n'*}"
        if ! printf '%s' "$worker_response" | jq -e . >/dev/null 2>&1; then
          worker_response='{"ok":false,"persisted":false,"runnerError":"worker-non-json-response"}'
        elif [[ ! "$worker_http_status" =~ ^2[0-9][0-9]$ ]]; then
          worker_response="$(printf '%s' "$worker_response" | jq -c \
            --argjson status "$worker_http_status" '. + {httpStatus:$status}')"
        fi
      fi
    fi
    rm -f "$SAMPLE_WAV"
    SAMPLE_WAV=""
    response="$(printf '%s' "$response" | jq -c --argjson fastLid "$worker_response" '
      .benchmark.fastLid = $fastLid | del(.benchmark.wavCapture)
    ')"
  else
    # Never let operator audio enter the durable NDJSON, even if a future edge
    # version accidentally returns it when the local worker is disabled.
    response="$(printf '%s' "$response" | jq -c 'del(.benchmark.wavCapture)')"
  fi

  safe_request="$(printf '%s' "$sample" | jq -c '{
    sampleKey,
    cohort,
    cachedLanguageHint,
    expectedHistoricalHint,
    payload: (.payload | del(.userId))
  }')"
  safe_response="$(printf '%s' "$response" | jq -c 'del(.audit)')"
  jq -cn \
    --arg key "$key" \
    --arg cohort "$cohort" \
    --argjson request "$safe_request" \
    --argjson response "$safe_response" \
    --argjson httpStatus "$http_status" \
    --argjson attempts "$attempt" \
    '{sampleKey:$key, cohort:$cohort, request:$request, response:$response,
      httpStatus:$httpStatus, attempts:$attempts}' \
    >>"$RESULTS"
  completed=$((completed + 1))
  printf '[%3d/%3d] %-21s %s -> small=%s detect=%s ecapa=%s sherpa=%s (%sms/%sms/%sms/%sms)%s\n' \
    "$completed" "${#SAMPLES[@]}" "$cohort" "$key" \
    "$(printf '%s' "$response" | jq -r '.benchmark.current.productionLanguage // "-"')" \
    "$(printf '%s' "$response" | jq -r '.benchmark.detectOnly.candidateLanguage // "-"')" \
    "$(printf '%s' "$response" | jq -r '.benchmark.fastLid.ecapa.candidateLanguage // "-"')" \
    "$(printf '%s' "$response" | jq -r '.benchmark.fastLid.sherpa.lang // "-"')" \
    "$(printf '%s' "$response" | jq -r '.benchmark.timings.currentMs // "-"')" \
    "$(printf '%s' "$response" | jq -r '.benchmark.timings.detectOnlyMs // "-"')" \
    "$(printf '%s' "$response" | jq -r '.benchmark.fastLid.ecapa.metrics.inferenceMs // "-"')" \
    "$(printf '%s' "$response" | jq -r '.benchmark.fastLid.sherpa.metrics.inferenceMs // "-"')" \
    "$(printf '%s' "$response" | jq -r 'if .skipped then " skipped=" + .skipped elif .error then " error=" + .error + (if .details then " (" + .details + ")" else "" end) elif .runnerError then " error=" + .runnerError elif .benchmark.system.contended then " CONTENDED" else "" end')"
done

AFTER_FINGERPRINT="$(catalogue_fingerprint)"
CATALOGUE_UNCHANGED=true
if [[ "$AFTER_FINGERPRINT" != "$BEFORE_FINGERPRINT" ]]; then
  CATALOGUE_UNCHANGED=false
  echo "WARNING: a concurrent catalogue language mutation makes this run inconclusive" >&2
  echo "before=$BEFORE_FINGERPRINT after=$AFTER_FINGERPRINT" >&2
fi

SUMMARY="$(jq -s --argjson catalogueUnchanged "$CATALOGUE_UNCHANGED" '
  def median:
    sort as $s |
    if length == 0 then null
    elif length % 2 == 1 then $s[length/2|floor]
    else (($s[length/2-1] + $s[length/2]) / 2)
    end;
  [ .[] | select(.response.benchmark != null) ] as $completed |
  [ $completed[] | select(
      .response.benchmark.system.contended != true and
      (.attempts // 1) == 1
    ) ] as $usable |
  [ $usable[] | select(.response.benchmark.current.productionAccepted == true) ] as $acceptedCurrent |
  [ $usable[] | select(.response.benchmark.fastLid.ecapa.ok == true) ] as $ecapaOutput |
  [ $usable[] | select(.response.benchmark.fastLid.sherpa.ok == true) ] as $sherpaOutput |
  [ $usable[] | select(
      .response.benchmark.fastLid.ecapa.ok == true and
      .response.benchmark.fastLid.sherpa.ok == true
    ) ] as $bothFast |
  {
    requested: length,
    completed: ($completed | length),
    usable: ($usable | length),
    retriedExcluded: ([$completed[] | select((.attempts // 1) != 1)] | length),
    skipped: ([ .[] | select(.response.skipped != null) ] | group_by(.response.skipped) |
      map({key: .[0].response.skipped, value: length}) | from_entries),
    failures: ([ .[] | select(.response.benchmark == null and .response.skipped == null) |
      {
        status: (.response.status // .httpStatus),
        error: (.response.error // .response.runnerError // "unknown"),
        details: (.response.details // null)
      }
    ] | group_by([.status, .error, .details]) | map({
      status: .[0].status, error: .[0].error, details: .[0].details, count: length
    })),
    contended: ([$completed[] | select(.response.benchmark.system.contended == true)] | length),
    usableByCohort: ($usable | group_by(.cohort) |
      map({key: .[0].cohort, value: length}) | from_entries),
    fixedWindowCurrentAcceptance: (if ($usable|length) == 0 then null else
      ([$usable[] | select(.response.benchmark.current.productionAccepted == true)] | length) / ($usable|length) end),
    fixedWindowDetectOnlyOutput: (if ($usable|length) == 0 then null else
      ([$usable[] | select(.response.benchmark.detectOnly.ok == true)] | length) / ($usable|length) end),
    agreementWithAcceptedCurrent: (if ($acceptedCurrent|length) == 0 then null else
      ([$acceptedCurrent[] | select(.response.benchmark.agreement.productionLanguage == true)] | length) /
        ($acceptedCurrent|length) end),
    candidateCoverage: {
      ecapa: (if ($usable|length) == 0 then null else ($ecapaOutput|length) / ($usable|length) end),
      sherpaTinyInt8: (if ($usable|length) == 0 then null else
        ($sherpaOutput|length) / ($usable|length) end)
    },
    agreementWithWhisperCandidate: {
      ecapa: ([
        $ecapaOutput[] |
        select(.response.benchmark.current.candidateLanguage != null)
      ] as $rows |
        if ($rows|length) == 0 then null else
          ([$rows[] | select(
            .response.benchmark.fastLid.ecapa.candidateLanguage ==
              .response.benchmark.current.candidateLanguage
          )] | length) / ($rows|length)
        end),
      sherpaTinyInt8: ([
        $sherpaOutput[] |
        select(.response.benchmark.current.candidateLanguage != null)
      ] as $rows |
        if ($rows|length) == 0 then null else
          ([$rows[] | select(
            .response.benchmark.fastLid.sherpa.lang ==
              .response.benchmark.current.candidateLanguage
          )] | length) / ($rows|length)
        end)
    },
    agreementEcapaSherpa: (if ($bothFast|length) == 0 then null else
      ([$bothFast[] | select(.response.benchmark.fastLid.agreement == true)] | length) /
        ($bothFast|length) end),
    medianInferenceSpeedup: ([$usable[].response.benchmark.gains.lidSpeedup | select(. != null)] | median),
    medianFixedWindowEndToEndSpeedup: ([$usable[].response.benchmark.gains.endToEndSpeedup | select(. != null)] | median),
    medianInferenceMs: {
      whisperCurrent: ([$usable[].response.benchmark.timings.currentMs | select(. != null)] | median),
      whisperDetectOnly: ([$usable[].response.benchmark.timings.detectOnlyMs | select(. != null)] | median),
      ecapa: ([$ecapaOutput[].response.benchmark.fastLid.ecapa.metrics.inferenceMs |
        select(. != null)] | median),
      sherpaTinyInt8: ([$sherpaOutput[].response.benchmark.fastLid.sherpa.metrics.inferenceMs |
        select(. != null)] | median)
    },
    medianFastEngineWallMs: {
      ecapa: ([$ecapaOutput[].response.benchmark.fastLid.timings.ecapaWallMs |
        select(. != null)] | median),
      sherpaTinyInt8: ([$sherpaOutput[].response.benchmark.fastLid.timings.sherpaWallMs |
        select(. != null)] | median)
    },
    fixedWindowCurrentTracksPerHour: ([$usable[].response.benchmark.timings.totalCurrentMs] |
      if length == 0 or add == 0 then null else 3600000 / (add / length) end),
    fixedWindowDetectOnlyTracksPerHour: ([$usable[].response.benchmark.timings.totalDetectOnlyMs] |
      if length == 0 or add == 0 then null else 3600000 / (add / length) end),
    projectedFixedWindowTracksPerHour: {
      ecapa: ([$ecapaOutput[] |
        (.response.benchmark.timings.extractMs +
          .response.benchmark.fastLid.timings.ecapaWallMs)] |
        if length == 0 or add == 0 then null else 3600000 / (add / length) end),
      sherpaTinyInt8: ([$sherpaOutput[] |
        (.response.benchmark.timings.extractMs +
          .response.benchmark.fastLid.timings.sherpaWallMs)] |
        if length == 0 or add == 0 then null else 3600000 / (add / length) end)
    },
    throughputScope: "serial fixed-window projection: provider extraction plus per-engine service wall; excludes retries, queueing before extraction and WAV HTTP upload",
    catalogueSnapshotUnchanged: $catalogueUnchanged,
    productionPipelineCoverage: "not measured: production sweeps 600,1500,300 while this engine benchmark uses one fixed 600s window",
    accuracy: "not scored: cachedLanguageHint is not human ground truth",
    evidence: "private NDJSON path printed by the runner"
  }
' "$RESULTS")"
printf '%s\n' "$SUMMARY"

REQUESTED="${#SAMPLES[@]}"
USABLE="$(printf '%s' "$SUMMARY" | jq -r '.usable')"
MIN_REQUIRED=$(( (REQUESTED * MIN_COMPLETION_PCT + 99) / 100 ))
(( REQUESTED > 0 && MIN_REQUIRED < 1 )) && MIN_REQUIRED=1
HASH_DRIFT="$(jq -s --arg commit "$EXPECTED_WHISPER_COMMIT" '[
  .[] | select(.response.benchmark != null) | select(
    .response.benchmark.engine.commit != $commit or
    (.response.benchmark.engine.gatewayVersion // 0) < 73 or
    .response.benchmark.engine.model != "small" or
    .response.benchmark.engine.runtimeVerified != true or
    ((.response.benchmark.engine.binarySha256 // "") | test("^[a-f0-9]{64}$") | not) or
    ((.response.benchmark.engine.modelSha256 // "") | test("^[a-f0-9]{64}$") | not)
  )
] | length' "$RESULTS")"

FAST_LID_USABLE="$USABLE"
FAST_LID_DRIFT=0
if [[ "$LID_WORKER_ENABLED" == "1" ]]; then
  FAST_LID_USABLE="$(jq -s '[
    .[] | select(
      .response.benchmark.system.contended != true and
      .response.benchmark.fastLid.ecapa.ok == true and
      .response.benchmark.fastLid.sherpa.ok == true
    )
  ] | length' "$RESULTS")"
  FAST_LID_DRIFT="$(jq -s \
    --arg ecapa "$EXPECTED_ECAPA_REVISION" \
    --arg sherpa "$EXPECTED_SHERPA_REVISION" \
    --arg encoder "$EXPECTED_SHERPA_ENCODER_SHA" \
    --arg decoder "$EXPECTED_SHERPA_DECODER_SHA" '[
      .[] | select(.response.benchmark.fastLid != null) | select(
        .response.benchmark.fastLid.models.ecapa.revision != $ecapa or
        .response.benchmark.fastLid.models.sherpa.revision != $sherpa or
        (any(.response.benchmark.fastLid.models.sherpa.files[];
          .name == "tiny-encoder.int8.onnx" and .sha256 == $encoder) | not) or
        (any(.response.benchmark.fastLid.models.sherpa.files[];
          .name == "tiny-decoder.int8.onnx" and .sha256 == $decoder) | not) or
        .response.benchmark.fastLid.sherpa.engine.packageVersion != "1.13.4" or
        .response.benchmark.fastLid.sherpa.engine.encoderSha256 != $encoder or
        .response.benchmark.fastLid.sherpa.engine.decoderSha256 != $decoder
      )
    ] | length' "$RESULTS")"
fi

if [[ "$CATALOGUE_UNCHANGED" != "true" || "$USABLE" -lt "$MIN_REQUIRED" \
    || "$FAST_LID_USABLE" -lt "$MIN_REQUIRED" || "$HASH_DRIFT" != "0" \
    || "$FAST_LID_DRIFT" != "0" ]]; then
  echo "benchmark rejected: usable=$USABLE/$REQUESTED fastLidUsable=$FAST_LID_USABLE required=$MIN_REQUIRED hashDrift=$HASH_DRIFT fastLidDrift=$FAST_LID_DRIFT catalogueUnchanged=$CATALOGUE_UNCHANGED" >&2
  echo "evidence preserved at $RESULTS" >&2
  exit 1
fi

echo "benchmark accepted for fixed-window speed/agreement analysis"
echo "evidence preserved at $RESULTS"
