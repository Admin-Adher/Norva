#!/usr/bin/env bash
# Capture a sanitized, read-only snapshot of the live Didit configuration.
#
# This artifact proves configuration shape only. It deliberately cannot satisfy
# the individual verification release gate without the three independent
# sandbox, live-decision and isolation/quarantine proofs.

set -Eeuo pipefail
set +x
umask 077

REPOSITORY_ROOT="${NORVA_REPOSITORY_ROOT:-/home/adrien/norva}"
OUTPUT_DIR="${PARTNERS_EVIDENCE_OUTPUT_DIR:-}"
DEPLOYMENT_ID="${PARTNERS_DEPLOYMENT_ID:-}"
EDGE_CONTAINERS=(norva-edge-functions norva-edge-functions-2)

fail() {
  printf 'Didit evidence capture failed: %s\n' "$1" >&2
  exit 1
}

[[ -n "$OUTPUT_DIR" ]] || fail 'PARTNERS_EVIDENCE_OUTPUT_DIR is required'
[[ "$OUTPUT_DIR" == /* ]] || fail 'the evidence output directory must be absolute'
[[ -d "$OUTPUT_DIR" ]] || fail 'the evidence output directory must already exist'
[[ -n "$DEPLOYMENT_ID" ]] || fail 'PARTNERS_DEPLOYMENT_ID is required'
[[ "$DEPLOYMENT_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$ ]] \
  || fail 'PARTNERS_DEPLOYMENT_ID has an invalid shape'
[[ "$DEPLOYMENT_ID" != *'..'* && "$DEPLOYMENT_ID" != *'//'* ]] \
  || fail 'PARTNERS_DEPLOYMENT_ID contains a forbidden traversal marker'

OUTPUT_REAL="$(readlink -f -- "$OUTPUT_DIR")"
REPOSITORY_REAL="$(readlink -f -- "$REPOSITORY_ROOT")"
[[ -n "$OUTPUT_REAL" && -n "$REPOSITORY_REAL" ]] \
  || fail 'unable to resolve evidence or repository path'
case "$OUTPUT_REAL/" in
  "$REPOSITORY_REAL/"*) fail 'evidence must be written outside the Git checkout' ;;
esac

OUTPUT_MODE="$(stat -c '%a' -- "$OUTPUT_REAL")"
[[ "$OUTPUT_MODE" == '700' ]] \
  || fail 'the evidence output directory must have mode 700'

for container in "${EDGE_CONTAINERS[@]}"; do
  docker inspect "$container" >/dev/null 2>&1 \
    || fail "missing Edge container: $container"
done

COMMIT_SHA="$(git -C "$REPOSITORY_REAL" rev-parse --verify HEAD)"
[[ "$COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]] || fail 'invalid repository commit SHA'
CAPTURE_STAMP="$(date -u +'%Y%m%dT%H%M%SZ')"
FINAL_PATH="$OUTPUT_REAL/didit-live-config-${CAPTURE_STAMP}-${COMMIT_SHA:0:12}.json"
[[ ! -e "$FINAL_PATH" ]] || fail 'refusing to overwrite an existing artifact'

export NORVA_DIDIT_EVIDENCE_REPOSITORY_ROOT="$REPOSITORY_REAL"
export NORVA_DIDIT_EVIDENCE_OUTPUT_PATH="$FINAL_PATH"
export NORVA_DIDIT_EVIDENCE_DEPLOYMENT_ID="$DEPLOYMENT_ID"
export NORVA_DIDIT_EVIDENCE_COMMIT_SHA="$COMMIT_SHA"

python3 - <<'PY'
import datetime
import hashlib
import json
import os
import pathlib
import re
import subprocess
import tempfile
import urllib.error
import urllib.request

OUTPUT_PATH = pathlib.Path(os.environ["NORVA_DIDIT_EVIDENCE_OUTPUT_PATH"])
DEPLOYMENT_ID = os.environ["NORVA_DIDIT_EVIDENCE_DEPLOYMENT_ID"]
COMMIT_SHA = os.environ["NORVA_DIDIT_EVIDENCE_COMMIT_SHA"]
REPOSITORY_ROOT = pathlib.Path(os.environ["NORVA_DIDIT_EVIDENCE_REPOSITORY_ROOT"])
CONTAINERS = ("norva-edge-functions", "norva-edge-functions-2")
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-"
    r"[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
NODE_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
MAX_WORKFLOW_RESPONSE_BYTES = 2 * 1024 * 1024


def fail(message):
    raise SystemExit(f"Didit evidence capture failed: {message}")


def sha256_text(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def canonical_json(value):
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        return None


def inspect_container(name):
    raw = subprocess.check_output(
        ["docker", "inspect", name],
        text=True,
        stderr=subprocess.DEVNULL,
    )
    inspected = json.loads(raw)[0]
    env = {}
    for item in inspected.get("Config", {}).get("Env", []):
        if "=" in item:
            key, value = item.split("=", 1)
            env[key] = value
    state = inspected.get("State", {})
    health = state.get("Health", {}).get("Status", "none")
    image = str(inspected.get("Image", ""))
    image_sha = image.removeprefix("sha256:")
    if not re.fullmatch(r"[0-9a-f]{64}", image_sha):
        fail(f"{name} has no immutable image content id")
    started_at = state.get("StartedAt")
    if not isinstance(started_at, str) or not started_at:
        fail(f"{name} has no start timestamp")
    return {
        "env": env,
        "public": {
            "name": name,
            "running": state.get("Running") is True,
            "health": health,
            "image_id_sha256": image_sha,
            "started_at": started_at,
        },
    }


replicas = [inspect_container(name) for name in CONTAINERS]
if any(not item["public"]["running"] for item in replicas):
    fail("an Edge replica is not running")
if any(item["public"]["health"] != "healthy" for item in replicas):
    fail("an Edge replica is not healthy")

required_keys = (
    "DIDIT_API_KEY",
    "DIDIT_WORKFLOW_ID",
    "DIDIT_APPLICATION_ID",
    "DIDIT_ENVIRONMENT",
    "DIDIT_SESSION_EXPIRATION_SECONDS",
    "DIDIT_WEBHOOK_SECRET",
    "DIDIT_CALLBACK_URL",
    "DIDIT_ID_VERIFICATION_NODE_ID",
    "DIDIT_LIVENESS_NODE_ID",
    "DIDIT_FACE_MATCH_NODE_ID",
)
primary = replicas[0]["env"]
for key in required_keys:
    if not primary.get(key):
        fail(f"missing runtime variable {key}")
    if replicas[1]["env"].get(key) != primary[key]:
        fail(f"Edge replicas differ for {key}")

if primary["DIDIT_ENVIRONMENT"] != "live":
    fail("the runtime Didit environment is not live")
if primary["DIDIT_CALLBACK_URL"] != "https://norva.tv/partners-kyc-return":
    fail("the runtime callback is not canonical")
if primary["DIDIT_SESSION_EXPIRATION_SECONDS"] != "604800":
    fail("the runtime session expiration is not the approved seven-day value")
if not UUID_RE.fullmatch(primary["DIDIT_WORKFLOW_ID"]):
    fail("the runtime workflow id is invalid")
if not UUID_RE.fullmatch(primary["DIDIT_APPLICATION_ID"]):
    fail("the runtime application id is invalid")
node_ids = [
    primary["DIDIT_ID_VERIFICATION_NODE_ID"],
    primary["DIDIT_LIVENESS_NODE_ID"],
    primary["DIDIT_FACE_MATCH_NODE_ID"],
]
if any(not NODE_RE.fullmatch(value) for value in node_ids):
    fail("a runtime decision node id is invalid")
if len(set(node_ids)) != 3:
    fail("runtime decision node ids are not distinct")

workflow_id = primary["DIDIT_WORKFLOW_ID"].lower()
request = urllib.request.Request(
    f"https://verification.didit.me/v3/workflows/{workflow_id}/",
    headers={"x-api-key": primary["DIDIT_API_KEY"]},
    method="GET",
)
try:
    with urllib.request.build_opener(NoRedirect).open(request, timeout=15) as response:
        http_status = response.status
        raw_workflow = response.read(MAX_WORKFLOW_RESPONSE_BYTES + 1)
        if len(raw_workflow) > MAX_WORKFLOW_RESPONSE_BYTES:
            fail("Didit management API response exceeds the size limit")
        workflow = json.loads(raw_workflow.decode("utf-8", errors="strict"))
except urllib.error.HTTPError as error:
    fail(f"Didit management API returned HTTP {error.code}")
except Exception as error:
    fail(f"Didit management API unavailable: {type(error).__name__}")

if http_status != 200 or not isinstance(workflow, dict):
    fail("Didit management API response is invalid")
if str(workflow.get("uuid", "")).lower() != workflow_id:
    fail("Didit management workflow does not match the runtime workflow")
workflow_version = workflow.get("version")
if (
    not isinstance(workflow_version, int)
    or isinstance(workflow_version, bool)
    or workflow_version < 1
    or workflow_version > 1_000_000
):
    fail("Didit workflow version is invalid")
if workflow.get("workflow_type") != "kyc":
    fail("Didit workflow is not KYC")
if workflow.get("status") != "published" or workflow.get("is_archived") is not False:
    fail("Didit workflow is not an active published version")
if workflow.get("callback_url") != primary["DIDIT_CALLBACK_URL"]:
    fail("Didit callback differs from runtime")
if workflow.get("session_expiration_time") != int(
    primary["DIDIT_SESSION_EXPIRATION_SECONDS"]
):
    fail("Didit session expiration differs from runtime")
if workflow.get("is_kyb_enabled") is not False:
    fail("Didit KYB must be disabled")
if workflow.get("is_aml_enabled") is not False:
    fail("Didit AML must be disabled for the initial individual programme")
if workflow.get("is_aml_ongoing_monitoring_enabled") is not False:
    fail("Didit ongoing AML must be disabled")

raw_features = workflow.get("features")
if not isinstance(raw_features, str):
    fail("Didit workflow features are unavailable")
features = sorted(
    part.strip().upper()
    for part in raw_features.split("+")
    if part.strip()
)
required_features = {"OCR", "LIVENESS", "FACE_MATCH", "IP_ANALYSIS"}
if not required_features.issubset(features) or any("KYB" in item for item in features):
    fail("Didit workflow feature coverage is incomplete or contains KYB")

binding = "\n".join(
    [
        "norva:didit:config:v1",
        "sessions_api_url=https://verification.didit.me/v3/session/",
        "webhook_contract=status.updated:v1",
        f"environment={primary['DIDIT_ENVIRONMENT']}",
        f"application_id={primary['DIDIT_APPLICATION_ID'].lower()}",
        f"workflow_id={workflow_id}",
        f"workflow_version={workflow_version}",
        f"callback_url={primary['DIDIT_CALLBACK_URL']}",
        f"id_verification_node_id={node_ids[0]}",
        f"liveness_node_id={node_ids[1]}",
        f"face_match_node_id={node_ids[2]}",
        f"session_expiration_seconds={primary['DIDIT_SESSION_EXPIRATION_SECONDS']}",
    ]
)

status_output = subprocess.check_output(
    [
        "git",
        "-C",
        str(REPOSITORY_ROOT),
        "status",
        "--porcelain",
        "--untracked-files=no",
    ],
    text=True,
)
captured_at = datetime.datetime.now(datetime.timezone.utc).replace(
    microsecond=0
).isoformat().replace("+00:00", "Z")

artifact = {
    "schema_version": 1,
    "artifact_type": "norva_partners_didit_live_config_snapshot",
    "evidence_scope": "configuration_only",
    "captured_at": captured_at,
    "repository": "Admin-Adher/Norva",
    "candidate_commit_sha": COMMIT_SHA,
    "server_checkout_sha": COMMIT_SHA,
    "deployment_id": DEPLOYMENT_ID,
    "target_environment": "production",
    "contains_personal_data": False,
    "contains_secrets": False,
    "provider": {
        "name": "didit",
        "environment": "live",
        "workflow_type": workflow["workflow_type"],
        "workflow_status": workflow["status"],
        "workflow_version": workflow_version,
        "workflow_published_at": workflow.get("published_at"),
        "workflow_archived": workflow["is_archived"],
        "features": features,
        "kyb_enabled": workflow["is_kyb_enabled"],
        "aml_enabled": workflow["is_aml_enabled"],
        "aml_ongoing_monitoring_enabled": workflow[
            "is_aml_ongoing_monitoring_enabled"
        ],
        "callback_url": primary["DIDIT_CALLBACK_URL"],
        "session_expiration_seconds": int(
            primary["DIDIT_SESSION_EXPIRATION_SECONDS"]
        ),
        "config_fingerprint_sha256": sha256_text(binding),
        "workflow_config_sha256": sha256_text(canonical_json(workflow)),
        "workflow_id_sha256": sha256_text(
            "norva:didit:workflow:v1:" + workflow_id
        ),
        "application_id_sha256": sha256_text(
            "norva:didit:application:v1:"
            + primary["DIDIT_APPLICATION_ID"].lower()
        ),
    },
    "runtime": {
        "edge_replicas": [item["public"] for item in replicas],
        "replica_count": len(replicas),
        "configuration_parity": True,
        "workflow_matches_management_api": True,
        "callback_matches_management_api": True,
        "session_expiration_matches_management_api": True,
        "node_ids_distinct": True,
        "management_api_http_status": http_status,
        "tracked_worktree_clean": status_output == "",
        "tracked_worktree_change_count": len(
            [line for line in status_output.splitlines() if line]
        ),
    },
    "release_assertion": {
        "gate_eligible": False,
        "reason": "configuration_snapshot_only",
        "missing_required_proofs": [
            "sandbox_non_authoritative_session",
            "live_signed_decision",
            "environment_and_fingerprint_quarantine",
        ],
    },
}

serialized = json.dumps(
    artifact,
    ensure_ascii=False,
    indent=2,
    sort_keys=True,
) + "\n"
fd, temporary_name = tempfile.mkstemp(
    prefix=".didit-live-config-",
    suffix=".tmp",
    dir=OUTPUT_PATH.parent,
)
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(serialized)
        handle.flush()
        os.fsync(handle.fileno())
    os.link(temporary_name, OUTPUT_PATH)
    os.unlink(temporary_name)
except Exception:
    try:
        os.close(fd)
    except OSError:
        pass
    try:
        os.unlink(temporary_name)
    except OSError:
        pass
    raise

artifact_sha = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
print(f"DIDIT_LIVE_CONFIG_ARTIFACT={OUTPUT_PATH}")
print(f"DIDIT_LIVE_CONFIG_SHA256={artifact_sha}")
print(
    "DIDIT_CONFIG_FINGERPRINT_SHA256="
    + artifact["provider"]["config_fingerprint_sha256"]
)
print(f"DIDIT_WORKFLOW_VERSION={workflow_version}")
print("DIDIT_RELEASE_GATE_ELIGIBLE=false")
PY

[[ -f "$FINAL_PATH" ]] || fail 'the evidence artifact was not created'
[[ "$(stat -c '%a' -- "$FINAL_PATH")" == '600' ]] \
  || fail 'the evidence artifact is not mode 600'
