#!/usr/bin/env bash
# =============================================================================
# 17-run-lid-benchmark.sh — read-only, real-provider LID benchmark
# =============================================================================
# Runs one extraction per exact sample, then compares the current full Whisper
# transcription path with whisper.cpp --detect-language on that same WAV.
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
# =============================================================================
set -euo pipefail
umask 077
export PATH="$HOME/.local/bin:$PATH"

LIMIT="${1:-0}"
[[ "$LIMIT" =~ ^[0-9]+$ ]] || { echo "limit must be a non-negative integer" >&2; exit 2; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }

FUNCTIONS_BASE="${FUNCTIONS_BASE:-https://api.norva.tv/functions/v1}"
GATEWAY_HEALTH="${GATEWAY_HEALTH:-https://norva-production.up.railway.app/health}"
EXPECTED_WHISPER_COMMIT="080bbbe85230f624f0b52127f1ae1218247989f9"
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
FLAG_ENABLED=0

disable_flag() {
  if [[ "$FLAG_ENABLED" == "1" ]]; then
    "${PSQL[@]}" -c \
      "update public.admin_feature_flags set enabled=false, updated_at=now(), updated_by='ops-lid-benchmark' where key='lid_benchmark_enabled';" \
      >/dev/null 2>&1 || true
  fi
  rm -f "$AUTH_HEADER"
}
trap disable_flag EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

TOKEN=$("${PSQL[@]}" -c \
  "select decrypted_secret from vault.decrypted_secrets where name='norva_backfill_token'")
[[ -n "$TOKEN" ]] || { echo "norva_backfill_token is missing" >&2; exit 1; }
printf 'Authorization: Bearer %s\n' "$TOKEN" >"$AUTH_HEADER"
chmod 600 "$AUTH_HEADER"
unset TOKEN

HEALTH="$(curl -fsS --max-time 30 "$GATEWAY_HEALTH")"
printf '%s' "$HEALTH" | jq -e --arg commit "$EXPECTED_WHISPER_COMMIT" '
  .ok == true and
  .version >= 70 and
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
${LIMIT:+limit $( [[ "$LIMIT" -gt 0 ]] && printf '%s' "$LIMIT" || printf '1000000' )};
SQL
)

[[ "${#SAMPLES[@]}" -gt 0 ]] || { echo "the real corpus is empty" >&2; exit 1; }
if [[ "$LIMIT" == "0" ]]; then
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
  response='{"runnerError":"request-not-run"}'
  http_status=0
  attempt=0
  while [[ "$attempt" -lt 3 ]]; do
    attempt=$((attempt + 1))
    set +e
    raw="$(printf '%s' "$payload" | curl -sS --max-time 190 -X POST \
      "$FUNCTIONS_BASE/norva-playback/audio-backfill" \
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
      if [[ "$http_status" == "429" || "$http_status" == "502" || "$http_status" == "503" ]]; then
        transient=true
      else
        transient="$(printf '%s' "$response" | jq -r '
          ((.status // 0) == 429 or (.status // 0) == 502 or (.status // 0) == 503) or
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
  printf '[%3d/%3d] %-21s %s -> %s / %s (%sms vs %sms)%s\n' \
    "$completed" "${#SAMPLES[@]}" "$cohort" "$key" \
    "$(printf '%s' "$response" | jq -r '.benchmark.current.productionLanguage // "-"')" \
    "$(printf '%s' "$response" | jq -r '.benchmark.detectOnly.candidateLanguage // "-"')" \
    "$(printf '%s' "$response" | jq -r '.benchmark.timings.currentMs // "-"')" \
    "$(printf '%s' "$response" | jq -r '.benchmark.timings.detectOnlyMs // "-"')" \
    "$(printf '%s' "$response" | jq -r 'if .skipped then " skipped=" + .skipped elif .error then " error=" + .error elif .runnerError then " error=" + .runnerError elif .benchmark.system.contended then " CONTENDED" else "" end')"
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
  [ $completed[] | select(.response.benchmark.system.contended != true) ] as $usable |
  [ $usable[] | select(.response.benchmark.current.productionAccepted == true) ] as $acceptedCurrent |
  {
    requested: length,
    completed: ($completed | length),
    usable: ($usable | length),
    skipped: ([ .[] | select(.response.skipped != null) ] | group_by(.response.skipped) |
      map({key: .[0].response.skipped, value: length}) | from_entries),
    failures: ([ .[] | select(.response.benchmark == null and .response.skipped == null) |
      {
        status: (.response.status // .httpStatus),
        error: (.response.error // .response.runnerError // "unknown")
      }
    ] | group_by([.status, .error]) | map({
      status: .[0].status, error: .[0].error, count: length
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
    medianInferenceSpeedup: ([$usable[].response.benchmark.gains.lidSpeedup | select(. != null)] | median),
    medianFixedWindowEndToEndSpeedup: ([$usable[].response.benchmark.gains.endToEndSpeedup | select(. != null)] | median),
    fixedWindowCurrentTracksPerHour: ([$usable[].response.benchmark.timings.totalCurrentMs] |
      if length == 0 or add == 0 then null else 3600000 / (add / length) end),
    fixedWindowDetectOnlyTracksPerHour: ([$usable[].response.benchmark.timings.totalDetectOnlyMs] |
      if length == 0 or add == 0 then null else 3600000 / (add / length) end),
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
HASH_DRIFT="$(jq -s --arg commit "$EXPECTED_WHISPER_COMMIT" '[
  .[] | select(.response.benchmark != null) | select(
    .response.benchmark.engine.commit != $commit or
    .response.benchmark.engine.model != "small" or
    .response.benchmark.engine.runtimeVerified != true or
    ((.response.benchmark.engine.binarySha256 // "") | test("^[a-f0-9]{64}$") | not) or
    ((.response.benchmark.engine.modelSha256 // "") | test("^[a-f0-9]{64}$") | not)
  )
] | length' "$RESULTS")"

if [[ "$CATALOGUE_UNCHANGED" != "true" || "$USABLE" -lt "$MIN_REQUIRED" || "$HASH_DRIFT" != "0" ]]; then
  echo "benchmark rejected: usable=$USABLE/$REQUESTED required=$MIN_REQUIRED hashDrift=$HASH_DRIFT catalogueUnchanged=$CATALOGUE_UNCHANGED" >&2
  echo "evidence preserved at $RESULTS" >&2
  exit 1
fi

echo "benchmark accepted for fixed-window speed/agreement analysis"
echo "evidence preserved at $RESULTS"
