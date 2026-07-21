#!/usr/bin/env bash
set -euo pipefail

# Rotate Norva's DOMAIN-SCOPED sending credential without exposing the separate
# full-access management credential to Edge or GoTrue. Run from ops/hetzner.
#
# First privilege split: set RESEND_MANAGEMENT_API_KEY to the current full-access
# key and invoke with `none`; the old full-access key is retained for ops only.
# Later rotations: pass the UUID of the old sending key so it is revoked last.

OLD_SEND_KEY_ID="${1:-}"
ENV_FILE="${ENV_FILE:-.env}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.supabase.yml}"
DOMAIN_NAME="${RESEND_SENDING_DOMAIN:-norva.tv}"

if [[ "$OLD_SEND_KEY_ID" != "none" && ! "$OLD_SEND_KEY_ID" =~ ^[0-9a-fA-F-]{36}$ ]]; then
  echo "usage: $0 <old-sending-key-id|none>" >&2
  exit 2
fi
if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing $ENV_FILE" >&2
  exit 2
fi

umask 077
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

management_key="$(sed -n 's/^RESEND_MANAGEMENT_API_KEY=//p' "$ENV_FILE" | head -n1 | tr -d '\r')"
old_send_key="$(sed -n 's/^RESEND_API_KEY=//p' "$ENV_FILE" | head -n1 | tr -d '\r')"
smtp_pass="$(sed -n 's/^SMTP_PASS=//p' "$ENV_FILE" | head -n1 | tr -d '\r')"
if [[ ! "$management_key" =~ ^re_[A-Za-z0-9_-]+$ ]]; then
  echo "RESEND_MANAGEMENT_API_KEY is empty or invalid" >&2
  exit 1
fi
if [[ ! "$old_send_key" =~ ^re_[A-Za-z0-9_-]+$ ]]; then
  echo "RESEND_API_KEY is empty or invalid" >&2
  exit 1
fi

api_management_read() {
  local endpoint="$1"
  curl -fsS --retry 4 --retry-all-errors --retry-delay 1 \
    --connect-timeout 10 --max-time 30 \
    "https://api.resend.com$endpoint" \
    -H "Authorization: Bearer $management_key" \
    -H 'Content-Type: application/json' \
    -H 'User-Agent: Norva-Ops/3.0'
}

api_management_create_once() {
  local endpoint="$1" body="$2" output="$3" label="$4" status rc
  set +e
  status="$(curl -sS --connect-timeout 10 --max-time 30 \
    -o "$output" -w '%{http_code}' \
    -X POST "https://api.resend.com$endpoint" \
    -H "Authorization: Bearer $management_key" \
    -H 'Content-Type: application/json' \
    -H 'User-Agent: Norva-Ops/3.0' \
    --data "$body")"
  rc=$?
  set -e
  if [[ $rc -ne 0 || ! "$status" =~ ^2[0-9]{2}$ ]]; then
    echo "Resend key creation was not retried (curl=$rc HTTP=${status:-000})." >&2
    echo "Before rerunning, list API keys and revoke any orphan named: $label" >&2
    exit 1
  fi
}

api_management_delete_idempotent() {
  local endpoint="$1" status
  # DELETE is safe to repeat. A 404 after an ambiguously successful first
  # attempt is the desired terminal state.
  status="$(curl -sS --retry 4 --retry-all-errors --retry-delay 1 \
    --connect-timeout 10 --max-time 30 \
    -o "$work/delete.json" -w '%{http_code}' \
    -X DELETE "https://api.resend.com$endpoint" \
    -H "Authorization: Bearer $management_key" \
    -H 'User-Agent: Norva-Ops/3.0')"
  if [[ ! "$status" =~ ^2[0-9]{2}$ && "$status" != "404" ]]; then
    echo "Resend key revocation failed (HTTP $status)" >&2
    exit 1
  fi
}

api_management_read '/domains?limit=100' > "$work/domains.json"
domain_id="$(python3 - "$work/domains.json" "$DOMAIN_NAME" <<'PY'
import json, sys
payload = json.load(open(sys.argv[1]))
for row in payload.get("data", []):
    if row.get("name") == sys.argv[2] and row.get("status") == "verified":
        print(row.get("id", ""))
        break
PY
)"
if [[ ! "$domain_id" =~ ^[0-9a-fA-F-]{36}$ ]]; then
  echo "verified Resend domain not found: $DOMAIN_NAME" >&2
  exit 1
fi

create_name="Norva Production Send $(date -u +%Y-%m-%dT%H%MZ)"
create_body="$(python3 - "$domain_id" "$create_name" <<'PY'
import json, sys
print(json.dumps({
  "name": sys.argv[2],
  "permission": "sending_access",
  "domain_id": sys.argv[1],
}, separators=(",", ":")))
PY
)"
api_management_create_once '/api-keys' "$create_body" "$work/new-key.json" "$create_name"

new_key="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["token"])' "$work/new-key.json")"
new_key_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$work/new-key.json")"
if [[ ! "$new_key" =~ ^re_[A-Za-z0-9_-]+$ ]] || [[ ! "$new_key_id" =~ ^[0-9a-fA-F-]{36}$ ]]; then
  echo "Resend returned an invalid sending key" >&2
  exit 1
fi

backup="$ENV_FILE.resend-rotation-$(date -u +%Y%m%dT%H%M%SZ).bak"
cp -p "$ENV_FILE" "$backup"

replace_env_key() {
  local key="$1" value="$2" target="$work/env"
  awk -v wanted="$key" -v replacement="$value" '
    BEGIN { found = 0 }
    index($0, wanted "=") == 1 { print wanted "=" replacement; found = 1; next }
    { print }
    END { if (!found) print wanted "=" replacement }
  ' "$ENV_FILE" > "$target"
  chmod --reference="$ENV_FILE" "$target"
  mv "$target" "$ENV_FILE"
}

replace_env_key RESEND_API_KEY "$new_key"
smtp_rotated=false
if [[ -n "$smtp_pass" && "$smtp_pass" == "$old_send_key" ]]; then
  replace_env_key SMTP_PASS "$new_key"
  smtp_rotated=true
fi

docker compose -f "$COMPOSE_FILE" up -d --force-recreate functions functions2 >/dev/null
if [[ "$smtp_rotated" == true ]]; then
  docker compose -f "$COMPOSE_FILE" up -d --force-recreate auth >/dev/null
fi

edge_key="$(docker inspect norva-edge-functions --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | sed -n 's/^RESEND_API_KEY=//p' | head -n1)"
edge_key_2="$(docker inspect norva-edge-functions-2 --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | sed -n 's/^RESEND_API_KEY=//p' | head -n1)"
if [[ "$edge_key" != "$new_key" || "$edge_key_2" != "$new_key" ]]; then
  echo "replacement sending key did not reach every Edge runtime" >&2
  exit 1
fi
for container in norva-edge-functions norva-edge-functions-2; do
  if docker inspect "$container" --format '{{range .Config.Env}}{{println .}}{{end}}' \
      | grep -q '^RESEND_MANAGEMENT_API_KEY='; then
    echo "full-access management key leaked into $container" >&2
    exit 1
  fi
done
if [[ "$smtp_rotated" == true ]]; then
  auth_key="$(docker inspect norva-auth --format '{{range .Config.Env}}{{println .}}{{end}}' \
    | sed -n 's/^GOTRUE_SMTP_PASS=//p' | head -n1)"
  if [[ "$auth_key" != "$new_key" ]]; then
    echo "replacement sending key did not reach GoTrue SMTP" >&2
    exit 1
  fi
fi

# A sending-only key must be denied access to account resources. This checks the
# permission boundary without sending a message or printing any credential.
limited_status="$(curl -sS -o "$work/limited.json" -w '%{http_code}' \
  'https://api.resend.com/contacts?limit=1' \
  -H "Authorization: Bearer $new_key" \
  -H 'User-Agent: Norva-Ops/3.0')"
if [[ "$limited_status" != "401" && "$limited_status" != "403" ]]; then
  echo "replacement key is not demonstrably sending-only (contacts HTTP $limited_status)" >&2
  exit 1
fi

# Revocation is deliberately last. During the initial split the old full-access
# key becomes the management key and must be retained, hence the `none` option.
if [[ "$OLD_SEND_KEY_ID" != "none" ]]; then
  api_management_delete_idempotent "/api-keys/$OLD_SEND_KEY_ID"
fi

rm -f -- "$backup"
echo "resend_sending_key_rotated=true"
echo "new_key_id=$new_key_id"
echo "domain=$DOMAIN_NAME"
echo "smtp_rotated=$smtp_rotated"
echo "old_key_revoked=$([[ "$OLD_SEND_KEY_ID" == "none" ]] && echo false || echo true)"
echo "rollback_copy_removed=true"
