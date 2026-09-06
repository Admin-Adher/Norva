$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$taskMigration = 'supabase/migrations/20260906125303_no_source_conditional_email_postal.sql'
$taskFixtures = @(@{ name='owner'; content='create role supabase_admin superuser; set role supabase_admin;' })
$taskFiles = @(
    'tests/sql/behavioral-lifecycle.bootstrap.sql',
    'supabase/migrations/20260903180000_behavioral_lifecycle_engine_v1.sql',
    'supabase/migrations/20260904090000_behavioral_lifecycle_import_readiness_append_only.sql',
    'supabase/migrations/20260904100000_behavioral_lifecycle_admin_overview_digest_schema.sql',
    'supabase/migrations/20260905160000_lifecycle_timezone_provenance.sql',
    'tests/sql/lifecycle-email-postal.bootstrap.sql',
    'ops/hetzner/postal/full-transport-v1/core.sql',
    'POSTAL_PRODUCER_FUNCTIONS',
    $taskMigration,
    'DORMANT_PRODUCT_OBSERVATION',
    'ops/hetzner/tests/behavioral_lifecycle_pre_activation_readiness.sql',
    'tests/sql/lifecycle-email-postal.integration.sql'
)
foreach ($taskFile in $taskFiles) {
    if ($taskFile -eq 'DORMANT_PRODUCT_OBSERVATION') {
        $taskFixtures += @{name=$taskFile;content=@'
set role supabase_admin;
set request.jwt.claim.role='service_role';
insert into auth.users(id,email,created_at) values('60000000-0000-0000-0000-000000000090','dormant-product-observation@example.invalid',clock_timestamp());
select public.norva_record_behavioral_product_event('60000000-0000-0000-0000-000000000090','source_form_opened','web','proof-1','60000000-0000-0000-0000-000000000091');
do $$begin
 if (select count(*) from public.behavioral_lifecycle_funnel_events) <> 1
   or not exists(select 1 from public.behavioral_lifecycle_funnel_events where event_name='source_form_opened' and delivery_id is null and experiment_arm='outside_rollout')
 then raise exception 'actual dormant product observation was not recorded'; end if;
end$$;
'@}
        continue
    }
    if ($taskFile -eq 'POSTAL_PRODUCER_FUNCTIONS') {
        $taskSource = Get-Content -Raw -LiteralPath (Join-Path $taskRoot 'ops/hetzner/postal/full-transport-v1/migration.sql')
        $taskMatches = [regex]::Matches($taskSource,'(?s)CREATE OR REPLACE FUNCTION public\.(?:claim_postal_branded_email_deliveries|fail_postal_branded_email_delivery)\(.*?\r?\n\$function\$\r?\n;\r?\nrevoke.*?;\r?\ngrant.*?;')
        if ($taskMatches.Count -ne 3) { throw 'Postal producer fixture source changed' }
        $taskFixtures += @{name=$taskFile;content="set role supabase_admin;`n"+(($taskMatches | ForEach-Object {$_.Value}) -join "`n")}
        continue
    }
    $taskFixtures += @{name=$taskFile;content="set role supabase_admin;`n"+(Get-Content -Raw -LiteralPath (Join-Path $taskRoot $taskFile))}
}
$taskFixtures += @{name='repeat-refused';content="set role supabase_admin;`n"+(Get-Content -Raw -LiteralPath (Join-Path $taskRoot $taskMigration));expected_error='conditional email requires the reviewed dormant baseline'}
$taskFixtures += @{name='public-call-refused';content='set role anon; select norva_postal_full.behavioral_email_not_before(null,clock_timestamp());';expected_error='permission denied for schema norva_postal_full'}
# Mutations below run ONLY in the disposable, networkless DB. The exact gate
# body is retained; its outer transaction is replaced so each failing fixture
# rolls back its own mutation when psql disconnects. No live guard is relaxed.
$taskGate = (Get-Content -Raw -LiteralPath (Join-Path $taskRoot 'ops/hetzner/tests/behavioral_lifecycle_pre_activation_readiness.sql')).Replace('begin transaction read only;','').Replace('rollback;','')
$taskNegativeCases = @(
    @{name='old-fixed-delay';sql="update public.behavioral_lifecycle_steps set delay_minutes=4320 where journey_key='no_source' and step_key='day_three_email';";error='reviewed step configuration drifted'},
    @{name='early-helper';sql='create or replace function norva_postal_full.behavioral_email_not_before(p_delivery_id uuid,p_now timestamptz) returns timestamptz language sql stable security invoker set search_path=pg_catalog as $$select p_now$$;';error='conditional-email functions missing or drifted'},
    @{name='bypass-final-smtp';sql="create or replace function norva_postal_full.eligibility(p_key text,p_recipient text,p_auth boolean,p_flow text) returns text language plpgsql security definer set search_path=pg_catalog as `$`$begin return 'allow';end`$`$;";error='conditional-email functions missing or drifted'},
    @{name='helper-grant';sql='grant execute on function norva_postal_full.behavioral_email_not_before(uuid,timestamptz) to authenticated;';error='conditional-email private helper exposed'},
    @{name='helper-definer';sql='alter function norva_postal_full.behavioral_pending_window(uuid,timestamptz) security definer;';error='conditional-email functions missing or drifted'},
    @{name='runtime-enabled';sql='update public.behavioral_lifecycle_runtime set emergency_stop=false;';error='runtime is not uniquely stopped in internal_test mode'},
    @{name='message-history';sql="update public.behavioral_lifecycle_funnel_events set event_name='message_queued';";error='pre-activation message or experiment backlog is not empty'},
    @{name='treatment-history';sql="update public.behavioral_lifecycle_funnel_events set experiment_arm='treatment';";error='pre-activation message or experiment backlog is not empty'}
)
foreach ($taskCase in $taskNegativeCases) {
    $taskFixtures += @{name="gate-refuses-$($taskCase.name)";content="set role supabase_admin;`nbegin;`n$($taskCase.sql)`n$taskGate";expected_error=$taskCase.error}
}
$taskFixtures += @{name='gate-still-dormant-after-rejections';content="set role supabase_admin;`n"+(Get-Content -Raw -LiteralPath (Join-Path $taskRoot 'ops/hetzner/tests/behavioral_lifecycle_pre_activation_readiness.sql'))}
$taskFixtures += @{name='final-guard-hashes';content=@'
\pset format unaligned
\pset tuples_only on
select json_object_agg(oid::regprocedure::text,md5(replace(prosrc,chr(13),''))) from pg_proc where oid in (
 'norva_postal_full.behavioral_email_not_before(uuid,timestamptz)'::regprocedure,
 'norva_postal_full.behavioral_pending_window(uuid,timestamptz)'::regprocedure,
 'norva_postal_full.defer_behavioral_pending(uuid,text,uuid,integer,jsonb)'::regprocedure,
 'public.norva_enqueue_behavioral_email(uuid,uuid,text,text,text,text,text,text,jsonb,jsonb)'::regprocedure,
 'public.norva_authorize_behavioral_email_enqueue(uuid,uuid)'::regprocedure,
 'public.authorize_branded_email_delivery(uuid,text,uuid)'::regprocedure,
 'norva_postal_full.eligibility(text,text,boolean,text)'::regprocedure,
 'public.claim_postal_branded_email_deliveries(integer,integer,integer)'::regprocedure,
 'public.fail_postal_branded_email_delivery(uuid,text,uuid,integer,text,jsonb,boolean,integer,integer)'::regprocedure,
 'public.fail_postal_branded_email_delivery(uuid,text,uuid,integer,text,jsonb,boolean,integer,integer,boolean)'::regprocedure);
'@}
$taskPayload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($taskFixtures | ConvertTo-Json -Depth 6 -Compress)))
$taskProgram = "PAYLOAD = '$taskPayload'`n"+(Get-Content -Raw -LiteralPath (Join-Path $taskRoot 'tests/run-conditional-email-postgres-proof.py'))
$taskProgram | & ssh -o BatchMode=yes -o ConnectTimeout=8 adrien@157.180.96.159 'python3 -'
if ($LASTEXITCODE -ne 0) { throw 'Isolated conditional email PostgreSQL proof failed' }
