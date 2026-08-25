[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F-]{36}$')][string]$SourceId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F-]{36}$')][string]$UserId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F-]{36}$')][string]$GenerationId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9]+$')][string]$CatalogVersion,
  [ValidateSet('live', 'live_channels', 'live_variants', 'titles', 'complete')][string]$Phase = 'live',
  [ValidateRange(0, 2147483647)][int]$Offset = 0,
  [ValidatePattern('^$|^[0-9a-fA-F-]{36}$')][string]$AfterId = '',
  [ValidateRange(1, 1000)][int]$PageSize = 300,
  [ValidateRange(1, 1000)][int]$MaxSteps = 600,
  [ValidateRange(1, 120)][int]$MaxStaleRetries = 30,
  [ValidateRange(1, 60)][int]$MaxTransientRetries = 10,
  [string]$SshTarget = 'adrien@157.180.96.159',
  [string]$DatabaseContainer = 'norva-db'
)

$ErrorActionPreference = 'Stop'

function Invoke-NorvaSql {
  param([Parameter(Mandatory = $true)][string]$Sql)

  $lines = @($Sql | & ssh $SshTarget "docker exec -i $DatabaseContainer psql -U postgres -d postgres -X -qAt -v ON_ERROR_STOP=1" 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "remote SQL failed: $($lines -join ' ')"
  }
  return @($lines | ForEach-Object { [string]$_ } | Where-Object { $_.Trim().Length -gt 0 })
}

function Assert-AuthorityCurrent {
  $sql = @"
select count(*)
from public.cloud_sources s
join public.cloud_source_catalog_heads h
  on h.source_id=s.id and h.user_id=s.user_id
join public.cloud_source_catalog_generations g
  on g.id=h.active_generation_id
 and g.source_id=h.source_id and g.user_id=h.user_id
join public.cloud_source_lifecycle l
  on l.source_id=h.source_id and l.user_id=h.user_id
where s.id='$SourceId'::uuid
  and s.user_id='$UserId'::uuid
  and s.sync_status='syncing'
  and s.sync_error is null
  and s.config_hint->'syncProgress'->>'catalogVersion'='$CatalogVersion'
  and h.active_generation_id='$GenerationId'::uuid
  and h.head_revision=0
  and g.state='active'
  and l.config_revision=0
  and l.visibility_epoch=1
  and public.norva_source_catalog_visible_internal(s.id,s.user_id);
"@
  $result = Invoke-NorvaSql -Sql $sql
  if ($result.Count -ne 1 -or $result[0] -ne '1') {
    throw 'catalog authority changed; refusing to resume'
  }
}

function Set-OperatorLease {
  param(
    [Parameter(Mandatory = $true)][string]$ExpectedPhase,
    [Parameter(Mandatory = $true)][int]$ExpectedOffset,
    [Parameter(Mandatory = $true)][string]$ExpectedAfterId,
    [switch]$RequireExpired
  )
  $expiredPredicate = if ($RequireExpired) {
    "and coalesce((s.config_hint->'finalizeLease'->>'until')::timestamptz,'-infinity'::timestamptz) < now()"
  } else { '' }
  $sql = @"
with updated as (
  update public.cloud_sources s
  set config_hint=jsonb_set(
    coalesce(s.config_hint,'{}'::jsonb),
    '{finalizeLease}',
    jsonb_build_object(
      'until',to_char(now()+interval '2 hours','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'owner','durable-catalog-finalize-stepper-v1'
    ),
    true
  )
  where s.id='$SourceId'::uuid
    and s.user_id='$UserId'::uuid
    and s.sync_status='syncing'
    and s.sync_error is null
    and s.config_hint->'syncProgress'->>'catalogVersion'='$CatalogVersion'
    and s.config_hint->'finalizeCursor'=jsonb_build_object(
      'phase','$ExpectedPhase','offset',$ExpectedOffset,'afterId','$ExpectedAfterId'
    )
    $expiredPredicate
    and exists (
      select 1
      from public.cloud_source_catalog_heads h
      join public.cloud_source_catalog_generations g
        on g.id=h.active_generation_id
       and g.source_id=h.source_id and g.user_id=h.user_id
      join public.cloud_source_lifecycle l
        on l.source_id=h.source_id and l.user_id=h.user_id
      where h.source_id=s.id and h.user_id=s.user_id
        and h.active_generation_id='$GenerationId'::uuid
        and h.head_revision=0
        and g.state='active'
        and l.config_revision=0
        and l.visibility_epoch=1
    )
  returning 1
)
select count(*) from updated;
"@
  $result = Invoke-NorvaSql -Sql $sql
  if ($result.Count -ne 1 -or $result[0] -ne '1') {
    throw "operator lease CAS failed at $ExpectedPhase/$ExpectedOffset"
  }
}

function Save-Cursor {
  param(
    [Parameter(Mandatory = $true)][string]$ExpectedPhase,
    [Parameter(Mandatory = $true)][int]$ExpectedOffset,
    [Parameter(Mandatory = $true)][string]$ExpectedAfterId,
    [Parameter(Mandatory = $true)][string]$NextPhase,
    [Parameter(Mandatory = $true)][int]$NextOffset,
    [Parameter(Mandatory = $true)][string]$NextAfterId
  )
  $sql = @"
with updated as (
  update public.cloud_sources s
  set config_hint=jsonb_set(
    jsonb_set(
      coalesce(s.config_hint,'{}'::jsonb),
      '{finalizeCursor}',
      jsonb_build_object('phase','$NextPhase','offset',$NextOffset,'afterId','$NextAfterId'),
      true
    ),
    '{finalizeLease}',
    jsonb_build_object(
      'until',to_char(now()+interval '2 hours','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'owner','durable-catalog-finalize-stepper-v1'
    ),
    true
  )
  where s.id='$SourceId'::uuid
    and s.user_id='$UserId'::uuid
    and s.sync_status='syncing'
    and s.sync_error is null
    and s.config_hint->'syncProgress'->>'catalogVersion'='$CatalogVersion'
    and s.config_hint->'finalizeCursor'=jsonb_build_object(
      'phase','$ExpectedPhase','offset',$ExpectedOffset,'afterId','$ExpectedAfterId'
    )
    and s.config_hint->'finalizeLease'->>'owner'='durable-catalog-finalize-stepper-v1'
    and exists (
      select 1
      from public.cloud_source_catalog_heads h
      join public.cloud_source_catalog_generations g
        on g.id=h.active_generation_id
       and g.source_id=h.source_id and g.user_id=h.user_id
      join public.cloud_source_lifecycle l
        on l.source_id=h.source_id and l.user_id=h.user_id
      where h.source_id=s.id and h.user_id=s.user_id
        and h.active_generation_id='$GenerationId'::uuid
        and h.head_revision=0
        and g.state='active'
        and l.config_revision=0
        and l.visibility_epoch=1
    )
  returning 1
)
select count(*) from updated;
"@
  $result = Invoke-NorvaSql -Sql $sql
  if ($result.Count -ne 1 -or $result[0] -ne '1') {
    throw "cursor CAS failed after $ExpectedPhase/$ExpectedOffset"
  }
}

function Clear-OperatorStateAfterReady {
  param(
    [Parameter(Mandatory = $true)][string]$ExpectedPhase,
    [Parameter(Mandatory = $true)][int]$ExpectedOffset,
    [Parameter(Mandatory = $true)][string]$ExpectedAfterId
  )
  $sql = @"
with cleaned as (
  update public.cloud_sources s
  set config_hint=(coalesce(s.config_hint,'{}'::jsonb) - 'finalizeCursor' - 'finalizeLease')
  where s.id='$SourceId'::uuid
    and s.user_id='$UserId'::uuid
    and s.sync_status='ready'
    and s.sync_error is null
    and s.config_hint->'syncProgress'->>'stage'='ready'
    and s.config_hint->'syncProgress'->'steps'->'finalize'->>'status'='done'
    and s.config_hint->'finalizeCursor'=jsonb_build_object(
      'phase','$ExpectedPhase','offset',$ExpectedOffset,'afterId','$ExpectedAfterId'
    )
    and s.config_hint->'finalizeLease'->>'owner'='durable-catalog-finalize-stepper-v1'
    and exists (
      select 1
      from public.cloud_source_catalog_heads h
      join public.cloud_source_catalog_generations g
        on g.id=h.active_generation_id
       and g.source_id=h.source_id and g.user_id=h.user_id
      join public.cloud_source_lifecycle l
        on l.source_id=h.source_id and l.user_id=h.user_id
      where h.source_id=s.id and h.user_id=s.user_id
        and h.active_generation_id='$GenerationId'::uuid
        and h.head_revision=0
        and g.state='active'
        and l.config_revision=0
        and l.visibility_epoch=1
    )
  returning 1
)
select count(*) from cleaned;
"@
  $result = Invoke-NorvaSql -Sql $sql
  if ($result.Count -ne 1 -or $result[0] -ne '1') {
    throw "ready cleanup CAS failed at $ExpectedPhase/$ExpectedOffset"
  }
}

Set-OperatorLease -ExpectedPhase $Phase -ExpectedOffset $Offset -ExpectedAfterId $AfterId -RequireExpired

$staleRetries = 0
$transientRetries = 0
for ($step = 1; $step -le $MaxSteps; $step += 1) {
  $requestPhase = $Phase
  $requestOffset = $Offset
  $requestAfterId = $AfterId
  $url = "https://api.norva.tv/functions/v1/norva-source-sync/cron/finalize-step/$SourceId" +
    "?country=FR&phase=$requestPhase&offset=$requestOffset&afterId=$requestAfterId&limit=$PageSize"
  $sql = @"
select extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS','90000');
select r.status::text || '|' || translate(
  encode(convert_to(coalesce(r.content,''),'UTF8'),'base64'),
  E'\n\r',
  ''
)
from extensions.http((
  'POST',
  '$url',
  array[extensions.http_header(
    'Authorization',
    'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='norva_cron_shared_secret')
  )],
  'application/json',
  '{}'
)::extensions.http_request) r;
"@

  $status = 599
  $content = ''
  try {
    $result = Invoke-NorvaSql -Sql $sql
    $responseLine = @($result | Where-Object { $_ -match '^\d{3}\|' } | Select-Object -Last 1)
    if ($responseLine.Count -ne 1) { throw 'missing HTTP response row' }
    $parts = $responseLine[0].Split('|', 2)
    $status = [int]$parts[0]
    if ($parts.Count -eq 2 -and $parts[1]) {
      $content = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1]))
    }
  } catch {
    $status = 599
    $content = ''
  }

  if ($status -eq 200) {
    $payload = $content | ConvertFrom-Json
    if ($payload.error) { throw "error payload under HTTP 200 at $requestPhase/$requestOffset" }
    if ([string]$payload.status -eq 'ready') {
      Clear-OperatorStateAfterReady -ExpectedPhase $requestPhase -ExpectedOffset $requestOffset `
        -ExpectedAfterId $requestAfterId
      Write-Output "READY step=$step phase=$requestPhase offset=$requestOffset"
      exit 0
    }

    $nextPhase = if ($payload.nextPhase) { [string]$payload.nextPhase } else { 'complete' }
    $nextOffset = if ($null -ne $payload.nextOffset) { [int]$payload.nextOffset } else { 0 }
    $nextAfterId = if ($payload.nextAfterId) { [string]$payload.nextAfterId } else { $requestAfterId }
    Save-Cursor -ExpectedPhase $requestPhase -ExpectedOffset $requestOffset -ExpectedAfterId $requestAfterId `
      -NextPhase $nextPhase -NextOffset $nextOffset -NextAfterId $nextAfterId
    $Phase = $nextPhase
    $Offset = $nextOffset
    $AfterId = $nextAfterId
    $staleRetries = 0
    $transientRetries = 0
    if (($step % 20) -eq 0 -or $Phase -eq 'complete') {
      $deleted = if ($payload.readyPrune) { [int]$payload.readyPrune.deletedRows } else { 0 }
      Write-Output "step=$step phase=$Phase offset=$Offset afterId=$AfterId deleted=$deleted"
    }
    continue
  }

  $errorCode = ''
  $errorMessage = ''
  if ($content) {
    try {
      $errorPayload = $content | ConvertFrom-Json
      $errorCode = [string]$errorPayload.code
      $errorMessage = [string]$errorPayload.error
    } catch { }
  }
  if ($status -eq 409 -and $errorCode -eq 'SOURCE_CATALOG_CHANGED') {
    Assert-AuthorityCurrent
    $staleRetries += 1
    if ($staleRetries -gt $MaxStaleRetries) {
      throw "stale retry budget exhausted at $Phase/$Offset"
    }
    Write-Output "stale-retry=$staleRetries phase=$Phase offset=$Offset afterId=$AfterId"
    Start-Sleep -Seconds 2
    $step -= 1
    continue
  }
  if ($status -eq 599 -or ($status -eq 500 -and $errorMessage -eq 'Catalog synchronization is temporarily unavailable')) {
    Assert-AuthorityCurrent
    $transientRetries += 1
    if ($transientRetries -gt $MaxTransientRetries) {
      throw "transient retry budget exhausted at $Phase/$Offset"
    }
    Write-Output "transient-retry=$transientRetries phase=$Phase offset=$Offset HTTP=$status"
    Start-Sleep -Seconds 10
    $step -= 1
    continue
  }
  throw "unexpected finalize response at $Phase/$Offset HTTP=$status"
}

throw "step guard exhausted at $Phase/$Offset"
