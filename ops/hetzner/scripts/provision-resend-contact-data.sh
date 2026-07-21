#!/usr/bin/env bash
set -euo pipefail

# Idempotently provision Norva's canonical Resend contact model and record the
# environment-specific IDs in cloud_resend_taxonomy. Run from ops/hetzner after
# 20260722004000_resend_contact_ops_worker.sql has been applied.
#
# Reads are retried and fully cursor-paginated. Non-idempotent POST creates are
# attempted exactly once; an ambiguous response is reconciled with a fresh list
# before the script either continues or exits safely for a rerun.

ENV_FILE="${ENV_FILE:-.env}"
DB_CONTAINER="${DB_CONTAINER:-norva-db}"
DB_USER="${DB_USER:-supabase_admin}"
DB_NAME="${DB_NAME:-postgres}"
API_ROOT="https://api.resend.com"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing $ENV_FILE" >&2
  exit 2
fi
for command in curl python3 docker; do
  command -v "$command" >/dev/null || { echo "missing dependency: $command" >&2; exit 2; }
done

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

json_named_value() {
  local name="$1" field="$2"
  python3 -c '
import json, sys
payload = json.load(sys.stdin)
name, field = sys.argv[1], sys.argv[2]
for row in payload.get("data", []):
    if row.get("name") == name or row.get("key") == name:
        value = row.get(field, "")
        print(value if value is not None else "")
        break
' "$name" "$field"
}

json_field() {
  local field="$1"
  python3 -c '
import json, sys
try:
    payload = json.load(sys.stdin)
except (json.JSONDecodeError, UnicodeDecodeError):
    print("")
    raise SystemExit(0)
value = payload.get(sys.argv[1], "")
print(value if value is not None else "")
' "$field"
}

json_object() {
  python3 -c '
import json, sys
result = {}
for pair in sys.argv[1:]:
    key, kind, value = pair.split("=", 2)
    result[key] = int(value) if kind == "number" else value
print(json.dumps(result, separators=(",", ":")))
' "$@"
}

RESEND_MANAGEMENT_API_KEY="$(sed -n 's/^RESEND_MANAGEMENT_API_KEY=//p' "$ENV_FILE" | head -n1 | tr -d '\r')"
if [[ ! "$RESEND_MANAGEMENT_API_KEY" =~ ^re_[A-Za-z0-9_-]+$ ]]; then
  echo "RESEND_MANAGEMENT_API_KEY is empty or invalid" >&2
  exit 2
fi

DEDICATED_TEAM_CONFIRMED="$(sed -n 's/^RESEND_DEDICATED_TEAM_CONFIRMED=//p' "$ENV_FILE" | tail -n1 | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
if [[ "$DEDICATED_TEAM_CONFIRMED" != 'true' ]]; then
  echo 'refusing contact provisioning: Norva must first be moved to a dedicated Resend team' >&2
  echo 'set RESEND_DEDICATED_TEAM_CONFIRMED=true only after verifying BuildTrack uses another team' >&2
  exit 3
fi

api_read() {
  local endpoint="$1"
  curl -fsS --retry 4 --retry-all-errors --retry-delay 1 \
    --connect-timeout 10 --max-time 30 \
    "$API_ROOT$endpoint" \
    -H "Authorization: Bearer $RESEND_MANAGEMENT_API_KEY" \
    -H 'Content-Type: application/json' \
    -H 'User-Agent: Norva-Ops/3.0'
}

api_write_once() {
  local method="$1" endpoint="$2" body="${3:-}"
  local args=(
    -fsS --connect-timeout 10 --max-time 30
    -X "$method" "$API_ROOT$endpoint"
    -H "Authorization: Bearer $RESEND_MANAGEMENT_API_KEY"
    -H 'Content-Type: application/json'
    -H 'User-Agent: Norva-Ops/3.0'
  )
  if [[ -n "$body" ]]; then args+=(--data "$body"); fi
  # Automatic retries are intentionally absent: POST create is not idempotent.
  curl "${args[@]}"
}

api_list_all() {
  local endpoint="$1" after="" next_after="" page=0 page_file="$WORK_DIR/page.json"
  local aggregate="$WORK_DIR/aggregate.json" next="$WORK_DIR/aggregate.next.json"
  printf '{"object":"list","has_more":false,"data":[]}' >"$aggregate"
  while (( page < 100 )); do
    page=$((page + 1))
    local separator='?'
    [[ "$endpoint" == *'?'* ]] && separator='&'
    local request="${endpoint}${separator}limit=100"
    if [[ -n "$after" ]]; then request="${request}&after=${after}"; fi
    api_read "$request" >"$page_file"
    python3 - "$aggregate" "$page_file" "$next" <<'PY'
import json, os, sys
aggregate_path, page_path, next_path = sys.argv[1:]
with open(aggregate_path, encoding="utf-8") as handle:
    aggregate = json.load(handle)
with open(page_path, encoding="utf-8") as handle:
    page = json.load(handle)
rows = page.get("data", [])
if not isinstance(rows, list):
    raise SystemExit("invalid Resend list response")
aggregate["data"].extend(rows)
aggregate["has_more"] = False
with open(next_path, "w", encoding="utf-8") as handle:
    json.dump(aggregate, handle, separators=(",", ":"))
os.replace(next_path, aggregate_path)
PY
    has_more="$(python3 -c 'import json,sys; print("true" if json.load(open(sys.argv[1])).get("has_more") else "false")' "$page_file")"
    if [[ "$has_more" != 'true' ]]; then cat "$aggregate"; return 0; fi
    next_after="$(python3 -c 'import json,sys; rows=json.load(open(sys.argv[1])).get("data",[]); print(rows[-1].get("id","") if rows else "")' "$page_file")"
    if [[ -z "$next_after" || "$next_after" == "$after" ]]; then
      echo "invalid Resend pagination cursor for $endpoint" >&2
      return 1
    fi
    after="$next_after"
  done
  echo "Resend pagination exceeded 100 pages for $endpoint" >&2
  return 1
}

# Topics and Contact Properties can be account-gated. Fail before creating any
# taxonomy when the dedicated team does not expose the required APIs.
api_read '/topics?limit=1' >/dev/null
api_read '/contact-properties?limit=1' >/dev/null
api_read '/segments?limit=1' >/dev/null

valid_uuid() {
  [[ "$1" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]
}

set_taxonomy_id() {
  local kind="$1" slug="$2" remote_id="$3"
  valid_uuid "$remote_id" || { echo "invalid $kind id for $slug" >&2; exit 1; }
  docker exec "$DB_CONTAINER" psql -v ON_ERROR_STOP=1 -qAt \
    -U "$DB_USER" -d "$DB_NAME" \
    -v kind="$kind" -v slug="$slug" -v remote_id="$remote_id" \
    -c "update public.cloud_resend_taxonomy
        set remote_id = :'remote_id'::uuid, updated_at = clock_timestamp()
        where kind = :'kind' and slug = :'slug'
        returning slug;" >/dev/null
}

segments="$(api_list_all '/segments')"
declare -a segment_specs=(
  'internal-pilots|Norva · Internal & pilots'
  'onboarding|Norva · Onboarding'
  'trialing|Norva · Trialing'
  'active-subscribers|Norva · Active subscribers'
  'cancel-scheduled|Norva · Cancel scheduled'
  'payment-recovery|Norva · Payment recovery'
  'churned|Norva · Churned'
  'blocked-suppressed|Norva · Blocked / suppressed'
  'catalog-ready|Norva · Catalog ready'
)

segments_created=0
for spec in "${segment_specs[@]}"; do
  slug="${spec%%|*}"
  name="${spec#*|}"
  remote_id="$(json_named_value "$name" id <<<"$segments")"
  if [[ -z "$remote_id" ]]; then
    created=''
    if created="$(api_write_once POST '/segments' "$(json_object "name=string=$name")")"; then
      remote_id="$(json_field id <<<"$created")"
    fi
    # Both a failed request and a success without an id are ambiguous. Re-list
    # once; never repeat the non-idempotent create blindly.
    if [[ -n "$remote_id" ]] && ! valid_uuid "$remote_id"; then remote_id=''; fi
    if [[ -z "$remote_id" ]]; then
      refreshed="$(api_list_all '/segments')"
      remote_id="$(json_named_value "$name" id <<<"$refreshed")"
    fi
    if [[ -z "$remote_id" ]]; then
      echo "segment create not confirmed for $slug; safe to rerun after checking Resend" >&2
      exit 1
    fi
    segments_created=$((segments_created + 1))
    sleep 0.3
  fi
  set_taxonomy_id segment "$slug" "$remote_id"
done

topics="$(api_list_all '/topics')"
topic_name='Product news & offers'
topic_slug='product-news-offers'
topic_id="$(json_named_value "$topic_name" id <<<"$topics")"
topic_created=0
if [[ -z "$topic_id" ]]; then
  topic=''
  if topic="$(api_write_once POST '/topics' "$(json_object \
    "name=string=$topic_name" \
    'description=string=Occasional Norva product news, useful tips and relevant offers.' \
    'default_subscription=string=opt_out')")"; then
    topic_id="$(json_field id <<<"$topic")"
  fi
  if [[ -n "$topic_id" ]] && ! valid_uuid "$topic_id"; then topic_id=''; fi
  if [[ -z "$topic_id" ]]; then
    topics="$(api_list_all '/topics')"
    topic_id="$(json_named_value "$topic_name" id <<<"$topics")"
  fi
  if [[ -z "$topic_id" ]]; then
    echo 'topic create not confirmed; safe to rerun after checking Resend' >&2
    exit 1
  fi
  topic_created=1
fi
set_taxonomy_id topic "$topic_slug" "$topic_id"

properties="$(api_list_all '/contact-properties')"
declare -a property_specs=(
  'norva_contact_key|string|removed'
  'account_class|string|unknown'
  'identity_state|string|unknown'
  'entitlement_state|string|none'
  'plan|string|none'
  'billing_provider|string|none'
  'onboarding_stage|string|none'
  'catalog_health|string|none'
  'source_count|number|0'
  'ready_source_count|number|0'
  'engagement_stage|string|never_played'
  'signup_cohort|string|unknown'
  'locale|string|unknown'
  'country_code|string|unknown'
)

properties_created=0
for spec in "${property_specs[@]}"; do
  key="${spec%%|*}"
  rest="${spec#*|}"
  type="${rest%%|*}"
  fallback="${rest#*|}"
  existing="$(json_named_value "$key" type <<<"$properties")"
  if [[ -n "$existing" && "$existing" != "$type" ]]; then
    echo "contact property $key exists with incompatible type $existing" >&2
    exit 1
  fi
  if [[ -z "$existing" ]]; then
    if [[ "$type" == 'number' ]]; then
      body="$(json_object "key=string=$key" "type=string=$type" "fallback_value=number=$fallback")"
    else
      body="$(json_object "key=string=$key" "type=string=$type" "fallback_value=string=$fallback")"
    fi
    api_write_once POST '/contact-properties' "$body" >/dev/null || true
    properties="$(api_list_all '/contact-properties')"
    existing="$(json_named_value "$key" type <<<"$properties")"
    if [[ "$existing" != "$type" ]]; then
      echo "contact property create not confirmed for $key; safe to rerun after checking Resend" >&2
      exit 1
    fi
    properties_created=$((properties_created + 1))
    sleep 0.3
  fi
done

# v2 exported raw UUIDs and exact timestamps. Deleting these property
# definitions removes their stored values team-wide; the v3 worker never sends
# them again. The dedicated-team gate above protects unrelated products.
deprecated_properties_removed=0
for key in norva_user_id signup_at last_active_at; do
  property_id="$(json_named_value "$key" id <<<"$properties")"
  if [[ -z "$property_id" ]]; then continue; fi
  valid_uuid "$property_id" || { echo "invalid contact property id for $key" >&2; exit 1; }
  api_write_once DELETE "/contact-properties/$property_id" >/dev/null || true
  properties="$(api_list_all '/contact-properties')"
  if [[ -n "$(json_named_value "$key" id <<<"$properties")" ]]; then
    echo "deprecated contact property $key was not removed; safe to rerun" >&2
    exit 1
  fi
  deprecated_properties_removed=$((deprecated_properties_removed + 1))
done

# The deprecated Audience is exposed as a Segment after Resend's migration. Keep
# its ID managed-but-inactive until the worker removes every membership.
legacy_id="$(json_named_value 'Norva Users' id <<<"$segments")"
if [[ -n "$legacy_id" ]]; then
  valid_uuid "$legacy_id" || { echo 'invalid legacy segment id' >&2; exit 1; }
  docker exec "$DB_CONTAINER" psql -v ON_ERROR_STOP=1 -qAt \
    -U "$DB_USER" -d "$DB_NAME" -v remote_id="$legacy_id" \
    -c "insert into public.cloud_resend_taxonomy(kind,slug,display_name,remote_id,managed,active)
        values ('segment','legacy-all-contacts','Norva Users',:'remote_id'::uuid,true,false)
        on conflict (kind,slug) do update set remote_id=excluded.remote_id,
          managed=true, active=false, updated_at=clock_timestamp();" >/dev/null
fi

configured="$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -qAt -c \
  "select count(*) from public.cloud_resend_taxonomy where active and remote_id is not null;")"
if [[ "$configured" != '10' ]]; then
  echo "taxonomy provisioning incomplete: $configured/10" >&2
  exit 1
fi

echo "resend_contact_data_provisioned=true"
echo "segments_created=$segments_created"
echo "topic_created=$topic_created"
echo "properties_created=$properties_created"
echo "deprecated_properties_removed=$deprecated_properties_removed"
echo "active_taxonomy_ids=$configured"
echo "legacy_segment_managed=$([[ -n "$legacy_id" ]] && echo true || echo false)"
