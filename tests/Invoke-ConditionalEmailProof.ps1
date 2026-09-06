$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$taskMigration = 'supabase/migrations/20260906125303_no_source_conditional_email_postal.sql'
$taskFixtures = @(@{ name='owner'; content='create role supabase_admin superuser; set role supabase_admin;' })
$taskFiles = @(
    'tests/sql/behavioral-lifecycle.bootstrap.sql',
    'supabase/migrations/20260903180000_behavioral_lifecycle_engine_v1.sql',
    'supabase/migrations/20260905160000_lifecycle_timezone_provenance.sql',
    'tests/sql/lifecycle-email-postal.bootstrap.sql',
    'ops/hetzner/postal/full-transport-v1/core.sql',
    'POSTAL_PRODUCER_FUNCTIONS',
    $taskMigration,
    'tests/sql/lifecycle-email-postal.integration.sql'
)
foreach ($taskFile in $taskFiles) {
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
$taskFixtures += @{name='final-guard-hashes';content=@'
select json_object_agg(proname,md5(replace(prosrc,chr(13),''))) from pg_proc where oid in (
 'norva_postal_full.behavioral_email_not_before(uuid,timestamptz)'::regprocedure,
 'public.norva_enqueue_behavioral_email(uuid,uuid,text,text,text,text,text,text,jsonb,jsonb)'::regprocedure,
 'public.norva_authorize_behavioral_email_enqueue(uuid,uuid)'::regprocedure,
 'public.authorize_branded_email_delivery(uuid,text,uuid)'::regprocedure,
 'norva_postal_full.eligibility(text,text,boolean,text)'::regprocedure);
'@}
$taskPayload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($taskFixtures | ConvertTo-Json -Depth 6 -Compress)))
$taskProgram = "PAYLOAD = '$taskPayload'`n"+(Get-Content -Raw -LiteralPath (Join-Path $taskRoot 'tests/run-conditional-email-postgres-proof.py'))
$taskProgram | & ssh -o BatchMode=yes -o ConnectTimeout=8 adrien@157.180.96.159 'python3 -'
if ($LASTEXITCODE -ne 0) { throw 'Isolated conditional email PostgreSQL proof failed' }
