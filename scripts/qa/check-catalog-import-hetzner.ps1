[CmdletBinding()]
param(
  [string]$Provider = '',
  [string]$SshTarget = $(if ($env:NORVA_HETZNER_SSH_TARGET) { $env:NORVA_HETZNER_SSH_TARGET } else { 'adrien@157.180.96.159' }),
  [string]$SshKey = $(if ($env:NORVA_HETZNER_SSH_KEY) { $env:NORVA_HETZNER_SSH_KEY } else { "$env:USERPROFILE\.ssh\norva-hetzner-ed25519" }),
  [ValidatePattern('^[A-Za-z0-9-]{1,64}$')]
  [string]$RunId = ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')),
  [ValidateRange(1, 4)][int]$Attempts = 4,
  [ValidateRange(5, 120)][int]$RequestTimeout = 90,
  [ValidateRange(1, 120)][int]$PageSize = 36
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# Usage: .\scripts\qa\check-catalog-import-hetzner.ps1 [-Provider 'Lion']
# Copies only this read-only runner; neither import, credentials nor provider
# configuration are modified. Reports contain summaries, never raw API bodies.
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$localDir = Join-Path $repoRoot ".codex-artifacts\catalog-import-check-$RunId"
$remoteScript = "/home/adrien/.norva/catalog-import-check-$RunId.py"
if (-not (Test-Path -LiteralPath $SshKey -PathType Leaf)) { throw 'SSH key is unavailable.' }
if ($SshTarget.StartsWith('-') -or $SshTarget -match '\s') { throw 'Invalid SSH target.' }
if ($Provider.Length -gt 128) { throw 'Provider name is too long.' }
if (Test-Path -LiteralPath $localDir) { throw 'RunId already exists; choose a new RunId to preserve prior evidence.' }
$sshCommon = @('-i', $SshKey, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes')
$options = @{ attempts = $Attempts; timeout = $RequestTimeout; page_size = $PageSize }
if ($Provider) { $options.provider = $Provider }
$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($options | ConvertTo-Json -Compress)))
New-Item -ItemType Directory -Path $localDir | Out-Null
& scp.exe @sshCommon (Join-Path $PSScriptRoot 'remote-catalog-import-check.py') "${SshTarget}:$remoteScript"
if ($LASTEXITCODE -ne 0) { throw 'Read-only runner upload failed.' }
$output = @(& ssh.exe @sshCommon $SshTarget "python3 -u '$remoteScript' --options-base64 '$encoded'")
$remoteExit = $LASTEXITCODE
$output | Set-Content -LiteralPath (Join-Path $localDir 'checks.jsonl') -Encoding utf8
$rows = @($output | ForEach-Object { $_ | ConvertFrom-Json })
$summary = @($rows | Where-Object { $_.kind -eq 'summary' })
@{ summary = $summary; checks = @($rows | Where-Object { $_.kind -eq 'check' }); remoteExit = $remoteExit } |
  ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $localDir 'report.json') -Encoding utf8
Write-Host "Report: $localDir\report.json"
if ($remoteExit -ne 0 -or $summary.Count -ne 1 -or $summary[0].result -ne 'pass') {
  throw 'Catalogue check failed; sanitized results have been saved.'
}
Write-Host ("PASS: {0} checks, {1} skipped, {2} retries, {3}s total; slowest request {4}s." -f
  $summary[0].passed, $summary[0].skipped, $summary[0].retries, $summary[0].seconds, $summary[0].maxRequestSeconds)
