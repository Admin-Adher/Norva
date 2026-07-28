param(
    [switch]$SkipCompile
)

$ErrorActionPreference = 'Stop'
$phoneRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$appRoot = Join-Path $phoneRoot 'app'
$sdkRoot = if ($env:ANDROID_HOME) {
    $env:ANDROID_HOME
} elseif ($env:ANDROID_SDK_ROOT) {
    $env:ANDROID_SDK_ROOT
} else {
    Join-Path $env:LOCALAPPDATA 'Android\Sdk'
}
$androidJar = Join-Path $sdkRoot 'platforms\android-36\android.jar'
if (-not (Test-Path -LiteralPath $androidJar)) {
    throw "Android 36 SDK not found at $androidJar"
}

if (-not $SkipCompile) {
    $gradleSearchRoot = Join-Path $env:USERPROFILE '.gradle\wrapper\dists\gradle-8.13-bin'
    $gradle = Get-ChildItem -LiteralPath $gradleSearchRoot -Recurse -Filter 'gradle.bat' |
        Select-Object -First 1 -ExpandProperty FullName
    if (-not $gradle) {
        throw "Gradle 8.13 was not found under $gradleSearchRoot"
    }
    $env:ANDROID_HOME = $sdkRoot
    $env:ANDROID_SDK_ROOT = $sdkRoot
    & $gradle ':app:compileDebugJavaWithJavac' ':app:compileDebugUnitTestJavaWithJavac' `
        '--no-daemon' '--console=plain'
    if ($LASTEXITCODE -ne 0) {
        throw "Android player contract compilation failed with exit code $LASTEXITCODE"
    }
}

$mainClasses = Join-Path $appRoot `
    'build\intermediates\javac\debug\compileDebugJavaWithJavac\classes'
$testClasses = Join-Path $appRoot `
    'build\intermediates\javac\debugUnitTest\compileDebugUnitTestJavaWithJavac\classes'
if (-not (Test-Path -LiteralPath $mainClasses) -or
        -not (Test-Path -LiteralPath $testClasses)) {
    throw 'Compiled player contract classes are missing. Run without -SkipCompile first.'
}

# PlayerActivity references Media3 types. AARs keep JVM bytecode in a nested
# classes.jar, so expose those generated jars only inside app/build.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$dependencyRoot = Join-Path $appRoot 'build\player-contract-deps'
New-Item -ItemType Directory -Force -Path $dependencyRoot | Out-Null
$mediaCache = Join-Path $env:USERPROFILE `
    '.gradle\caches\modules-2\files-2.1\androidx.media3'
$mediaAars = Get-ChildItem -LiteralPath $mediaCache -Recurse -Filter '*.aar'
foreach ($aar in $mediaAars) {
    $archive = [System.IO.Compression.ZipFile]::OpenRead($aar.FullName)
    try {
        $classesEntry = $archive.GetEntry('classes.jar')
        if ($null -eq $classesEntry) { continue }
        $module = $aar.Directory.Parent.Parent.Name
        $destination = Join-Path $dependencyRoot ($module + '.jar')
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile(
            $classesEntry,
            $destination,
            $true)
    } finally {
        $archive.Dispose()
    }
}

$mediaJars = Get-ChildItem -LiteralPath $dependencyRoot -Filter 'media3-*.jar' |
    ForEach-Object FullName
$classPath = (@($testClasses, $mainClasses, $androidJar) + $mediaJars) -join ';'
& java '-ea' '-cp' $classPath 'tv.norva.phone.PlayerActivityPlaybackUiContractTest'
if ($LASTEXITCODE -ne 0) {
    throw "Android player contract failed with exit code $LASTEXITCODE"
}

Write-Host 'PlayerActivity playback UI contract: PASS'
