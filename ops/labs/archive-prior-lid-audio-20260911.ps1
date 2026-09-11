param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$labRoot = (Resolve-Path -LiteralPath 'C:/Users/AdrienHernandez/.codex/tmp/norva-lid-lab-20260910').Path
$archiveRoot = [IO.Path]::GetFullPath('C:/Users/AdrienHernandez/.codex/tmp/norva-lid-retired-audio-20260911')
if (Test-Path -LiteralPath $archiveRoot) { throw 'Archive already exists; inspect before continuing.' }
$items = @(Get-ChildItem -LiteralPath $labRoot -Recurse -File -Filter '*.wav' | ForEach-Object {
    $file = $_
    $absolute = (Resolve-Path -LiteralPath $file.FullName).Path
    if (-not $absolute.StartsWith($labRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Audio path escaped laboratory.' }
    $relative = $absolute.Substring($labRoot.Length + 1).Replace('\', '/')
    if ($relative -notmatch '^(audio/V[123]-[A-F]\.wav|derived/V[123]-[A-F]-vad20\.wav|independent-vod-20260911/audio/N[23]-[A-C]\.wav)$') { throw 'Unexpected audio file.' }
    $part = Get-Item -LiteralPath $absolute
    while ($part.FullName -ne $labRoot) {
        if ($part.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Audio symlink or junction refused.' }
        $part = Get-Item -LiteralPath ([IO.Path]::GetDirectoryName($part.FullName))
    }
    $target = [IO.Path]::GetFullPath((Join-Path $archiveRoot $relative))
    if (-not $target.StartsWith($archiveRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path escaped destination.' }
    [pscustomobject]@{ Source = $absolute; Relative = $relative; Target = $target; Bytes = $file.Length; SHA256 = (Get-FileHash -LiteralPath $absolute -Algorithm SHA256).Hash }
})
if ($items.Count -ne 23) { throw 'Expected exactly 23 prior laboratory audio files.' }
if (-not $Apply) {
    [pscustomobject]@{ Files = $items.Count; Bytes = ($items | Measure-Object -Property Bytes -Sum).Sum; Destination = $archiveRoot; ReadOnly = $true } | ConvertTo-Json -Compress
    exit
}
$null = New-Item -ItemType Directory -Path $archiveRoot
foreach ($item in $items) {
    if ((Get-FileHash -LiteralPath $item.Source -Algorithm SHA256).Hash -ne $item.SHA256) { throw 'Audio changed after inventory.' }
    $null = New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($item.Target)) -Force
    Move-Item -LiteralPath $item.Source -Destination $item.Target
    if ((Get-FileHash -LiteralPath $item.Target -Algorithm SHA256).Hash -ne $item.SHA256) { throw 'Archived audio hash mismatch.' }
}
$remaining = @(Get-ChildItem -LiteralPath $labRoot -Recurse -File -Filter '*.wav').Count
if ($remaining -ne 0) { throw 'Old audio remains in active laboratory.' }
[pscustomobject]@{ Archived = $items.Count; Bytes = ($items | Measure-Object -Property Bytes -Sum).Sum; Destination = $archiveRoot; Recoverable = $true; ActiveLabAudioRemaining = $remaining } | ConvertTo-Json -Compress
