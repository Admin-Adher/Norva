#!/usr/bin/env bash
# Capture sanitized, read-only evidence for a dormant lifecycle installation.
# This artifact proves deployed code/schema parity and the fail-closed state. It
# never proves transport delivery, device behavior, pilot safety, or uplift.

set -Eeuo pipefail
set +x
umask 077

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
readonly COMPOSE="$REPO_ROOT/ops/hetzner/docker-compose.supabase.yml"
readonly ENV_FILE="$REPO_ROOT/ops/hetzner/.env"
readonly GATE="$SCRIPT_DIR/verify-behavioral-lifecycle-pre-activation.sh"
readonly MIGRATION="$REPO_ROOT/supabase/migrations/20260903180000_behavioral_lifecycle_engine_v1.sql"
readonly HARDENING_MIGRATION="$REPO_ROOT/supabase/migrations/20260904090000_behavioral_lifecycle_import_readiness_append_only.sql"
readonly OUTPUT_DIR="${LIFECYCLE_EVIDENCE_OUTPUT_DIR:-}"
readonly DEPLOYMENT_ID="${LIFECYCLE_DEPLOYMENT_ID:-}"
readonly TARGET_ENVIRONMENT="${LIFECYCLE_TARGET_ENVIRONMENT:-}"
readonly RUNTIME_FILES=(
  'norva-cloud/index.ts'
  'norva-lifecycle/index.ts'
  'norva-admin/index.ts'
  'norva-branded-email-worker/index.ts'
  '_shared/cloud-public-view.mjs'
  '_shared/fcm.ts'
  '_shared/lifecycle-email.ts'
  '_shared/fcm-error.mjs'
  '_shared/resend-transport.mjs'
)

fail() {
  printf 'Behavioral lifecycle evidence capture failed: %s\n' "$1" >&2
  exit 1
}

[[ -n "$OUTPUT_DIR" ]] || fail 'LIFECYCLE_EVIDENCE_OUTPUT_DIR is required'
[[ "$OUTPUT_DIR" == /* ]] || fail 'the evidence output directory must be absolute'
[[ -d "$OUTPUT_DIR" ]] || fail 'the evidence output directory must already exist'
[[ -n "$DEPLOYMENT_ID" ]] || fail 'LIFECYCLE_DEPLOYMENT_ID is required'
[[ "$DEPLOYMENT_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$ ]] \
  || fail 'LIFECYCLE_DEPLOYMENT_ID has an invalid shape'
[[ "$DEPLOYMENT_ID" != *'..'* && "$DEPLOYMENT_ID" != *'//'* ]] \
  || fail 'LIFECYCLE_DEPLOYMENT_ID contains a forbidden traversal marker'
[[ "$TARGET_ENVIRONMENT" == 'staging' || "$TARGET_ENVIRONMENT" == 'production' ]] \
  || fail 'LIFECYCLE_TARGET_ENVIRONMENT must be staging or production'
[[ -f "$COMPOSE" && -f "$ENV_FILE" && -f "$GATE" && -f "$MIGRATION" \
    && -f "$HARDENING_MIGRATION" ]] \
  || fail 'a required reviewed deployment file is missing'

readonly OUTPUT_REAL="$(readlink -f -- "$OUTPUT_DIR")"
readonly REPO_REAL="$(readlink -f -- "$REPO_ROOT")"
[[ -n "$OUTPUT_REAL" && -n "$REPO_REAL" ]] \
  || fail 'unable to resolve evidence or repository path'
case "$OUTPUT_REAL/" in
  "$REPO_REAL/"*) fail 'evidence must be written outside the Git checkout' ;;
esac
[[ "$(stat -c '%a' -- "$OUTPUT_REAL")" == '700' ]] \
  || fail 'the evidence output directory must have mode 700'

readonly COMMIT_SHA="$(git -C "$REPO_REAL" rev-parse --verify HEAD)"
[[ "$COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]] || fail 'invalid repository commit SHA'
[[ -z "$(git -C "$REPO_REAL" status --porcelain --untracked-files=no)" ]] \
  || fail 'the deployed checkout has tracked modifications'

command -v docker >/dev/null 2>&1 || fail 'docker is required'
command -v python3 >/dev/null 2>&1 || fail 'python3 is required'
docker compose --env-file "$ENV_FILE" -f "$COMPOSE" config --quiet \
  || fail 'the rendered Compose configuration is invalid'

mapfile -t EDGE_SERVICES < <(
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE" config --services \
    | grep -E '^functions[0-9]*$'
)
[[ ${#EDGE_SERVICES[@]} -gt 0 ]] || fail 'no Edge runtime service is configured'
if [[ "$TARGET_ENVIRONMENT" == 'production' && ${#EDGE_SERVICES[@]} -lt 2 ]]; then
  fail 'production evidence requires at least two configured Edge replicas'
fi

readonly DB_CONTAINER="$(
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE" ps -q db
)"
[[ -n "$DB_CONTAINER" ]] || fail 'the exact database container is unavailable'
docker inspect "$DB_CONTAINER" >/dev/null 2>&1 \
  || fail 'the exact database container cannot be inspected'

readonly WORK="$(mktemp -d "$OUTPUT_REAL/.lifecycle-evidence.XXXXXX")"
cleanup() {
  case "$WORK/" in
    "$OUTPUT_REAL/".lifecycle-evidence.*'/') rm -rf -- "$WORK" ;;
    *) printf 'Refusing unsafe evidence cleanup path: %s\n' "$WORK" >&2 ;;
  esac
}
trap cleanup EXIT

DB_CONTAINER="$DB_CONTAINER" DB_USER=supabase_admin DB_NAME=postgres \
  bash "$GATE" >"$WORK/database-gate.log"

python3 - "$WORK/database-gate.log" "$WORK/database-gate.json" <<'PY'
import json
import pathlib
import sys

source = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()
objects = []
for line in source:
    try:
        value = json.loads(line)
    except json.JSONDecodeError:
        continue
    if isinstance(value, dict):
        objects.append(value)
if len(objects) != 1:
    raise SystemExit("expected exactly one JSON object from the database gate")
gate = objects[0]
if gate.get("status") != "BEHAVIORAL_LIFECYCLE_PRE_ACTIVATION_READY":
    raise SystemExit("the database gate did not report the reviewed ready state")
if gate.get("emergency_stop") is not True or gate.get("audience_mode") != "internal_test":
    raise SystemExit("the database gate is not fail-closed")
pathlib.Path(sys.argv[2]).write_text(
    json.dumps(gate, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n",
    encoding="utf-8",
    newline="\n",
)
PY

printf 'path\tservice\tdigest\n' >"$WORK/source-digests.tsv"
printf 'service\tcontainer_id\timage_id\trunning\thealth\tstarted_at\n' \
  >"$WORK/runtime.tsv"
for service in "${EDGE_SERVICES[@]}"; do
  container="$(
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE" ps -q "$service"
  )"
  [[ -n "$container" ]] || fail "Edge service $service is not running"
  container_id="$(docker inspect --format '{{.Id}}' "$container")"
  image_id="$(docker inspect --format '{{.Image}}' "$container")"
  running="$(docker inspect --format '{{.State.Running}}' "$container")"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}not_configured{{end}}' "$container")"
  started_at="$(docker inspect --format '{{.State.StartedAt}}' "$container")"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$service" "$container_id" "$image_id" "$running" "$health" "$started_at" \
    >>"$WORK/runtime.tsv"
  for relative_path in "${RUNTIME_FILES[@]}"; do
    source_path="$REPO_REAL/supabase/functions/$relative_path"
    [[ -f "$source_path" ]] || fail "missing source for $relative_path"
    expected="$(sha256sum "$source_path" | awk '{print $1}')"
    observed="$(
      docker exec "$container" sha256sum "/home/deno/functions/$relative_path" \
        | awk '{print $1}'
    )"
    [[ "$observed" == "$expected" ]] \
      || fail "$service source digest mismatch for $relative_path"
    printf '%s\t%s\t%s\n' "$relative_path" "$service" "$observed" \
      >>"$WORK/source-digests.tsv"
  done
done

readonly MIGRATION_SHA256="$(tr -d '\r' < "$MIGRATION" | sha256sum | awk '{print $1}')"
readonly HARDENING_MIGRATION_SHA256="$(tr -d '\r' < "$HARDENING_MIGRATION" | sha256sum | awk '{print $1}')"
readonly CAPTURE_STAMP="$(date -u +'%Y%m%dT%H%M%SZ')"
readonly FINAL_PATH="$OUTPUT_REAL/behavioral-lifecycle-dormant-${TARGET_ENVIRONMENT}-${CAPTURE_STAMP}-${COMMIT_SHA:0:12}.json"
[[ ! -e "$FINAL_PATH" ]] || fail 'refusing to overwrite an existing artifact'

export NORVA_LIFECYCLE_EVIDENCE_WORK="$WORK"
export NORVA_LIFECYCLE_EVIDENCE_OUTPUT="$FINAL_PATH"
export NORVA_LIFECYCLE_EVIDENCE_DEPLOYMENT_ID="$DEPLOYMENT_ID"
export NORVA_LIFECYCLE_EVIDENCE_TARGET="$TARGET_ENVIRONMENT"
export NORVA_LIFECYCLE_EVIDENCE_COMMIT="$COMMIT_SHA"
export NORVA_LIFECYCLE_EVIDENCE_MIGRATION_SHA256="$MIGRATION_SHA256"
export NORVA_LIFECYCLE_EVIDENCE_HARDENING_MIGRATION_SHA256="$HARDENING_MIGRATION_SHA256"

python3 - <<'PY'
import datetime
import hashlib
import json
import os
import pathlib
import re
import tempfile

work = pathlib.Path(os.environ["NORVA_LIFECYCLE_EVIDENCE_WORK"])
output = pathlib.Path(os.environ["NORVA_LIFECYCLE_EVIDENCE_OUTPUT"])
deployment_id = os.environ["NORVA_LIFECYCLE_EVIDENCE_DEPLOYMENT_ID"]
target = os.environ["NORVA_LIFECYCLE_EVIDENCE_TARGET"]
commit = os.environ["NORVA_LIFECYCLE_EVIDENCE_COMMIT"]
migration_sha = os.environ["NORVA_LIFECYCLE_EVIDENCE_MIGRATION_SHA256"]
hardening_migration_sha = os.environ["NORVA_LIFECYCLE_EVIDENCE_HARDENING_MIGRATION_SHA256"]

gate = json.loads((work / "database-gate.json").read_text(encoding="utf-8"))
digests = {}
lines = (work / "source-digests.tsv").read_text(encoding="utf-8").splitlines()
if not lines or lines[0] != "path\tservice\tdigest":
    raise SystemExit("invalid source digest evidence")
for line in lines[1:]:
    runtime_path, service, digest = line.split("\t")
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise SystemExit("invalid source digest")
    digests.setdefault(runtime_path, {})[service] = digest

replicas = []
runtime_lines = (work / "runtime.tsv").read_text(encoding="utf-8").splitlines()
if not runtime_lines or runtime_lines[0] != "service\tcontainer_id\timage_id\trunning\thealth\tstarted_at":
    raise SystemExit("invalid runtime evidence")
for line in runtime_lines[1:]:
    service, container_id, image, running, health, started_at = line.split("\t")
    if not re.fullmatch(r"functions[0-9]*", service):
        raise SystemExit("invalid Edge service name")
    if running != "true":
        raise SystemExit(f"{service} is not running")
    if health not in {"healthy", "not_configured"}:
        raise SystemExit(f"{service} is not healthy")
    image = image.removeprefix("sha256:")
    if not re.fullmatch(r"[0-9a-f]{64}", image):
        raise SystemExit(f"{service} has no immutable image id")
    if not re.fullmatch(r"[0-9a-f]{64}", container_id):
        raise SystemExit(f"{service} has no immutable container id")
    if not started_at:
        raise SystemExit(f"{service} has no start timestamp")
    replicas.append({
        "service": service,
        "running": True,
        "health": health,
        "image_id_sha256": image,
        "container_id_fingerprint_sha256": hashlib.sha256(
            ("norva:lifecycle:container:v1:" + container_id).encode("utf-8")
        ).hexdigest(),
        "started_at": started_at,
    })

if not replicas:
    raise SystemExit("no Edge replica evidence was captured")
services = {item["service"] for item in replicas}
expected_runtime_paths = {
    "norva-cloud/index.ts",
    "norva-lifecycle/index.ts",
    "norva-admin/index.ts",
    "norva-branded-email-worker/index.ts",
    "_shared/cloud-public-view.mjs",
    "_shared/fcm.ts",
    "_shared/lifecycle-email.ts",
    "_shared/fcm-error.mjs",
    "_shared/resend-transport.mjs",
}
if set(digests) != expected_runtime_paths:
    raise SystemExit("runtime source evidence is incomplete")
for runtime_path, by_service in digests.items():
    if set(by_service) != services:
        raise SystemExit(f"incomplete replica coverage for {runtime_path}")
    if len(set(by_service.values())) != 1:
        raise SystemExit(f"replicas disagree for {runtime_path}")

captured_at = datetime.datetime.now(datetime.timezone.utc).replace(
    microsecond=0
).isoformat().replace("+00:00", "Z")
artifact = {
    "schema_version": 2,
    "artifact_type": "norva_behavioral_lifecycle_dormant_installation",
    "evidence_scope": "dormant_installation_only",
    "captured_at": captured_at,
    "target_environment": target,
    "deployment_id": deployment_id,
    "repository": "Admin-Adher/Norva",
    "server_checkout_sha": commit,
    "contains_personal_data": False,
    "contains_secrets": False,
    "migration_sha256s": {
        "engine_v1": migration_sha,
        "import_readiness_append_only": hardening_migration_sha,
    },
    "database_read_only_gate": gate,
    "edge_runtime": {
        "replica_count": len(replicas),
        "replicas": replicas,
        "source_digests_by_replica": digests,
        "source_parity": True,
    },
    "release_assertion": {
        "pilot_eligible": False,
        "reason": "dormant_installation_configuration_only",
        "missing_required_proofs": [
            "real_schema_and_data_staging_scenarios",
            "internal_fcm_delivery_and_open",
            "internal_email_delivery_and_unsubscribe",
            "physical_android_permission_deep_link_and_receipts",
            "hetzner_firebase_ga4_reconciliation",
            "authorized_ten_percent_pilot",
            "mature_j7_and_j14_outcomes",
        ],
    },
}

serialized = json.dumps(artifact, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
fd, temporary = tempfile.mkstemp(
    prefix=".behavioral-lifecycle-dormant-", suffix=".tmp", dir=output.parent
)
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(serialized)
        handle.flush()
        os.fsync(handle.fileno())
    os.link(temporary, output)
    os.unlink(temporary)
except Exception:
    try:
        os.close(fd)
    except OSError:
        pass
    try:
        os.unlink(temporary)
    except OSError:
        pass
    raise

print(f"BEHAVIORAL_LIFECYCLE_DORMANT_EVIDENCE={output}")
print(
    "BEHAVIORAL_LIFECYCLE_DORMANT_EVIDENCE_SHA256="
    + hashlib.sha256(serialized.encode("utf-8")).hexdigest()
)
print("BEHAVIORAL_LIFECYCLE_PILOT_ELIGIBLE=false")
PY

[[ -f "$FINAL_PATH" ]] || fail 'the evidence artifact was not created'
[[ "$(stat -c '%a' -- "$FINAL_PATH")" == '600' ]] \
  || fail 'the evidence artifact is not mode 600'
