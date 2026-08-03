#!/usr/bin/env bash
# =============================================================================
# 05-verify-parity.sh — prove the self-host DB matches the managed one
# =============================================================================
# Compares managed (source) vs self-host (target) on the things that silently
# break a migration: row counts, extensions, cron jobs, RLS policies, role GUCs,
# and the couche-B dual-write flag. Run BEFORE cutting DNS over.
#
#   MANAGED_DB_URL and the local TARGET both come from ops/hetzner/.env, or pass:
#     SRC="postgresql://...managed..." DST="postgresql://...selfhost..." \
#       scripts/05-verify-parity.sh
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$HERE/.env}"
[[ -f "$ENV_FILE" ]] && { set -a; source "$ENV_FILE"; set +a; }

SRC="${SRC:-${MANAGED_DB_URL:-}}"
DST="${DST:-postgresql://postgres:${POSTGRES_PASSWORD:-}@127.0.0.1:5432/${POSTGRES_DB:-postgres}}"
: "${SRC:?Set SRC or MANAGED_DB_URL (managed connection string)}"

if [[ "${NORVA_PARTNERS_REVOLUT_API_ENABLED:-false}" != "false" ]]; then
  echo "Refusing Basic/manual parity: NORVA_PARTNERS_REVOLUT_API_ENABLED must be false." >&2
  exit 1
fi
if [[ "${NORVA_PARTNERS_DIDIT_CERTIFICATION_ENABLED:-false}" != "false" ]]; then
  echo "Refusing resting-state parity: NORVA_PARTNERS_DIDIT_CERTIFICATION_ENABLED must be false." >&2
  exit 1
fi

q() { psql "$1" -At -c "$2" 2>/dev/null; }

hr() { printf '%.0s-' {1..60}; echo; }

FAILURES=0

verify_edge_runtime_inert_flags() {
  local runtime=""
  local container=""
  local injected=""
  local flag=""
  local inspected=0

  if command -v docker >/dev/null 2>&1; then
    runtime="docker"
  elif command -v podman >/dev/null 2>&1; then
    runtime="podman"
  else
    echo "Edge runtime env: SKIP (no container CLI; DB parity remains available)"
    return 0
  fi
  if ! "$runtime" info >/dev/null 2>&1; then
    echo "Edge runtime env: SKIP ($runtime daemon unavailable)"
    return 0
  fi

  for container in norva-edge-functions norva-edge-functions-2; do
    if ! "$runtime" inspect "$container" >/dev/null 2>&1; then
      continue
    fi
    inspected=$((inspected + 1))
    for flag in \
      NORVA_PARTNERS_REVOLUT_API_ENABLED \
      NORVA_PARTNERS_DIDIT_CERTIFICATION_ENABLED
    do
      injected="$(
        "$runtime" inspect \
          --format '{{range .Config.Env}}{{println .}}{{end}}' \
          "$container" \
          | awk -F= -v wanted="$flag" \
            '$1 == wanted { print substr($0, index($0, "=") + 1) }'
      )"
      if [[ "$injected" == "false" ]]; then
        printf "%-48s %14s\n" "Edge env: $container $flag" "OK"
      else
        printf "%-48s %14s\n" "Edge env: $container $flag" "FAIL"
        echo "  $flag is absent or not false." >&2
        FAILURES=$((FAILURES + 1))
      fi
    done
  done

  if [[ "$inspected" -eq 0 ]]; then
    echo "Edge runtime env: SKIP (Norva Edge containers are not present)"
  fi
}

# The tables whose counts must match exactly after restore.
TABLES=(cloud_media_items cloud_titles cloud_title_variants cloud_sources
         cloud_live_streams catalog_titles catalog_file_tracks
         catalog_provider_identities subtitle_tracks
         cloud_revenuecat_transfer_events)
PRIVATE_TABLES=(affiliate_accounts affiliate_events affiliate_attributions
                affiliate_kyc_sessions affiliate_kyc_webhook_events
                affiliate_financial_facts
                affiliate_revolut_dispute_won_jobs
                affiliate_revolut_dispute_won_conflicts
                affiliate_commission_entries affiliate_payout_cycles
                affiliate_payout_items
                affiliate_worker_heartbeats
                affiliate_revolut_manual_batches
                affiliate_revolut_reference_allocations
                affiliate_revolut_beneficiary_bindings
                affiliate_revolut_beneficiary_binding_tickets
                affiliate_revolut_beneficiary_revocations
                affiliate_revolut_payout_executions
                affiliate_revolut_api_worker_lease
                affiliate_revolut_payout_events
                affiliate_revolut_statement_tickets
                affiliate_revolut_statement_imports
                affiliate_revolut_statement_rows
                affiliate_revolut_manual_reviews
                affiliate_revolut_manual_decisions
                affiliate_revolut_manual_cancellations
                affiliate_revolut_manual_unmapped_requests
                affiliate_revolut_manual_unmapped_releases
                affiliate_revolut_return_observations
                affiliate_revolut_return_reviews
                affiliate_revolut_return_decisions
                affiliate_revolut_late_completion_observations
                affiliate_revolut_late_completion_reviews
                affiliate_revolut_late_completion_decisions
                affiliate_revolut_reconciliation_incidents
                affiliate_revolut_reconciliation_incident_reviews
                affiliate_revolut_transaction_aliases
                affiliate_revolut_reconciliation_incident_decisions)

echo "PARITY CHECK  $(date -u +%FT%TZ)"
hr
printf "%-32s %14s %14s %4s\n" "CHECK" "MANAGED" "SELFHOST" "OK?"
hr

check() { # label, sql
  local label="$1" sql="$2" a b ok
  a="$(q "$SRC" "$sql")"; b="$(q "$DST" "$sql")"
  if [[ "$a" == "$b" ]]; then
    ok="OK"
  else
    ok="FAIL"
    FAILURES=$((FAILURES + 1))
  fi
  printf "%-32s %14s %14s %4s\n" "$label" "${a:-?}" "${b:-?}" "$ok"
}

check_zero() { # label, sql expected to return an invariant-violation count
  local label="$1" sql="$2" a b ok
  a="$(q "$SRC" "$sql")"; b="$(q "$DST" "$sql")"
  if [[ "$a" == "0" && "$b" == "0" ]]; then
    ok="OK"
  else
    ok="FAIL"
    FAILURES=$((FAILURES + 1))
  fi
  printf "%-32s %14s %14s %4s\n" "$label" "${a:-?}" "${b:-?}" "$ok"
}

verify_edge_runtime_inert_flags

for t in "${TABLES[@]}"; do
  check "rows: $t" "select count(*) from public.$t"
done
for t in "${PRIVATE_TABLES[@]}"; do
  check "private rows: $t" "select count(*) from affiliate_private.$t"
done

hr
check "extensions (count)"        "select count(*) from pg_extension"
check "cron jobs (total)"         "select count(*) from cron.job"
check "cron jobs (active)"        "select count(*) from cron.job where active"
check "RLS policies (public)"     "select count(*) from pg_policies where schemaname='public'"
check "RLS policies (partners)"   "select count(*) from pg_policies where schemaname='affiliate_private'"
check "partners private tables"   "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='affiliate_private' and c.relkind in ('r','p')"
check "partners functions"        "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('affiliate_private','public') and p.proname like '%partners%'"
check "TRANSFER functions"        "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like '%revenuecat%transfer%'"
check "DISPUTE_WON functions"     "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('affiliate_private','public') and p.proname like '%revolut_dispute_won%'"
check "Revolut incident functions" "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('affiliate_private','public') and p.proname like '%revolut_reconciliation_incident%'"
check_zero "Revolut manual route violations" "select count(*) from affiliate_private.affiliate_payout_provider_configs where status='active' and (provider<>'revolut' or execution_adapter<>'revolut_manual')"
check_zero "Revolut API flag enabled" "select count(*) from public.admin_feature_flags where key='partners_revolut_api_enabled' and enabled"
check_zero "Revolut API active routes" "select count(*) from affiliate_private.affiliate_payout_provider_configs where status='active' and execution_adapter='revolut_api'"
check_zero "Revolut API cron scheduled/active" "select count(*) from cron.job where active and jobname='norva-partners-revolut-api'"
check_zero "Legacy payout cron active" "select count(*) from cron.job where active and jobname='norva-partners-payout'"
check_zero "Inactive payout rails active" "select count(*) from cron.job where active and jobname in ('norva-partners-payout','norva-partners-revolut-api')"
check_zero "Revolut payout reference violations" "select count(*) from affiliate_private.affiliate_revolut_payout_executions where payout_reference !~ '^NORVA-[A-F0-9]{12}$'"
check_zero "Revolut payout reference duplicates" "select count(*) from (select payout_reference from affiliate_private.affiliate_revolut_payout_executions group by payout_reference having count(*)>1) duplicate"
check_zero "Payout active route collisions" "select count(*) from (select 1 from affiliate_private.affiliate_payout_provider_configs where status='active' group by country_code,currency having count(*)>1) collision"
check "Didit binding columns"      "select count(*) from information_schema.columns where table_schema='affiliate_private' and table_name in ('affiliate_kyc_sessions','affiliate_kyc_webhook_events') and column_name in ('provider_environment','provider_config_fingerprint')"
check_zero "Didit legacy RPC grants" "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and ((p.proname='partners_service_kyc_session_record' and pg_get_function_identity_arguments(p.oid)='p_user_id uuid, p_idempotency_key text, p_provider_session_id text, p_provider_workflow_id text, p_provider_workflow_version integer, p_provider_status text, p_expires_at timestamp with time zone, p_reservation_key text') or (p.proname='partners_service_kyc_webhook_apply' and pg_get_function_identity_arguments(p.oid)='p_provider_event_id text, p_provider_session_id text, p_provider_workflow_id text, p_provider_workflow_version integer, p_provider_status text, p_event_created_at timestamp with time zone, p_document_age integer, p_document_country_iso3 text, p_id_check_approved boolean, p_liveness_approved boolean, p_face_match_approved boolean, p_payload_hash text')) and has_function_privilege('service_role',p.oid,'EXECUTE')"
check_zero "Didit unbound trust"      "select count(*) from affiliate_private.affiliate_accounts a where a.status<>'closed' and a.verification_provider='didit' and a.verification_status='verified' and not exists (select 1 from affiliate_private.affiliate_kyc_sessions s where s.account_id=a.id and s.provider_session_hash=a.verification_reference and s.provider_environment='live' and s.provider_config_fingerprint~'^[0-9a-f]{64}$' and s.provider_config_fingerprint<>repeat('0',64) and s.status='verified' and exists (select 1 from affiliate_private.affiliate_kyc_webhook_events e where e.session_id=s.id and e.processing_outcome='verified' and e.provider_environment='live' and e.provider_config_fingerprint=s.provider_config_fingerprint and e.provider_event_at=s.verified_at))"
check_zero "Didit legacy pending"      "select count(*) from affiliate_private.affiliate_kyc_sessions s where s.status='pending' and s.provider_environment='legacy_unbound'"
check_zero "Didit recovery RPC grants" "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='partners_service_kyc_binding_recover' and (has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE') or not has_function_privilege('service_role',p.oid,'EXECUTE'))"
check "vault secrets"             "select count(*) from vault.secrets"
check "anon statement_timeout"    "select setting from pg_settings where name='statement_timeout'"  # session-level; role GUC checked below

hr
echo "Role GUCs (should be anon=3s, authenticated=8s on both):"
for role in anon authenticated; do
  echo "  $role:"
  echo "    managed : $(q "$SRC" "select array_to_string(setconfig,'; ') from pg_db_role_setting s join pg_roles r on r.oid=s.setrole where r.rolname='$role'")"
  echo "    selfhost: $(q "$DST" "select array_to_string(setconfig,'; ') from pg_db_role_setting s join pg_roles r on r.oid=s.setrole where r.rolname='$role'")"
done

hr
echo "couche-B dual-write flag (expect '0' = dormant on both):"
echo "    managed : $(q "$SRC" "select current_setting('app.norva_catalog_dual_write', true)")"
echo "    selfhost: $(q "$DST" "select current_setting('app.norva_catalog_dual_write', true)")"

hr
echo "Any FAIL above = investigate before cutover. Row-count drift on cloud_* usually"
echo "means the dump ran while imports were still live — re-freeze and re-dump."

if [[ "$FAILURES" -ne 0 ]]; then
  echo "Parity verification failed with $FAILURES blocking difference(s)." >&2
  exit 1
fi
