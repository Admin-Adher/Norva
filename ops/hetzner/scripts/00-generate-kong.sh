#!/usr/bin/env bash
# =============================================================================
# Generate kong/kong.yml from kong/kong.template.yml + the secrets in .env.
# Only ${ANON_KEY} ${SERVICE_ROLE_KEY} ${DASHBOARD_USERNAME} ${DASHBOARD_PASSWORD}
# are substituted (so nothing else in the template is touched). The output
# kong/kong.yml contains the real keys and is gitignored — never commit it.
#
# Run from ops/hetzner:   bash scripts/00-generate-kong.sh
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$HERE/.env"
TEMPLATE="$HERE/kong/kong.template.yml"
OUT="$HERE/kong/kong.yml"

[ -f "$ENV_FILE" ] || { echo "ERROR: $ENV_FILE not found — copy .env.hetzner.example to .env and fill it first." >&2; exit 1; }
[ -f "$TEMPLATE" ] || { echo "ERROR: $TEMPLATE not found." >&2; exit 1; }

# Load only the four vars we substitute (avoid sourcing the whole .env into the shell).
set -a
# shellcheck disable=SC1090
ANON_KEY="$(grep -E '^ANON_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
SERVICE_ROLE_KEY="$(grep -E '^SERVICE_ROLE_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
DASHBOARD_USERNAME="$(grep -E '^DASHBOARD_USERNAME=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
DASHBOARD_PASSWORD="$(grep -E '^DASHBOARD_PASSWORD=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
set +a

for v in ANON_KEY SERVICE_ROLE_KEY DASHBOARD_USERNAME DASHBOARD_PASSWORD; do
  if [ -z "${!v:-}" ]; then echo "ERROR: $v is empty in .env — fill it before generating kong.yml." >&2; exit 1; fi
done

mkdir -p "$HERE/kong"
envsubst '${ANON_KEY} ${SERVICE_ROLE_KEY} ${DASHBOARD_USERNAME} ${DASHBOARD_PASSWORD}' < "$TEMPLATE" > "$OUT"
echo "[generate-kong] wrote $OUT ($(wc -l < "$OUT") lines). It contains real keys — do NOT commit it."
