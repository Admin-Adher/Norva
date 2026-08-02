#!/usr/bin/env bash
set -euo pipefail

# Read-only preflight for Norva's authoritative GoTrue -> signed HTTP hook ->
# Resend authentication-email path. It never sends an email and never prints a
# credential. Run from ops/hetzner before a recreate, then again with --runtime.

ENV_FILE="${ENV_FILE:-.env}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.supabase.yml}"
MODE="${1:---config-only}"

case "$MODE" in
  --config-only|--runtime) ;;
  *) echo "usage: $0 [--config-only|--runtime]" >&2; exit 2 ;;
esac

if [[ ! -f "$ENV_FILE" ]]; then
  echo "auth_email_transport=fail reason=missing_env_file" >&2
  exit 2
fi
if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "auth_email_transport=fail reason=missing_compose_file" >&2
  exit 2
fi

umask 077
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

read_env() {
  local key="$1"
  sed -n "s/^${key}=//p" "$ENV_FILE" | head -n1 | tr -d '\r'
}

# Duplicate dotenv keys make first-value/last-value consumers disagree. Reject
# them before reading anything so Auth and Edge cannot silently diverge.
for key in RESEND_API_KEY SEND_EMAIL_HOOK_SECRET AUTH_SEND_EMAIL_HOOK_URI SUPABASE_PUBLIC_URL AUTH_EMAIL_FROM; do
  count="$(grep -c "^${key}=" "$ENV_FILE" || true)"
  if [[ "$count" != "1" ]]; then
    echo "auth_email_transport=fail reason=duplicate_or_missing_env_key key=$key" >&2
    exit 1
  fi
done

resend_key="$(read_env RESEND_API_KEY)"
hook_secret="$(read_env SEND_EMAIL_HOOK_SECRET)"
hook_uri="$(read_env AUTH_SEND_EMAIL_HOOK_URI)"
public_url="$(read_env SUPABASE_PUBLIC_URL)"
auth_email_from="$(read_env AUTH_EMAIL_FROM)"

if [[ ! "$resend_key" =~ ^re_[A-Za-z0-9_-]{20,}$ ]]; then
  echo "auth_email_transport=fail reason=invalid_resend_sending_key" >&2
  exit 1
fi
if [[ "$auth_email_from" != 'Norva <support@norva.tv>' ]]; then
  echo "auth_email_transport=fail reason=invalid_auth_email_from" >&2
  exit 1
fi
if [[ -z "$hook_secret" || "$hook_secret" == \|* || "$hook_secret" == *\| || "$hook_secret" == *"||"* ]]; then
  echo "auth_email_transport=fail reason=invalid_send_email_hook_secret" >&2
  exit 1
fi
IFS='|' read -r -a hook_secrets <<< "$hook_secret"
for candidate in "${hook_secrets[@]}"; do
  payload="${candidate#v1,whsec_}"
  if [[ "$candidate" != v1,whsec_* \
      || ! "$payload" =~ ^[A-Za-z0-9+/=]{32,88}$ ]]; then
    echo "auth_email_transport=fail reason=invalid_send_email_hook_secret" >&2
    exit 1
  fi
  if ! HOOK_SECRET_CANDIDATE="$candidate" python3 <<'PY'
import base64
import os

payload = os.environ["HOOK_SECRET_CANDIDATE"].removeprefix("v1,whsec_")
try:
    decoded = base64.b64decode(payload, validate=True)
except (ValueError, TypeError):
    raise SystemExit(1)
if not 24 <= len(decoded) <= 64:
    raise SystemExit(1)
PY
  then
    echo "auth_email_transport=fail reason=invalid_send_email_hook_secret" >&2
    exit 1
  fi
done

# The function must be reached over HTTPS. GoTrue 2.189 rejects HTTP hooks whose
# host is a Docker service name. It also must share the authoritative API origin
# so an operator cannot accidentally route signed Auth payloads elsewhere.
python3 - "$hook_uri" "$public_url" <<'PY'
import sys
from urllib.parse import urlsplit

hook = urlsplit(sys.argv[1])
public = urlsplit(sys.argv[2])
if hook.scheme != "https" or not hook.hostname:
    raise SystemExit("AUTH_SEND_EMAIL_HOOK_URI must use HTTPS")
if (hook.scheme, hook.netloc) != (public.scheme, public.netloc):
    raise SystemExit("AUTH_SEND_EMAIL_HOOK_URI must use SUPABASE_PUBLIC_URL origin")
if hook.path.rstrip("/") != "/functions/v1/norva-auth-email" or hook.query or hook.fragment:
    raise SystemExit("AUTH_SEND_EMAIL_HOOK_URI must target /functions/v1/norva-auth-email exactly")
PY

# Required Compose interpolation proves the signer and verifier cannot be
# rendered independently. The rendered file is private and deleted on exit.
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config > "$work/compose.yml"

if [[ "$MODE" == "--config-only" ]]; then
  echo "auth_email_transport=config_valid"
  exit 0
fi

container_env() {
  local container="$1" key="$2"
  docker inspect "$container" --format '{{range .Config.Env}}{{println .}}{{end}}' \
    | sed -n "s/^${key}=//p" | head -n1
}

assert_healthy() {
  local container="$1" health
  health="$(docker inspect "$container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')"
  if [[ "$health" != "healthy" && "$health" != "running" ]]; then
    echo "auth_email_transport=fail reason=container_unhealthy container=$container" >&2
    exit 1
  fi
}

for container in norva-auth norva-edge-functions norva-edge-functions-2; do
  assert_healthy "$container"
done

if [[ "$(container_env norva-auth GOTRUE_HOOK_SEND_EMAIL_ENABLED)" != "true" ]]; then
  echo "auth_email_transport=fail reason=auth_hook_disabled" >&2
  exit 1
fi
if [[ "$(container_env norva-auth GOTRUE_HOOK_SEND_EMAIL_URI)" != "$hook_uri" ]]; then
  echo "auth_email_transport=fail reason=auth_hook_uri_drift" >&2
  exit 1
fi
if [[ "$(container_env norva-auth GOTRUE_HOOK_SEND_EMAIL_SECRETS)" != "$hook_secret" ]]; then
  echo "auth_email_transport=fail reason=auth_hook_secret_drift" >&2
  exit 1
fi

for container in norva-edge-functions norva-edge-functions-2; do
  if [[ "$(container_env "$container" SEND_EMAIL_HOOK_SECRET)" != "$hook_secret" ]]; then
    echo "auth_email_transport=fail reason=edge_hook_secret_drift container=$container" >&2
    exit 1
  fi
  if [[ "$(container_env "$container" RESEND_API_KEY)" != "$resend_key" ]]; then
    echo "auth_email_transport=fail reason=edge_resend_key_drift container=$container" >&2
    exit 1
  fi
  if [[ "$(container_env "$container" AUTH_EMAIL_FROM)" != "$auth_email_from" ]]; then
    echo "auth_email_transport=fail reason=edge_auth_email_from_drift container=$container" >&2
    exit 1
  fi
done

# An unsigned probe must reach the exact function and be rejected by its
# signature boundary. 401 proves routing without creating or sending mail.
probe_status="$(curl -sS --connect-timeout 10 --max-time 20 \
  -o "$work/probe.json" -w '%{http_code}' -X POST "$hook_uri" \
  -H 'Content-Type: application/json' --data '{}')"
if [[ "$probe_status" != "401" ]]; then
  echo "auth_email_transport=fail reason=unsigned_probe_unexpected_status status=$probe_status" >&2
  exit 1
fi

probe_body='{}'
probe_id="auth-email-preflight-$(date -u +%s)"
probe_timestamp="$(date -u +%s)"
active_secret="${hook_secrets[0]}"
probe_signature="$(HOOK_SECRET="$active_secret" PROBE_ID="$probe_id" \
  PROBE_TIMESTAMP="$probe_timestamp" PROBE_BODY="$probe_body" python3 <<'PY'
import base64, hashlib, hmac, os
secret = os.environ["HOOK_SECRET"].removeprefix("v1,whsec_")
key = base64.b64decode(secret, validate=True)
message = f'{os.environ["PROBE_ID"]}.{os.environ["PROBE_TIMESTAMP"]}.{os.environ["PROBE_BODY"]}'.encode()
print(base64.b64encode(hmac.new(key, message, hashlib.sha256).digest()).decode())
PY
)"
signed_status="$(curl -sS --connect-timeout 10 --max-time 20 \
  -o "$work/signed-probe.json" -w '%{http_code}' -X POST "$hook_uri" \
  -H 'Content-Type: application/json' \
  -H "webhook-id: $probe_id" \
  -H "webhook-timestamp: $probe_timestamp" \
  -H "webhook-signature: v1,$probe_signature" \
  --data "$probe_body")"
if [[ "$signed_status" != "400" ]]; then
  echo "auth_email_transport=fail reason=signed_probe_unexpected_status status=$signed_status" >&2
  exit 1
fi

echo "auth_email_transport=runtime_valid"
echo "auth_hook_enabled=true"
echo "auth_hook_replica_parity=true"
echo "auth_sender_replica_parity=true"
echo "unsigned_probe_rejected=true"
echo "signed_probe_verified=true"
