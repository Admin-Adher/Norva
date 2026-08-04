#!/usr/bin/env bash
# Fail-closed, read-only preactivation check for an explicit pilot corridor.
# Secret values are inspected in memory and are never printed.

set -euo pipefail
set +x

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
SQL_FILE="$SCRIPT_DIR/check-norva-partners-pilot-preactivation.sql"
DB_CONTAINER="${NORVA_PARTNERS_DB_CONTAINER:-norva-db}"
DB_USER="${NORVA_PARTNERS_DB_USER:-supabase_admin}"
DB_NAME="${NORVA_PARTNERS_DB_NAME:-postgres}"
EDGE_CONTAINERS=(norva-edge-functions norva-edge-functions-2)
PILOT_COUNTRY="${NORVA_PARTNERS_PILOT_COUNTRY:-}"
PILOT_COUNTRY_ISO3="${NORVA_PARTNERS_PILOT_COUNTRY_ISO3:-}"
PILOT_CURRENCY="${NORVA_PARTNERS_PILOT_CURRENCY:-}"
PILOT_CURRENCY_EXPONENT="${NORVA_PARTNERS_PILOT_CURRENCY_EXPONENT:-}"
PILOT_THRESHOLD_MINOR="${NORVA_PARTNERS_PILOT_THRESHOLD_MINOR:-}"
PILOT_MINIMUM_AGE="${NORVA_PARTNERS_PILOT_MINIMUM_AGE:-}"
CANDIDATE_COMMIT_SHA="${NORVA_PARTNERS_CANDIDATE_COMMIT_SHA:-}"
DEPLOYMENT_ENVIRONMENT="${NORVA_PARTNERS_DEPLOYMENT_ENVIRONMENT:-}"

FAILURES=0

fail() {
  local scope="$1"
  local code="$2"
  printf 'FAIL | %-30s | %s\n' "$scope" "$code" >&2
  FAILURES=$((FAILURES + 1))
}

pass() {
  local scope="$1"
  printf 'PASS | %s\n' "$scope"
}

validate_pilot_inputs() {
  if [[ ! "$PILOT_COUNTRY" =~ ^[A-Z]{2}$ ]]; then
    fail "pilot_input.country" "explicit_iso2_required"
  fi
  if [[ ! "$PILOT_COUNTRY_ISO3" =~ ^[A-Z]{3}$ ]]; then
    fail "pilot_input.country_iso3" "explicit_iso3_required"
  fi
  if [[ ! "$PILOT_CURRENCY" =~ ^[A-Z]{3}$ ]]; then
    fail "pilot_input.currency" "explicit_iso4217_required"
  fi
  if [[ ! "$PILOT_CURRENCY_EXPONENT" =~ ^[0-6]$ ]]; then
    fail "pilot_input.currency_exponent" "explicit_exponent_0_to_6_required"
  fi
  if [[ ! "$PILOT_THRESHOLD_MINOR" =~ ^[1-9][0-9]{0,11}$ ]]; then
    fail "pilot_input.threshold_minor" "explicit_positive_minor_units_required"
  fi
  if [[ ! "$PILOT_MINIMUM_AGE" =~ ^[0-9]{2}$ ]] \
    || (( 10#$PILOT_MINIMUM_AGE < 18 || 10#$PILOT_MINIMUM_AGE > 99 )); then
    fail "pilot_input.minimum_age" "explicit_age_18_to_99_required"
  fi
  if [[ "$PILOT_CURRENCY" == 'USD' ]] \
    && [[ "$PILOT_CURRENCY_EXPONENT" != '2' \
      || "$PILOT_THRESHOLD_MINOR" != '1000' ]]; then
    fail "pilot_input.usd_contract" "usd_requires_exponent_2_and_threshold_1000"
  fi
  if [[ ! "$CANDIDATE_COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]] \
    && [[ ! "$CANDIDATE_COMMIT_SHA" =~ ^[0-9a-f]{64}$ ]]; then
    fail "pilot_input.candidate_commit" "explicit_lowercase_commit_sha_required"
  fi
  if [[ "$DEPLOYMENT_ENVIRONMENT" != 'preproduction' \
    && "$DEPLOYMENT_ENVIRONMENT" != 'production' ]]; then
    fail "pilot_input.deployment_environment" \
      "explicit_preproduction_or_production_required"
  fi
}

validate_pilot_inputs
if (( FAILURES > 0 )); then
  echo "No geography or payout currency is selected implicitly." >&2
  exit 1
fi

if [[ ! -r "$SQL_FILE" ]]; then
  echo "FAIL | preflight SQL is missing or unreadable" >&2
  exit 1
fi

if command -v docker >/dev/null 2>&1; then
  RUNTIME=docker
elif command -v podman >/dev/null 2>&1; then
  RUNTIME=podman
else
  echo "FAIL | Docker or Podman is required" >&2
  exit 1
fi

if ! "$RUNTIME" info >/dev/null 2>&1; then
  echo "FAIL | container runtime is unavailable" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "FAIL | python3 is required for secret-shape validation" >&2
  exit 1
fi

declare -A EDGE_ONE=()
declare -A EDGE_TWO=()

load_container_env() {
  local container="$1"
  local target_name="$2"
  local line name value state
  declare -n target="$target_name"

  if ! "$RUNTIME" inspect "$container" >/dev/null 2>&1; then
    fail "$container" "container_missing"
    return
  fi
  state="$(
    "$RUNTIME" inspect --format \
      '{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
      "$container"
  )"
  if [[ "$state" != 'true|healthy' ]]; then
    fail "$container" "container_not_healthy"
  else
    pass "$container.health"
  fi

  while IFS= read -r line; do
    [[ "$line" == *=* ]] || continue
    name="${line%%=*}"
    value="${line#*=}"
    target["$name"]="$value"
  done < <(
    "$RUNTIME" inspect \
      --format '{{range .Config.Env}}{{println .}}{{end}}' \
      "$container"
  )
}

require_exact() {
  local container="$1" env_name="$2" expected="$3" target_name="$4"
  declare -n target="$target_name"
  if [[ "${target[$env_name]:-}" != "$expected" ]]; then
    fail "$container.$env_name" "expected_value_missing_or_invalid"
  fi
}

require_empty() {
  local container="$1" env_name="$2" target_name="$3"
  declare -n target="$target_name"
  if [[ -n "${target[$env_name]:-}" ]]; then
    fail "$container.$env_name" "must_remain_empty_under_revolut_basic"
  fi
}

require_secret() {
  local container="$1" env_name="$2" min_length="$3" max_length="$4"
  local target_name="$5" value
  declare -n target="$target_name"
  value="${target[$env_name]:-}"
  if (( ${#value} < min_length || ${#value} > max_length )); then
    fail "$container.$env_name" "secret_missing_or_invalid_length"
  fi
}

validate_revenuecat_app_ids() {
  local container="$1" target_name="$2" raw app_id
  local -a app_ids
  declare -n target="$target_name"
  raw="${target[NORVA_REVENUECAT_ALLOWED_APP_IDS]:-}"
  IFS=',' read -r -a app_ids <<< "$raw"
  if (( ${#app_ids[@]} < 1 || ${#app_ids[@]} > 32 )); then
    fail "$container.NORVA_REVENUECAT_ALLOWED_APP_IDS" "allowlist_missing_or_invalid"
    return
  fi
  for app_id in "${app_ids[@]}"; do
    app_id="${app_id#"${app_id%%[![:space:]]*}"}"
    app_id="${app_id%"${app_id##*[![:space:]]}"}"
    if [[ ! "$app_id" =~ ^[^[:space:][:cntrl:]]{3,128}$ ]]; then
      fail "$container.NORVA_REVENUECAT_ALLOWED_APP_IDS" "allowlist_missing_or_invalid"
      return
    fi
  done
}

validate_google_play_service_account() {
  local container="$1" target_name="$2"
  declare -n target="$target_name"
  if ! printf '%s' "${target[GOOGLE_PLAY_SERVICE_ACCOUNT_JSON]:-}" | python3 -c '
import json, re, sys
try:
    value = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
email = value.get("client_email")
private_key = value.get("private_key")
token_uri = value.get("token_uri", "https://oauth2.googleapis.com/token")
valid = (
    isinstance(value, dict)
    and value.get("type") == "service_account"
    and isinstance(email, str)
    and re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email) is not None
    and isinstance(private_key, str)
    and private_key.strip().startswith("-----BEGIN PRIVATE KEY-----")
    and private_key.strip().endswith("-----END PRIVATE KEY-----")
    and token_uri == "https://oauth2.googleapis.com/token"
)
raise SystemExit(0 if valid else 1)
'; then
    fail "$container.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON" "service_account_json_invalid"
  fi
}

validate_didit() {
  local container="$1" target_name="$2" node_a node_b node_c
  local uuid_pattern='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
  local node_pattern='^[A-Za-z0-9._:-]{1,128}$'
  declare -n target="$target_name"

  require_secret "$container" DIDIT_API_KEY 16 512 "$target_name"
  require_secret "$container" DIDIT_WEBHOOK_SECRET 16 512 "$target_name"
  if [[ ! "${target[DIDIT_WORKFLOW_ID]:-}" =~ $uuid_pattern ]]; then
    fail "$container.DIDIT_WORKFLOW_ID" "uuid_invalid"
  fi
  if [[ ! "${target[DIDIT_APPLICATION_ID]:-}" =~ $uuid_pattern ]]; then
    fail "$container.DIDIT_APPLICATION_ID" "uuid_invalid"
  fi
  require_exact "$container" DIDIT_ENVIRONMENT live "$target_name"
  require_exact "$container" DIDIT_SESSION_EXPIRATION_SECONDS 604800 "$target_name"
  require_exact "$container" DIDIT_CALLBACK_URL https://norva.tv/partners-kyc-return "$target_name"

  node_a="${target[DIDIT_ID_VERIFICATION_NODE_ID]:-}"
  node_b="${target[DIDIT_LIVENESS_NODE_ID]:-}"
  node_c="${target[DIDIT_FACE_MATCH_NODE_ID]:-}"
  if [[ ! "$node_a" =~ $node_pattern ]]; then
    fail "$container.DIDIT_ID_VERIFICATION_NODE_ID" "node_id_invalid"
  fi
  if [[ ! "$node_b" =~ $node_pattern ]]; then
    fail "$container.DIDIT_LIVENESS_NODE_ID" "node_id_invalid"
  fi
  if [[ ! "$node_c" =~ $node_pattern ]]; then
    fail "$container.DIDIT_FACE_MATCH_NODE_ID" "node_id_invalid"
  fi
  if [[ "$node_a" == "$node_b" || "$node_a" == "$node_c" || "$node_b" == "$node_c" ]]; then
    fail "$container.didit_nodes" "node_ids_must_be_distinct"
  fi
}

validate_beneficiary_hmac() {
  local container="$1" target_name="$2" active_version
  declare -n target="$target_name"
  active_version="${target[NORVA_PARTNERS_REVOLUT_BENEFICIARY_HMAC_ACTIVE_VERSION]:-}"
  if ! printf '%s\n%s' \
      "${target[NORVA_PARTNERS_REVOLUT_BENEFICIARY_HMAC_KEYS_JSON]:-}" \
      "$active_version" | python3 -c '
import base64, json, re, sys
lines = sys.stdin.read().splitlines()
if len(lines) != 2:
    raise SystemExit(1)
try:
    keys = json.loads(lines[0])
except Exception:
    raise SystemExit(1)
active = lines[1]
if not isinstance(keys, dict) or not 1 <= len(keys) <= 8:
    raise SystemExit(1)
if re.fullmatch(r"[1-9][0-9]{0,9}", active) is None or active not in keys:
    raise SystemExit(1)
for version, encoded in keys.items():
    if re.fullmatch(r"[1-9][0-9]{0,9}", version) is None:
        raise SystemExit(1)
    if not isinstance(encoded, str) or re.fullmatch(r"[A-Za-z0-9_-]{43,86}", encoded) is None:
        raise SystemExit(1)
    try:
        decoded = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
    except Exception:
        raise SystemExit(1)
    if not 32 <= len(decoded) <= 64:
        raise SystemExit(1)
raise SystemExit(0)
'; then
    fail "$container.beneficiary_hmac" "versioned_hmac_config_invalid"
  fi
}

validate_edge_container() {
  local container="$1" target_name="$2" business_name
  declare -n target="$target_name"

  require_secret "$container" NORVA_REVENUECAT_WEBHOOK_AUTH 16 1024 "$target_name"
  require_secret "$container" NORVA_REVENUECAT_WEBHOOK_HMAC_SECRET 32 1024 "$target_name"
  require_secret "$container" NORVA_REVENUECAT_SECRET_API_KEY 16 1024 "$target_name"
  validate_revenuecat_app_ids "$container" "$target_name"
  require_exact "$container" NORVA_RC_ACCEPT_SANDBOX false "$target_name"
  require_exact "$container" NORVA_RC_UNKNOWN_PRODUCT_POLICY error "$target_name"
  require_exact "$container" NORVA_REVENUECAT_TRANSFER_WORKER_BATCH 4 "$target_name"
  require_exact "$container" NORVA_REVENUECAT_TRANSFER_WORKER_MAX_BATCHES 1 "$target_name"
  require_exact "$container" NORVA_REVENUECAT_TRANSFER_WORKER_LEASE_SECONDS 120 "$target_name"

  validate_google_play_service_account "$container" "$target_name"
  require_exact "$container" GOOGLE_PLAY_PACKAGE_NAME tv.norva.phone "$target_name"

  require_exact "$container" NORVA_PARTNERS_ALLOWED_ORIGINS https://norva.tv,https://www.norva.tv "$target_name"
  require_exact "$container" NORVA_PARTNERS_ACCESS_REQUESTS_ENABLED true "$target_name"
  require_exact "$container" NORVA_PARTNERS_DIDIT_CERTIFICATION_ENABLED false "$target_name"
  require_secret "$container" NORVA_REFERRAL_EDGE_HMAC_SECRET 32 1024 "$target_name"
  require_secret "$container" NORVA_REFERRAL_COOKIE_SECRET 32 1024 "$target_name"
  require_secret "$container" NORVA_PARTNERS_TV_RELAY_SECRET 32 1024 "$target_name"
  require_exact "$container" NORVA_PARTNERS_TV_RELAY_HANDOFF_URL https://norva.tv/app.html "$target_name"
  require_exact "$container" NORVA_PARTNERS_TV_RELAY_TTL_SECONDS 300 "$target_name"
  require_exact "$container" NORVA_PARTNERS_WORKER_BATCH 25 "$target_name"
  require_exact "$container" NORVA_PARTNERS_WORKER_MAX_BATCHES 4 "$target_name"
  require_exact "$container" NORVA_PARTNERS_WORKER_LEASE_SECONDS 120 "$target_name"
  require_exact "$container" NORVA_PARTNERS_SHADOW_WINDOW_HOURS 48 "$target_name"

  require_exact "$container" NORVA_PARTNERS_REVOLUT_API_ENABLED false "$target_name"
  require_exact "$container" NORVA_PARTNERS_REVOLUT_API_BATCH 1 "$target_name"
  require_exact "$container" NORVA_PARTNERS_REVOLUT_API_MAX_BATCHES 2 "$target_name"
  require_exact "$container" NORVA_PARTNERS_REVOLUT_API_LEASE_SECONDS 240 "$target_name"
  require_exact "$container" REVOLUT_BUSINESS_TIMEOUT_MS 7000 "$target_name"
  for business_name in \
    REVOLUT_BUSINESS_ENVIRONMENT \
    REVOLUT_BUSINESS_CLIENT_ID \
    REVOLUT_BUSINESS_ISSUER \
    REVOLUT_BUSINESS_PRIVATE_KEY_PEM \
    REVOLUT_BUSINESS_REFRESH_TOKEN \
    REVOLUT_BUSINESS_SOURCE_ACCOUNTS_JSON \
    REVOLUT_BUSINESS_MAX_FEE_MINOR_JSON
  do
    require_empty "$container" "$business_name" "$target_name"
  done
  validate_beneficiary_hmac "$container" "$target_name"
  validate_didit "$container" "$target_name"
}

load_container_env "${EDGE_CONTAINERS[0]}" EDGE_ONE
load_container_env "${EDGE_CONTAINERS[1]}" EDGE_TWO
validate_edge_container "${EDGE_CONTAINERS[0]}" EDGE_ONE
validate_edge_container "${EDGE_CONTAINERS[1]}" EDGE_TWO

PARITY_KEYS=(
  NORVA_REVENUECAT_WEBHOOK_AUTH
  NORVA_REVENUECAT_WEBHOOK_HMAC_SECRET
  NORVA_REVENUECAT_ALLOWED_APP_IDS
  NORVA_REVENUECAT_SECRET_API_KEY
  NORVA_RC_ACCEPT_SANDBOX
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON
  GOOGLE_PLAY_PACKAGE_NAME
  NORVA_PARTNERS_ACCESS_REQUESTS_ENABLED
  NORVA_PARTNERS_DIDIT_CERTIFICATION_ENABLED
  NORVA_REFERRAL_EDGE_HMAC_SECRET
  NORVA_REFERRAL_COOKIE_SECRET
  NORVA_PARTNERS_TV_RELAY_SECRET
  NORVA_PARTNERS_TV_RELAY_HANDOFF_URL
  NORVA_PARTNERS_REVOLUT_API_ENABLED
  NORVA_PARTNERS_REVOLUT_BENEFICIARY_HMAC_KEYS_JSON
  NORVA_PARTNERS_REVOLUT_BENEFICIARY_HMAC_ACTIVE_VERSION
  DIDIT_API_KEY
  DIDIT_WORKFLOW_ID
  DIDIT_APPLICATION_ID
  DIDIT_ENVIRONMENT
  DIDIT_SESSION_EXPIRATION_SECONDS
  DIDIT_WEBHOOK_SECRET
  DIDIT_CALLBACK_URL
  DIDIT_ID_VERIFICATION_NODE_ID
  DIDIT_LIVENESS_NODE_ID
  DIDIT_FACE_MATCH_NODE_ID
)
for parity_key in "${PARITY_KEYS[@]}"; do
  if [[ "${EDGE_ONE[$parity_key]:-}" != "${EDGE_TWO[$parity_key]:-}" ]]; then
    fail "edge_parity.$parity_key" "replicas_differ"
  fi
done

if ! "$RUNTIME" inspect "$DB_CONTAINER" >/dev/null 2>&1; then
  fail "$DB_CONTAINER" "container_missing"
else
  db_state="$(
    "$RUNTIME" inspect --format \
      '{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
      "$DB_CONTAINER"
  )"
  if [[ "$db_state" != 'true|healthy' ]]; then
    fail "$DB_CONTAINER" "container_not_healthy"
  else
    pass "$DB_CONTAINER.health"
  fi

  if db_output="$(
    "$RUNTIME" exec -i "$DB_CONTAINER" \
      psql -X -v ON_ERROR_STOP=1 \
        -v pilot_country="$PILOT_COUNTRY" \
        -v pilot_country_iso3="$PILOT_COUNTRY_ISO3" \
        -v pilot_currency="$PILOT_CURRENCY" \
        -v pilot_currency_exponent="$PILOT_CURRENCY_EXPONENT" \
        -v pilot_threshold_minor="$PILOT_THRESHOLD_MINOR" \
        -v pilot_minimum_age="$PILOT_MINIMUM_AGE" \
        -v candidate_commit_sha="$CANDIDATE_COMMIT_SHA" \
        -v deployment_environment="$DEPLOYMENT_ENVIRONMENT" \
        -U "$DB_USER" -d "$DB_NAME" \
        -qAt -F '|' < "$SQL_FILE"
  )"; then
    while IFS='|' read -r check_name status detail; do
      [[ -n "$check_name" ]] || continue
      if [[ "$status" == 'PASS' ]]; then
        printf 'PASS | db.%-30s | %s\n' "$check_name" "$detail"
      else
        fail "db.$check_name" "$detail"
      fi
    done <<< "$db_output"
  else
    fail "$DB_CONTAINER" "read_only_sql_preflight_failed"
  fi
fi

if (( FAILURES > 0 )); then
  printf '\nPartners pilot preactivation: BLOCKED (%s blocker(s)).\n' "$FAILURES" >&2
  echo "No flag, gate, route, cron or provider configuration was changed." >&2
  exit 1
fi

echo
echo "Partners pilot preactivation: PASS."
echo "This is configuration evidence only; protected external release evidence is still required."
