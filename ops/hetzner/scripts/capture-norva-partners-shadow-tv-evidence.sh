#!/usr/bin/env bash
# Capture sanitized, read-only production evidence for the Partners shadow
# reconciler and the TV relay security gate. The shadow artifact deliberately
# remains ineligible until at least one real financial fact has been observed.

set -Eeuo pipefail
set +x
umask 077

REPOSITORY_ROOT="${NORVA_REPOSITORY_ROOT:-/home/adrien/norva}"
OUTPUT_DIR="${PARTNERS_EVIDENCE_OUTPUT_DIR:-}"
DEPLOYMENT_ID="${PARTNERS_DEPLOYMENT_ID:-}"
EXPECTED_COMMIT_SHA="${PARTNERS_EXPECTED_COMMIT_SHA:-}"
TV_TEST_PROOF_SHA256="${PARTNERS_TV_TEST_PROOF_SHA256:-}"
TV_TEST_PROOF_URL="${PARTNERS_TV_TEST_PROOF_URL:-}"
TV_TEST_PROOF_COMMIT_SHA="${PARTNERS_TV_TEST_PROOF_COMMIT_SHA:-}"
DB_CONTAINER="${NORVA_DB_CONTAINER:-norva-db}"
EDGE_CONTAINERS=(norva-edge-functions norva-edge-functions-2)

fail() {
  printf 'Partners shadow/TV evidence capture failed: %s\n' "$1" >&2
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
if [[ -n "$EXPECTED_COMMIT_SHA" ]]; then
  [[ "$EXPECTED_COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]] \
    || fail 'PARTNERS_EXPECTED_COMMIT_SHA must be a lowercase 40-character SHA'
fi

OUTPUT_REAL="$(readlink -f -- "$OUTPUT_DIR")"
REPOSITORY_REAL="$(readlink -f -- "$REPOSITORY_ROOT")"
[[ -n "$OUTPUT_REAL" && -n "$REPOSITORY_REAL" ]] \
  || fail 'unable to resolve evidence or repository path'
case "$OUTPUT_REAL/" in
  "$REPOSITORY_REAL/"*) fail 'evidence must be written outside the Git checkout' ;;
esac
[[ "$(stat -c '%a' -- "$OUTPUT_REAL")" == '700' ]] \
  || fail 'the evidence output directory must have mode 700'

COMMIT_SHA="$(git -C "$REPOSITORY_REAL" rev-parse --verify HEAD)"
[[ "$COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]] || fail 'invalid repository commit SHA'
if [[ -n "$EXPECTED_COMMIT_SHA" && "$COMMIT_SHA" != "$EXPECTED_COMMIT_SHA" ]]; then
  fail 'the server checkout differs from the expected release commit'
fi

for container in "$DB_CONTAINER" "${EDGE_CONTAINERS[@]}"; do
  docker inspect "$container" >/dev/null 2>&1 \
    || fail "missing production container: $container"
done

RELEVANT_STATUS="$(git -C "$REPOSITORY_REAL" status --porcelain \
  --untracked-files=no -- \
  public/js/app.js \
  public/js/cloudApi.js \
  public/js/pages/PartnersPage.js \
  supabase/functions/_shared/partners-tv-relay.ts \
  supabase/functions/norva-partners \
  supabase/functions/norva-partners-device \
  supabase/functions/norva-partners-worker \
  supabase/migrations \
  tests/android-phone-partners-contract.test.js \
  tests/norva-partners-tv-contract.test.js \
  tests/norva-partners-web-contract.test.js)"
[[ -z "$RELEVANT_STATUS" ]] \
  || fail 'the deployed Partners evidence surface has tracked modifications'

WORK="$(mktemp -d "$OUTPUT_REAL/.shadow-tv-evidence.XXXXXX")"
chmod 700 "$WORK"
cleanup() {
  rm -rf -- "$WORK"
}
trap cleanup EXIT

docker exec -i "$DB_CONTAINER" psql -X -v ON_ERROR_STOP=1 \
  -U postgres -d postgres -At > "$WORK/database.json" <<'SQL'
begin transaction read only;
select jsonb_build_object(
  'captured_at', clock_timestamp(),
  'shadow', jsonb_build_object(
    'total_runs', (select count(*) from affiliate_private.affiliate_shadow_reconciliation_runs),
    'clean_runs', (select count(*) from affiliate_private.affiliate_shadow_reconciliation_runs where status = 'clean'),
    'non_clean_runs', (select count(*) from affiliate_private.affiliate_shadow_reconciliation_runs where status <> 'clean'),
    'total_mismatches', (select coalesce(sum(mismatch_count), 0) from affiliate_private.affiliate_shadow_reconciliation_runs),
    'last_48h_runs', (select count(*) from affiliate_private.affiliate_shadow_reconciliation_runs where created_at >= clock_timestamp() - interval '48 hours'),
    'last_48h_runs_with_facts', (select count(*) from affiliate_private.affiliate_shadow_reconciliation_runs where created_at >= clock_timestamp() - interval '48 hours' and facts_count > 0),
    'last_48h_facts', (select coalesce(sum(facts_count), 0) from affiliate_private.affiliate_shadow_reconciliation_runs where created_at >= clock_timestamp() - interval '48 hours'),
    'last_48h_ledger_entries', (select coalesce(sum(ledger_entries_count), 0) from affiliate_private.affiliate_shadow_reconciliation_runs where created_at >= clock_timestamp() - interval '48 hours'),
    'last_48h_mismatches', (select coalesce(sum(mismatch_count), 0) from affiliate_private.affiliate_shadow_reconciliation_runs where created_at >= clock_timestamp() - interval '48 hours'),
    'latest', (
      select jsonb_build_object(
        'status', run.status,
        'facts_count', run.facts_count,
        'ledger_entries_count', run.ledger_entries_count,
        'mismatch_count', run.mismatch_count,
        'window_start', run.window_start,
        'window_end', run.window_end,
        'created_at', run.created_at
      )
      from affiliate_private.affiliate_shadow_reconciliation_runs run
      order by run.created_at desc
      limit 1
    )
  ),
  'reconciliation_heartbeat', (
    select jsonb_build_object(
      'status', heartbeat.status,
      'last_seen_at', heartbeat.last_seen_at,
      'updated_at', heartbeat.updated_at,
      'fresh', heartbeat.last_seen_at >= clock_timestamp() - interval '10 minutes'
    )
    from affiliate_private.affiliate_worker_heartbeats heartbeat
    where heartbeat.worker_name = 'reconciliation'
  ),
  'tv_relay', jsonb_build_object(
    'total_sessions', (select count(*) from affiliate_private.affiliate_tv_relay_sessions),
    'pending_unexpired', (select count(*) from affiliate_private.affiliate_tv_relay_sessions where status = 'pending' and expires_at > clock_timestamp()),
    'expired_pending', (select count(*) from affiliate_private.affiliate_tv_relay_sessions where status = 'pending' and expires_at <= clock_timestamp()),
    'consumed', (select count(*) from affiliate_private.affiliate_tv_relay_sessions where status = 'consumed'),
    'other_terminal', (select count(*) from affiliate_private.affiliate_tv_relay_sessions where status in ('expired', 'revoked'))
  ),
  'tv_relay_flag_enabled', (
    select enabled from public.admin_feature_flags where key = 'partners_tv_relay_enabled'
  )
);
rollback;
SQL

sed -i '/^BEGIN$/d; /^ROLLBACK$/d' "$WORK/database.json"
python3 - "$WORK/database.json" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
value = json.loads(path.read_text(encoding="utf-8"))
if not isinstance(value, dict) or not isinstance(value.get("shadow"), dict):
    raise SystemExit("invalid sanitized database evidence")
PY

TV_TEST_SOURCE=runtime
if command -v node >/dev/null 2>&1; then
  set +e
  node --test \
    "$REPOSITORY_REAL/tests/norva-partners-tv-contract.test.js" \
    "$REPOSITORY_REAL/tests/android-phone-partners-contract.test.js" \
    "$REPOSITORY_REAL/tests/norva-partners-web-contract.test.js" \
    > "$WORK/tv-tests.log" 2>&1
  TV_TEST_EXIT=$?
  set -e
  [[ "$TV_TEST_EXIT" -eq 0 ]] || fail 'TV relay contract tests failed'
  TV_TEST_PROOF_SHA256="$(sha256sum "$WORK/tv-tests.log" | awk '{print $1}')"
  TV_TEST_PROOF_URL="server-local:$DEPLOYMENT_ID"
  TV_TEST_PROOF_COMMIT_SHA="$COMMIT_SHA"
else
  TV_TEST_SOURCE=protected_ci
  [[ "$TV_TEST_PROOF_SHA256" =~ ^[0-9a-f]{64}$ ]] \
    || fail 'PARTNERS_TV_TEST_PROOF_SHA256 is required when Node.js is absent'
  [[ "$TV_TEST_PROOF_URL" =~ ^https://github\.com/Admin-Adher/Norva/actions/runs/[0-9]+$ ]] \
    || fail 'PARTNERS_TV_TEST_PROOF_URL must be the protected GitHub Actions run'
  [[ "$TV_TEST_PROOF_COMMIT_SHA" == "$COMMIT_SHA" ]] \
    || fail 'the TV test proof is not bound to the deployed commit'
  : > "$WORK/tv-tests.log"
fi

export NORVA_PARTNERS_EVIDENCE_DATABASE="$WORK/database.json"
export NORVA_PARTNERS_EVIDENCE_TV_TEST_LOG="$WORK/tv-tests.log"
export NORVA_PARTNERS_EVIDENCE_OUTPUT_DIR="$OUTPUT_REAL"
export NORVA_PARTNERS_EVIDENCE_DEPLOYMENT_ID="$DEPLOYMENT_ID"
export NORVA_PARTNERS_EVIDENCE_COMMIT_SHA="$COMMIT_SHA"
export NORVA_PARTNERS_EVIDENCE_TV_TEST_SOURCE="$TV_TEST_SOURCE"
export NORVA_PARTNERS_EVIDENCE_TV_TEST_PROOF_SHA256="$TV_TEST_PROOF_SHA256"
export NORVA_PARTNERS_EVIDENCE_TV_TEST_PROOF_URL="$TV_TEST_PROOF_URL"
export NORVA_PARTNERS_EVIDENCE_TV_TEST_PROOF_COMMIT_SHA="$TV_TEST_PROOF_COMMIT_SHA"

python3 - <<'PY'
import datetime
import hashlib
import json
import os
import pathlib
import re
import subprocess
import tempfile

database_path = pathlib.Path(os.environ["NORVA_PARTNERS_EVIDENCE_DATABASE"])
test_log_path = pathlib.Path(os.environ["NORVA_PARTNERS_EVIDENCE_TV_TEST_LOG"])
output_dir = pathlib.Path(os.environ["NORVA_PARTNERS_EVIDENCE_OUTPUT_DIR"])
deployment_id = os.environ["NORVA_PARTNERS_EVIDENCE_DEPLOYMENT_ID"]
commit_sha = os.environ["NORVA_PARTNERS_EVIDENCE_COMMIT_SHA"]
tv_test_source = os.environ["NORVA_PARTNERS_EVIDENCE_TV_TEST_SOURCE"]
tv_test_sha = os.environ["NORVA_PARTNERS_EVIDENCE_TV_TEST_PROOF_SHA256"]
tv_test_url = os.environ["NORVA_PARTNERS_EVIDENCE_TV_TEST_PROOF_URL"]
tv_test_commit = os.environ["NORVA_PARTNERS_EVIDENCE_TV_TEST_PROOF_COMMIT_SHA"]
containers = ("norva-edge-functions", "norva-edge-functions-2")


def fail(message):
    raise SystemExit(f"Partners shadow/TV evidence capture failed: {message}")


def inspect_container(name):
    raw = subprocess.check_output(["docker", "inspect", name], text=True, stderr=subprocess.DEVNULL)
    inspected = json.loads(raw)[0]
    env = {}
    for item in inspected.get("Config", {}).get("Env", []):
        if "=" in item:
            key, value = item.split("=", 1)
            env[key] = value
    state = inspected.get("State", {})
    return {
        "env": env,
        "public": {
            "name": name,
            "running": state.get("Running") is True,
            "health": state.get("Health", {}).get("Status", "none"),
            "started_at": state.get("StartedAt"),
        },
    }


def write_artifact(prefix, artifact):
    serialized = json.dumps(artifact, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    destination = output_dir / f"{prefix}-{stamp}-{commit_sha[:12]}.json"
    if destination.exists():
        fail(f"refusing to overwrite {destination.name}")
    fd, temporary = tempfile.mkstemp(prefix=f".{prefix}-", suffix=".tmp", dir=output_dir)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(serialized)
            handle.flush()
            os.fsync(handle.fileno())
        os.link(temporary, destination)
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
    return destination, hashlib.sha256(serialized.encode("utf-8")).hexdigest()


database = json.loads(database_path.read_text(encoding="utf-8"))
captured_at = database.get("captured_at")
shadow = database.get("shadow") or {}
heartbeat = database.get("reconciliation_heartbeat") or {}
tv_relay = database.get("tv_relay") or {}
replicas = [inspect_container(name) for name in containers]

if any(not replica["public"]["running"] for replica in replicas):
    fail("an Edge replica is not running")
if any(replica["public"]["health"] != "healthy" for replica in replicas):
    fail("an Edge replica is not healthy")

primary = replicas[0]["env"]
required = (
    "NORVA_PARTNERS_TV_RELAY_SECRET",
    "NORVA_PARTNERS_TV_RELAY_HANDOFF_URL",
    "NORVA_PARTNERS_TV_RELAY_TTL_SECONDS",
)
for key in required:
    if not primary.get(key):
        fail(f"missing runtime variable {key}")
    if replicas[1]["env"].get(key) != primary[key]:
        fail(f"Edge replicas differ for {key}")

secret = primary["NORVA_PARTNERS_TV_RELAY_SECRET"]
handoff = primary["NORVA_PARTNERS_TV_RELAY_HANDOFF_URL"]
ttl = primary["NORVA_PARTNERS_TV_RELAY_TTL_SECONDS"]
if not 32 <= len(secret) <= 512 or re.search(r"[\x00-\x1f\x7f]", secret):
    fail("the TV relay secret has an invalid shape")
if handoff != "https://norva.tv/app.html" or ttl != "300":
    fail("the TV relay landing or TTL differs from the approved contract")

if tv_test_commit != commit_sha or not re.fullmatch(r"[0-9a-f]{64}", tv_test_sha):
    fail("the TV test proof is not bound to the deployed commit")
if tv_test_source == "runtime":
    if hashlib.sha256(test_log_path.read_bytes()).hexdigest() != tv_test_sha:
        fail("the runtime TV test output hash changed")
elif tv_test_source == "protected_ci":
    if not re.fullmatch(r"https://github\.com/Admin-Adher/Norva/actions/runs/[0-9]+", tv_test_url):
        fail("the protected CI proof URL is invalid")
else:
    fail("the TV test proof source is invalid")
base = {
    "schema_version": 1,
    "captured_at": captured_at,
    "repository": "Admin-Adher/Norva",
    "candidate_commit_sha": commit_sha,
    "server_checkout_sha": commit_sha,
    "deployment_id": deployment_id,
    "target_environment": "production",
    "contains_personal_data": False,
    "contains_secrets": False,
}

shadow_ready = all((
    int(shadow.get("total_runs", 0)) > 0,
    int(shadow.get("non_clean_runs", 0)) == 0,
    int(shadow.get("total_mismatches", 0)) == 0,
    int(shadow.get("last_48h_runs", 0)) > 0,
    int(shadow.get("last_48h_runs_with_facts", 0)) > 0,
    int(shadow.get("last_48h_facts", 0)) > 0,
    heartbeat.get("status") == "healthy",
    heartbeat.get("fresh") is True,
    (shadow.get("latest") or {}).get("status") == "clean",
))
shadow_missing = []
if int(shadow.get("last_48h_runs_with_facts", 0)) == 0:
    shadow_missing.append("real_financial_fact_observed_in_shadow_window")
if int(shadow.get("last_48h_mismatches", 0)) != 0:
    shadow_missing.append("zero_shadow_mismatches")
if heartbeat.get("status") != "healthy" or heartbeat.get("fresh") is not True:
    shadow_missing.append("fresh_healthy_reconciliation_heartbeat")

shadow_artifact = {
    **base,
    "artifact_type": "norva_partners_shadow_reconciliation_report",
    "evidence_scope": "production_shadow_reconciliation",
    "reconciliation": shadow,
    "worker_heartbeat": heartbeat,
    "release_assertion": {
        "gate_key": "shadow_reconciliation_clean",
        "gate_eligible": shadow_ready,
        "reason": "covered_real_facts_without_mismatch" if shadow_ready else "insufficient_real_economic_coverage",
        "missing_required_proofs": shadow_missing,
    },
}

tv_ready = all((
    database.get("tv_relay_flag_enabled") is False,
    int(tv_relay.get("pending_unexpired", -1)) == 0,
    int(tv_relay.get("expired_pending", -1)) == 0,
    handoff == "https://norva.tv/app.html",
    ttl == "300",
))
tv_artifact = {
    **base,
    "artifact_type": "norva_partners_tv_relay_security_review",
    "evidence_scope": "production_tv_relay_security",
    "runtime": {
        "edge_replicas": [replica["public"] for replica in replicas],
        "configuration_parity": True,
        "secret_present": True,
        "secret_length": len(secret),
        "secret_value_recorded": False,
        "handoff_url": handoff,
        "ttl_seconds": int(ttl),
        "feature_flag_enabled_during_review": database.get("tv_relay_flag_enabled"),
    },
    "sessions": tv_relay,
    "contract_tests": {
        "passed": True,
        "command": "node --test tests/norva-partners-tv-contract.test.js tests/android-phone-partners-contract.test.js tests/norva-partners-web-contract.test.js",
        "source": tv_test_source,
        "proof_url": tv_test_url,
        "proof_commit_sha": tv_test_commit,
        "output_sha256": tv_test_sha,
        "raw_output_embedded": False,
    },
    "release_assertion": {
        "gate_key": "tv_relay_security_verified",
        "gate_eligible": tv_ready,
        "reason": "fail_closed_runtime_and_contract_tests_verified" if tv_ready else "tv_relay_runtime_precondition_failed",
        "missing_required_proofs": [] if tv_ready else ["fail_closed_tv_relay_runtime"],
    },
}

shadow_path, shadow_sha = write_artifact("partners-shadow-reconciliation", shadow_artifact)
tv_path, tv_sha = write_artifact("partners-tv-relay-security", tv_artifact)
print(f"PARTNERS_SHADOW_ARTIFACT={shadow_path}")
print(f"PARTNERS_SHADOW_SHA256={shadow_sha}")
print(f"PARTNERS_SHADOW_GATE_ELIGIBLE={str(shadow_ready).lower()}")
print(f"PARTNERS_TV_RELAY_ARTIFACT={tv_path}")
print(f"PARTNERS_TV_RELAY_SHA256={tv_sha}")
print(f"PARTNERS_TV_RELAY_GATE_ELIGIBLE={str(tv_ready).lower()}")
PY

for artifact in \
  "$OUTPUT_REAL"/partners-shadow-reconciliation-*-${COMMIT_SHA:0:12}.json \
  "$OUTPUT_REAL"/partners-tv-relay-security-*-${COMMIT_SHA:0:12}.json; do
  [[ -f "$artifact" ]] || fail 'an expected evidence artifact is missing'
  [[ "$(stat -c '%a' -- "$artifact")" == '600' ]] \
    || fail 'an evidence artifact is not mode 600'
done
