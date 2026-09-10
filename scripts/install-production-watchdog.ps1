param([Parameter(Mandatory=$true)][string]$GatewayCli,[string]$RuntimeDirectory='C:\Users\Administrator\AppData\Local\codex-with-chatgpt\watchdog')
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot; $source=Join-Path $root 'ops\watchdog\c2c-production-watchdog.ps1'; $template=Join-Path $root 'ops\watchdog\c2c-production-watchdog.config.example.json'
$runtimeScript=Join-Path $RuntimeDirectory 'orbnexa-vault-c2c-prod-watchdog.ps1'; $runtimeConfig=Join-Path $RuntimeDirectory 'c2c-production-watchdog.config.json'
if(-not (Test-Path -LiteralPath $GatewayCli)){throw "GATEWAY_CLI_MISSING: $GatewayCli"}; New-Item -ItemType Directory -Path $RuntimeDirectory -Force|Out-Null
Copy-Item -LiteralPath $source -Destination $runtimeScript -Force
$config=Get-Content -LiteralPath $template -Raw|ConvertFrom-Json; $config.gatewayCli=$GatewayCli; $config|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $runtimeConfig -Encoding UTF8
[pscustomobject]@{runtimeScript=$runtimeScript;runtimeConfig=$runtimeConfig;sourceSha256=(Get-FileHash $source -Algorithm SHA256).Hash;runtimeSha256=(Get-FileHash $runtimeScript -Algorithm SHA256).Hash}|ConvertTo-Json -Compress
