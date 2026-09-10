param(
  [Parameter(Mandatory=$true)][string]$SourceAuthStore,
  [Parameter(Mandatory=$true)][string]$WorkspaceId,
  [string]$C2CStateDir='C:\codex-c2c-test\state',
  [Parameter(Mandatory=$true)][string]$BackupDirectory
)

$ErrorActionPreference='Stop'
if(-not(Test-Path -LiteralPath $SourceAuthStore)){throw 'AUTHSTORE_SOURCE_MISSING'}
$targetDirectory=Join-Path $C2CStateDir 'auth'
$target=Join-Path $targetDirectory "$WorkspaceId.json"
if(Test-Path -LiteralPath $target){throw 'AUTHSTORE_TARGET_EXISTS_REFUSING_OVERWRITE'}
New-Item -ItemType Directory -Path $targetDirectory,$BackupDirectory -Force|Out-Null
$sourceHash=(Get-FileHash -LiteralPath $SourceAuthStore -Algorithm SHA256).Hash
$source=Get-Content -LiteralPath $SourceAuthStore -Raw|ConvertFrom-Json
$clientCount=@($source.clients).Count; $tokenCount=@($source.tokens).Count
$backup=Join-Path $BackupDirectory (Split-Path -Leaf $SourceAuthStore)
if(Test-Path -LiteralPath $backup){throw 'AUTHSTORE_BACKUP_EXISTS_REFUSING_OVERWRITE'}
Copy-Item -LiteralPath $SourceAuthStore -Destination $backup -ErrorAction Stop
Copy-Item -LiteralPath $SourceAuthStore -Destination $target -ErrorAction Stop
$targetHash=(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
if($targetHash -ne $sourceHash){throw 'AUTHSTORE_HASH_VERIFY_FAILED'}
$targetStore=Get-Content -LiteralPath $target -Raw|ConvertFrom-Json
if(@($targetStore.clients).Count -ne $clientCount -or @($targetStore.tokens).Count -ne $tokenCount){throw 'AUTHSTORE_COUNT_VERIFY_FAILED'}
[pscustomobject]@{source=$SourceAuthStore;target=$target;backup=$backup;preSha256=$sourceHash;postSha256=$targetHash;clientCount=$clientCount;tokenCount=$tokenCount}|ConvertTo-Json -Compress
