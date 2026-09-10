param(
  [Parameter(Mandatory=$true)][string]$GatewayCli,
  [string]$RuntimeDirectory='C:\Users\Administrator\AppData\Local\codex-with-chatgpt\watchdog',
  [string]$C2CStateDir='C:\codex-c2c-test\state',
  [string]$Workspace,
  [string]$WorkspaceId,
  [int]$RequiredPort,
  [string]$Hostname
)
$ErrorActionPreference='Stop'
function Get-Sha256([string]$Path) {
  $sha=[System.Security.Cryptography.SHA256]::Create()
  try {$stream=[System.IO.File]::OpenRead($Path);try {return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','')} finally {$stream.Dispose()}} finally {$sha.Dispose()}
}
$root=Split-Path -Parent $PSScriptRoot; $source=Join-Path $root 'ops\watchdog\c2c-production-watchdog.ps1'; $template=Join-Path $root 'ops\watchdog\c2c-production-watchdog.config.example.json'
$runtimeScript=Join-Path $RuntimeDirectory 'orbnexa-vault-c2c-prod-watchdog.ps1'; $runtimeConfig=Join-Path $RuntimeDirectory 'c2c-production-watchdog.config.json'
if(-not (Test-Path -LiteralPath $GatewayCli)){throw "GATEWAY_CLI_MISSING: $GatewayCli"}
if([string]::IsNullOrWhiteSpace($C2CStateDir)){throw 'C2C_STATE_DIR_REQUIRED'}
New-Item -ItemType Directory -Path $RuntimeDirectory -Force|Out-Null
New-Item -ItemType Directory -Path $C2CStateDir -Force|Out-Null
Copy-Item -LiteralPath $source -Destination $runtimeScript -Force
$config=Get-Content -LiteralPath $template -Raw|ConvertFrom-Json
$config.gatewayCli=$GatewayCli
$config.c2cStateDir=(Resolve-Path -LiteralPath $C2CStateDir).Path
if(-not [string]::IsNullOrWhiteSpace($Workspace)){$config.workspace=$Workspace}
if(-not [string]::IsNullOrWhiteSpace($WorkspaceId)){$config.workspaceId=$WorkspaceId}
if($PSBoundParameters.ContainsKey('RequiredPort')){$config.requiredPort=$RequiredPort}
if(-not [string]::IsNullOrWhiteSpace($Hostname)){$config.hostname=$Hostname}
$config.runtimePath=Join-Path $config.c2cStateDir (Join-Path 'runtime' "$($config.workspaceId).json")
$config|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $runtimeConfig -Encoding UTF8
[pscustomobject]@{runtimeScript=$runtimeScript;runtimeConfig=$runtimeConfig;sourceSha256=(Get-Sha256 $source);runtimeSha256=(Get-Sha256 $runtimeScript)}|ConvertTo-Json -Compress
