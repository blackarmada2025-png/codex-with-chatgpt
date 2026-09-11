[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ProductionCommit,
    [string]$StateRoot = 'C:\codex-c2c-test\state',
    [string]$RepositoryPath = 'C:\codex-c2c-test\worktrees\c2c-canonical-reconstruction-v1',
    [string]$DrRoot = 'Z:\Backups\C2C',
    [string]$AgeExe = 'C:\Users\Administrator\AppData\Local\C2C-DR\age\age\age.exe',
    [string]$AgeRecipient = 'age1u2r9yfm8hejt2nhk9wq6d2qf2p9x8vkv8z5uzse68zht5tr9qq8s33dzy4',
    [int]$RetainNormal = 10,
    [switch]$MajorRelease
)

$ErrorActionPreference = 'Stop'
$Generator = 'c2c-light-recovery-snapshot-v1'

function Get-Inventory([string]$Root) {
    @(
        Get-ChildItem -LiteralPath $Root -File -Recurse | ForEach-Object {
            $relative = $_.FullName.Substring($Root.Length).TrimStart('\\')
            "$relative|$($_.Length)|$($_.LastWriteTimeUtc.Ticks)|$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256 -ErrorAction Stop).Hash)"
        } | Sort-Object
    )
}

function Test-ChildPath([string]$Path, [string]$Parent) {
    $resolvedPath = [IO.Path]::GetFullPath($Path)
    $resolvedParent = [IO.Path]::GetFullPath($Parent).TrimEnd('\\') + '\\'
    return $resolvedPath.StartsWith($resolvedParent, [StringComparison]::OrdinalIgnoreCase)
}

foreach ($required in @($StateRoot, $RepositoryPath, $DrRoot, $AgeExe)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "REQUIRED_PATH_MISSING: $required" }
}
if ($RetainNormal -lt 1) { throw 'RETAIN_NORMAL_MUST_BE_POSITIVE' }
& git -C $RepositoryPath cat-file -e "$ProductionCommit^{commit}" 2>$null
if ($LASTEXITCODE -ne 0) { throw "PRODUCTION_COMMIT_NOT_IN_REPOSITORY: $ProductionCommit" }

$runtimeFiles = Get-ChildItem -LiteralPath (Join-Path $StateRoot 'runtime') -File -Filter '*.json'
if (@($runtimeFiles).Count -ne 1) { throw 'EXPECTED_EXACTLY_ONE_RUNTIME_FILE' }
$runtime = Get-Content -Raw -LiteralPath $runtimeFiles[0].FullName | ConvertFrom-Json
$workspaceId = [string]$runtime.workspaceId
$workspace = [string]$runtime.workspaceRoot
$authPath = Join-Path $StateRoot (Join-Path 'auth' "$workspaceId.json")
if (-not (Test-Path -LiteralPath $authPath)) { throw 'AUTHSTORE_MISSING_FOR_RUNTIME_WORKSPACE' }

$watchRoot = 'C:\Users\Administrator\AppData\Local\codex-with-chatgpt\watchdog'
$watchScript = Join-Path $watchRoot 'orbnexa-vault-c2c-prod-watchdog.ps1'
$watchConfigPath = Join-Path $watchRoot 'c2c-production-watchdog.config.json'
foreach ($required in @($watchScript, $watchConfigPath)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "WATCHDOG_METADATA_MISSING: $required" }
}
$watchConfig = Get-Content -Raw -LiteralPath $watchConfigPath | ConvertFrom-Json

$stateOut = Join-Path $DrRoot 'state'
$gitOut = Join-Path $DrRoot 'git'
$manifestOut = Join-Path $DrRoot 'manifests'
New-Item -ItemType Directory -Path $stateOut, $gitOut, $manifestOut -Force | Out-Null
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$stateArtifact = Join-Path $stateOut "auto-c2c-formal-state-$stamp.age"
$bundleArtifact = Join-Path $gitOut "auto-codex-with-chatgpt-$stamp.bundle"
$manifestArtifact = Join-Path $manifestOut "auto-c2c-recovery-$stamp.json"
$temporaryRoot = Join-Path $env:TEMP ("c2c-light-snapshot-" + [guid]::NewGuid().ToString('N'))
$snapshotRoot = Join-Path $temporaryRoot 'state'
$archivePath = Join-Path $temporaryRoot 'state.zip'
$completed = $false

try {
    New-Item -ItemType Directory -Path $snapshotRoot | Out-Null
    $included = @('auth', 'runtime')
    $before = @()
    foreach ($name in $included) {
        $source = Join-Path $StateRoot $name
        $before += Get-Inventory $source
        Copy-Item -LiteralPath $source -Destination (Join-Path $snapshotRoot $name) -Recurse -Force
    }
    $after = @()
    foreach ($name in $included) { $after += Get-Inventory (Join-Path $StateRoot $name) }
    if ((($before | Sort-Object) -join "`n") -ne (($after | Sort-Object) -join "`n")) { throw 'FORMAL_STATE_CHANGED_DURING_SNAPSHOT' }

    $copied = @()
    foreach ($name in $included) { $copied += Get-Inventory (Join-Path $snapshotRoot $name) }
    $sourceComparable = $before | ForEach-Object { $_ -replace '^[^\\]+\\', '' } | Sort-Object
    $copyComparable = $copied | ForEach-Object { $_ -replace '^[^\\]+\\', '' } | Sort-Object
    if (($sourceComparable -join "`n") -ne ($copyComparable -join "`n")) { throw 'FORMAL_STATE_SNAPSHOT_HASH_MISMATCH' }

    Compress-Archive -LiteralPath $snapshotRoot -DestinationPath $archivePath -CompressionLevel Optimal -Force
    & $AgeExe -r $AgeRecipient -o $stateArtifact $archivePath
    if ($LASTEXITCODE -ne 0) { throw 'STATE_ENCRYPTION_FAILED' }

    & git -C $RepositoryPath bundle create $bundleArtifact --all
    if ($LASTEXITCODE -ne 0) { throw 'GIT_BUNDLE_CREATE_FAILED' }
    # git bundle verify writes its successful summary to stderr. Invoke it via
    # cmd so Windows PowerShell cannot promote that success text to an error.
    & $env:ComSpec /d /c "git bundle verify `"$bundleArtifact`" 2>nul"
    if ($LASTEXITCODE -ne 0) { throw "GIT_BUNDLE_VERIFY_FAILED: $($bundleVerify -join ' ')" }
    $commitPresent = @(& git bundle list-heads $bundleArtifact | Where-Object { $_ -like "$ProductionCommit*" }).Count -gt 0
    if (-not $commitPresent) { throw 'PRODUCTION_COMMIT_NOT_PRESENT_IN_BUNDLE' }

    $stateHash = (Get-FileHash -LiteralPath $stateArtifact -Algorithm SHA256).Hash
    $bundleHash = (Get-FileHash -LiteralPath $bundleArtifact -Algorithm SHA256).Hash
    $manifest = [ordered]@{
        generator = $Generator
        retentionClass = if ($MajorRelease) { 'major' } else { 'normal' }
        backupTimestamp = $stamp
        productionCommit = $ProductionCommit
        workspaceId = $workspaceId
        workspace = $workspace
        formalStateSourcePath = $StateRoot
        formalStateIncludedPaths = $included
        excludedVolatilePaths = @('logs')
        stateSnapshotFileCount = $before.Count
        stateBackupPath = $stateArtifact
        stateBackupSHA256 = $stateHash
        gitBundlePath = $bundleArtifact
        gitBundleSHA256 = $bundleHash
        ageRecipient = $AgeRecipient
        watchdogScriptSHA256 = (Get-FileHash -LiteralPath $watchScript -Algorithm SHA256).Hash
        watchdogConfigSHA256 = (Get-FileHash -LiteralPath $watchConfigPath -Algorithm SHA256).Hash
        tunnelIdentity = [ordered]@{ tunnelId = $watchConfig.tunnelId; hostname = $watchConfig.hostname }
        recoveryProcedureReference = 'docs/operations/formal-c2c-state-recovery.md'
    }
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestArtifact -Encoding UTF8

    $stateReadback = (Get-FileHash -LiteralPath $stateArtifact -Algorithm SHA256).Hash -eq $stateHash
    $bundleReadback = (Get-FileHash -LiteralPath $bundleArtifact -Algorithm SHA256).Hash -eq $bundleHash
    $manifestReadable = $null -ne (Get-Content -Raw -LiteralPath $manifestArtifact | ConvertFrom-Json)
    if (-not ($stateReadback -and $bundleReadback -and $manifestReadable)) { throw 'NAS_READBACK_VERIFICATION_FAILED' }

    $normal = @(
        Get-ChildItem -LiteralPath $manifestOut -Filter 'auto-c2c-recovery-*.json' -File | ForEach-Object {
            try { Get-Content -Raw -LiteralPath $_.FullName | ConvertFrom-Json } catch { $null }
        } | Where-Object { $_ -and $_.generator -eq $Generator -and $_.retentionClass -eq 'normal' } |
        Sort-Object backupTimestamp -Descending
    )
    foreach ($old in @($normal | Select-Object -Skip $RetainNormal)) {
        if ((Test-ChildPath $old.stateBackupPath $stateOut) -and (Test-ChildPath $old.gitBundlePath $gitOut)) {
            Remove-Item -LiteralPath $old.stateBackupPath, $old.gitBundlePath -Force -ErrorAction Stop
            $oldManifest = Join-Path $manifestOut "auto-c2c-recovery-$($old.backupTimestamp).json"
            if (Test-ChildPath $oldManifest $manifestOut) { Remove-Item -LiteralPath $oldManifest -Force -ErrorAction Stop }
        }
    }

    $completed = $true
    [pscustomobject]@{
        snapshotResult = 'PASS'
        stateBackupPath = $stateArtifact
        gitBundlePath = $bundleArtifact
        manifestPath = $manifestArtifact
        stateReadbackHashMatch = $stateReadback
        gitBundleVerify = 'PASS'
        gitReadbackHashMatch = $bundleReadback
        productionCommitPresent = $commitPresent
        manifestReadable = $manifestReadable
        retentionPolicy = "keep last $RetainNormal generator-marked normal snapshots; retain major and legacy snapshots"
        idempotent = $true
    } | ConvertTo-Json -Compress
}
finally {
    if (Test-Path -LiteralPath $temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse -Force }
    if (-not $completed) {
        foreach ($artifact in @($stateArtifact, $bundleArtifact, $manifestArtifact)) {
            if (Test-Path -LiteralPath $artifact) { Remove-Item -LiteralPath $artifact -Force -ErrorAction SilentlyContinue }
        }
    }
}
