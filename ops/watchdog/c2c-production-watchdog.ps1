param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'c2c-production-watchdog.config.json'),
    [string]$ContractFixture,
    [switch]$ContractTest
)

$ErrorActionPreference = 'Stop'

function Resolve-GatewayAction($state) {
    if ($null -eq $state.portOwner) { return 'start' }
    if ($state.identityHealthy -eq $true) { return 'adopt' }
    return 'fail'
}

function Resolve-TunnelAction($state) {
    if ($state.existingCount -eq 0) { return 'start' }
    if ($state.existingCount -eq 1 -and $state.identityHealthy -eq $true -and $state.publicHealthy -eq $true) { return 'adopt' }
    return 'fail'
}

if ($ContractTest) {
    if (-not $ContractFixture) { throw 'CONTRACT_FIXTURE_REQUIRED' }
    $fixture = Get-Content -LiteralPath $ContractFixture -Raw | ConvertFrom-Json
    $gatewayAction = Resolve-GatewayAction $fixture.gateway
    $tunnelAction = Resolve-TunnelAction $fixture.tunnel
    [pscustomobject]@{ gatewayAction=$gatewayAction; tunnelAction=$tunnelAction; exitCode=if ($gatewayAction -eq 'fail' -or $tunnelAction -eq 'fail') { 1 } else { 0 } } | ConvertTo-Json -Compress
    exit $(if ($gatewayAction -eq 'fail' -or $tunnelAction -eq 'fail') { 1 } else { 0 })
}

$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$workspace = [string]$config.workspace; $workspaceId = [string]$config.workspaceId; $requiredPort = [int]$config.requiredPort
$node = [string]$config.node; $cli = [string]$config.gatewayCli; $runtimePath = [string]$config.runtimePath; $c2cStateDir = [string]$config.c2cStateDir
$cloudflared = [string]$config.cloudflared; $cloudflaredConfig = [string]$config.cloudflaredConfig; $tunnelId = [string]$config.tunnelId; $hostname = [string]$config.hostname
$candidateGatewayPid = $null; $candidateTunnelPid = $null

function Get-PortOwner { $listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $requiredPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($listener) { return [int]$listener.OwningProcess }; return $null }
function Read-VaultRuntime { if (-not (Test-Path -LiteralPath $runtimePath)) { return $null }; try { return Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json -ErrorAction Stop } catch { return $null } }
function Test-GatewayIdentity {
    $runtime = Read-VaultRuntime
    if ($null -eq $runtime -or $runtime.workspaceId -ne $workspaceId -or $runtime.workspaceRoot -ne $workspace -or [int]$runtime.port -ne $requiredPort -or -not $runtime.pid) { return $false }
    $owner = Get-PortOwner; if ($null -eq $owner -or $owner -ne [int]$runtime.pid) { return $false }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($runtime.pid)" -ErrorAction SilentlyContinue
    if (-not $process -or -not $process.CommandLine -or $process.CommandLine -notlike "*$cli*" -or $process.CommandLine -notlike "*$workspace*" -or $process.CommandLine -notmatch "(?i)--port\s+$requiredPort(?:\s|$)") { return $false }
    try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$requiredPort/health" -TimeoutSec 5; return ($health.service -eq 'c2c-bridge' -and $health.workspaceId -eq $workspaceId) } catch { return $false }
}
function Get-GatewayState { [pscustomobject]@{ portOwner=Get-PortOwner; identityHealthy=Test-GatewayIdentity } }
function Get-NamedTunnelProcesses { @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'cloudflared.exe' -and $_.CommandLine -like "*$tunnelId*" -and $_.CommandLine -like "*$cloudflaredConfig*" }) }
function Test-PublicContract { try { $health = Invoke-RestMethod -Uri "https://$hostname/health" -TimeoutSec 15; return ($health.service -eq 'c2c-bridge' -and $health.workspaceId -eq $workspaceId) } catch { return $false } }
function Get-TunnelState { $existing=Get-NamedTunnelProcesses; [pscustomobject]@{ existingCount=@($existing).Count; identityHealthy=(@($existing).Count -eq 1); publicHealthy=Test-PublicContract; processId=if (@($existing).Count -eq 1) { [int]$existing[0].ProcessId } else { $null } } }
function Start-StrictGateway {
    if (Get-PortOwner) { throw "PORT_IN_USE: 127.0.0.1:$requiredPort" }
    if ([string]::IsNullOrWhiteSpace($c2cStateDir)) { throw 'C2C_STATE_DIR_REQUIRED' }
    $previousStateDir = $env:C2C_STATE_DIR
    try {
        $env:C2C_STATE_DIR = $c2cStateDir
        $output=@(& $node $cli start --workspace $workspace --port $requiredPort --json 2>&1)
        if ($LASTEXITCODE -ne 0) { throw "GATEWAY_START_FAILED: $($output -join ' ')" }
    } finally {
        if ($null -eq $previousStateDir) { Remove-Item Env:C2C_STATE_DIR -ErrorAction SilentlyContinue } else { $env:C2C_STATE_DIR = $previousStateDir }
    }
    $deadline=(Get-Date).AddSeconds(25)
    do { $runtime=Read-VaultRuntime; if ($runtime -and $runtime.pid) { $script:candidateGatewayPid=[int]$runtime.pid }; if (Test-GatewayIdentity) { return }; Start-Sleep -Milliseconds 500 } while ((Get-Date) -lt $deadline)
    throw 'GATEWAY_CONTRACT_FAILED'
}
function Start-NamedTunnel { $argumentList='tunnel --config "{0}" run {1}' -f $cloudflaredConfig,$tunnelId; $process=Start-Process -FilePath $cloudflared -ArgumentList $argumentList -WindowStyle Hidden -PassThru; $script:candidateTunnelPid=[int]$process.Id; $deadline=(Get-Date).AddSeconds(50); do { if ((Get-Process -Id $candidateTunnelPid -ErrorAction SilentlyContinue) -and (Test-PublicContract)) { return }; Start-Sleep -Milliseconds 500 } while ((Get-Date) -lt $deadline); throw 'NAMED_TUNNEL_CONNECTION_TIMEOUT' }

try {
    foreach ($requiredFile in @($node,$cli,$cloudflared,$cloudflaredConfig)) { if (-not (Test-Path -LiteralPath $requiredFile)) { throw "REQUIRED_FILE_MISSING: $requiredFile" } }
    $gatewayAction=Resolve-GatewayAction (Get-GatewayState); if ($gatewayAction -eq 'fail') { throw "PORT_OCCUPIED_BY_NON_TARGET: 127.0.0.1:$requiredPort" }; if ($gatewayAction -eq 'adopt') { $script:candidateGatewayPid=[int](Read-VaultRuntime).pid } else { Start-StrictGateway }
    $tunnelAction=Resolve-TunnelAction (Get-TunnelState); if ($tunnelAction -eq 'fail') { throw 'NAMED_TUNNEL_NOT_ADOPTABLE' }; if ($tunnelAction -eq 'adopt') { $script:candidateTunnelPid=(Get-TunnelState).processId } else { Start-NamedTunnel }
    [pscustomobject]@{ok=$true;gatewayAction=$gatewayAction;tunnelAction=$tunnelAction;gatewayPid=$candidateGatewayPid;cloudflaredPid=$candidateTunnelPid}|ConvertTo-Json -Compress
    while ($true) { if (-not (Test-GatewayIdentity)) { throw 'GATEWAY_CONTRACT_LOST' }; if (-not (Get-Process -Id $candidateTunnelPid -ErrorAction SilentlyContinue)) { throw 'NAMED_TUNNEL_PROCESS_LOST' }; Start-Sleep -Seconds 30 }
} catch { Write-Error $_.Exception.Message; exit 1 }
