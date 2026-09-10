param(
 [Parameter(Mandatory=$true)][string]$CandidateCli,
 [Parameter(Mandatory=$true)][string]$OldGatewayCli,
 [Parameter(Mandatory=$true)][string]$C2CStateDir,
 [Parameter(Mandatory=$true)][string]$Workspace,
 [Parameter(Mandatory=$true)][string]$WorkspaceId,
 [int]$Port=48765,
 [string]$WatchdogRuntimeDirectory='C:\Users\Administrator\AppData\Local\codex-with-chatgpt\watchdog',
 [switch]$SimulatePublicNetwork,
 [switch]$IsolatedTestMode,
 [switch]$DryRun,
 [string]$ContractFixture,
 [switch]$ContractTest
)
$ErrorActionPreference='Stop'

function Get-Sha256([string]$Path) {
 $sha=[System.Security.Cryptography.SHA256]::Create()
 try {$stream=[System.IO.File]::OpenRead($Path);try {return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','')} finally {$stream.Dispose()}} finally {$sha.Dispose()}
}
function Get-AuthStoreSnapshot([string]$AuthPath) {
 if(-not(Test-Path -LiteralPath $AuthPath -PathType Leaf)){throw 'AUTHSTORE_MISSING'}
 try {$store=Get-Content -LiteralPath $AuthPath -Raw|ConvertFrom-Json -ErrorAction Stop} catch {throw 'AUTHSTORE_INVALID'}
 if($null -eq $store.clients -or $null -eq $store.tokens){throw 'AUTHSTORE_SCHEMA_INVALID'}
 [pscustomobject]@{path=$AuthPath;sha256=(Get-Sha256 $AuthPath);clientCount=@($store.clients).Count;tokenCount=@($store.tokens).Count}
}
function Test-AuthStoreSnapshot($Expected) { try {$actual=Get-AuthStoreSnapshot $Expected.path;return ($actual.sha256 -eq $Expected.sha256 -and $actual.clientCount -eq $Expected.clientCount -and $actual.tokenCount -eq $Expected.tokenCount)} catch {return $false} }
function Normalize-PathIdentity([string]$Path) {return [System.IO.Path]::GetFullPath($Path).TrimEnd([System.IO.Path]::DirectorySeparatorChar,[System.IO.Path]::AltDirectorySeparatorChar)}
function Get-ProcessCommandLine([int]$ProcessId) {$process=Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue;if($null -eq $process){return $null};return [string]$process.CommandLine}
function Test-RuntimeBindingCheckpoint([int]$CandidatePid) {
 $file=Join-Path $C2CStateDir (Join-Path 'runtime' "$WorkspaceId.json")
 if(-not(Test-Path -LiteralPath $file -PathType Leaf)){throw 'RUNTIME_BINDING_FILE_MISSING'}
 try {$runtime=Get-Content -LiteralPath $file -Raw|ConvertFrom-Json -ErrorAction Stop} catch {throw 'RUNTIME_BINDING_FILE_INVALID'}
 if([int]$runtime.pid -ne $CandidatePid){throw 'RUNTIME_BINDING_PID_MISMATCH'}
 if([int]$runtime.port -ne $Port){throw 'RUNTIME_BINDING_PORT_MISMATCH'}
 if([string]$runtime.workspaceId -ne $WorkspaceId){throw 'RUNTIME_BINDING_WORKSPACE_MISMATCH'}
 $runtimeRoot=Normalize-PathIdentity ([string]$runtime.workspaceRoot);$expectedRoot=Normalize-PathIdentity $Workspace
 if($runtimeRoot -ne $expectedRoot){throw 'RUNTIME_BINDING_WORKSPACE_ROOT_MISMATCH'}
 $listener=Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -ErrorAction SilentlyContinue|Select-Object -First 1
 if(($null -eq $listener -or [int]$listener.OwningProcess -ne $CandidatePid) -and -not $IsolatedTestMode){throw 'RUNTIME_BINDING_PORT_OWNER_MISMATCH'}
 $commandLine=Get-ProcessCommandLine $CandidatePid
 if(-not [string]::IsNullOrWhiteSpace($commandLine) -and ($commandLine -notlike "*$CandidateCli*" -or $commandLine -notlike "*$Workspace*")){throw 'RUNTIME_BINDING_CANDIDATE_IDENTITY_MISMATCH'}
 if([string]::IsNullOrWhiteSpace($commandLine) -and -not $IsolatedTestMode){throw 'RUNTIME_BINDING_CANDIDATE_IDENTITY_UNAVAILABLE'}
 [pscustomobject]@{ok=$true;checkpoint='AFTER_CANDIDATE_START_BEFORE_WATCHDOG';runtimeFile=$file;pid=$runtime.pid;port=$runtime.port;workspaceId=$runtime.workspaceId}
}
function Invoke-CutoverRollback($adapter,$stage,$trigger) {
 if($adapter.rollbackInvoked){return $adapter.rollbackResult}
 $adapter.rollbackInvoked=$true;$adapter.events=@($adapter.events)+"rollback:${stage}:${trigger}"
 try {if($adapter.candidatePid){$adapter.StopCandidate.Invoke()};if($adapter.watchdogBackup){$adapter.RestoreWatchdog.Invoke()};if($adapter.r3Runtime){$adapter.RestoreR3.Invoke();if(-not $adapter.TestLocalHealth.Invoke() -or (-not $IsolatedTestMode -and -not $adapter.TestPublicHealth.Invoke())){throw 'ROLLBACK_HEALTH_FAILED'}};$adapter.rollbackResult=[pscustomobject]@{result='ROLLED_BACK';failureStage=$stage;rollbackTrigger=$trigger;rollbackResult='PASS'}} catch {$adapter.rollbackResult=[pscustomobject]@{result='ROLLBACK_FAILED';failureStage=$stage;rollbackTrigger=$trigger;rollbackResult=$_.Exception.Message}}
 return $adapter.rollbackResult
}
function Invoke-CutoverStateMachine($adapter) {
 $stage='PRECHECK'
 try {
  if(-not $adapter.Preflight.Invoke()){throw 'PREFLIGHT_FAILED'}
  $stage='PRESERVE_AUTHSTORE';if(-not $adapter.CaptureAuthStore.Invoke()){throw 'AUTHSTORE_CAPTURE_FAILED'}
  $stage='STOP_R3';if(-not $adapter.StopR3.Invoke()){throw 'R3_STOP_FAILED'}
  $stage='START_CANDIDATE';if(-not $adapter.StartCandidate.Invoke()){throw 'CANDIDATE_START_FAILED'}
  $stage='RUNTIME_CHECKPOINT';if(-not $adapter.Checkpoint.Invoke()){throw 'RUNTIME_BINDING_FAILED'}
  $stage='WATCHDOG_HANDOFF';if(-not $adapter.HandoffWatchdog.Invoke()){throw 'WATCHDOG_HANDOFF_FAILED'}
  $stage='PUBLIC_HEALTH';if(-not $adapter.TestPublicHealth.Invoke()){throw 'PUBLIC_HEALTH_FAILED'}
  $stage='AUTHSTORE';if(-not $adapter.AuthStoreIntegrity.Invoke()){throw 'AUTHSTORE_INTEGRITY_FAILED'}
  [pscustomobject]@{result='PASS';failureStage=$null;rollbackTrigger=$null;rollbackResult=$null;events=$adapter.events}
 } catch {$rollback=Invoke-CutoverRollback $adapter $stage $_.Exception.Message;$rollback|Add-Member NoteProperty events $adapter.events -Force;return $rollback}
}
if($ContractTest){if(-not $ContractFixture){throw 'CONTRACT_FIXTURE_REQUIRED'};$f=Get-Content -LiteralPath $ContractFixture -Raw|ConvertFrom-Json;$publicCalls=0;$a=[pscustomobject]@{events=@();rollbackInvoked=$false;rollbackResult=$null;Preflight={ $f.preflight };CaptureAuthStore={ $true };StopR3={ $true };StartCandidate={ $f.start };Checkpoint={ $f.checkpoint };HandoffWatchdog={ $f.watchdog };TestLocalHealth={ $f.local };TestPublicHealth={ $script:publicCalls++;if($script:publicCalls -gt 1 -and $null -ne $f.rollbackPublic){$f.rollbackPublic}else{$f.public} };AuthStoreIntegrity={ $f.auth };StopCandidate={};RestoreR3={};RestoreWatchdog={}};Invoke-CutoverStateMachine $a|ConvertTo-Json -Compress;exit 0}
if($DryRun){foreach($file in @($CandidateCli,$OldGatewayCli)){if(-not(Test-Path -LiteralPath $file -PathType Leaf)){throw "REQUIRED_FILE_MISSING:$file"}};if(-not(Test-Path -LiteralPath (Join-Path $C2CStateDir 'auth') -PathType Container)){throw 'FORMAL_STATE_AUTH_MISSING'};[pscustomobject]@{ok=$true;mode='DRY_RUN';stateDir=(Resolve-Path -LiteralPath $C2CStateDir).Path;checkpointPosition='AFTER_CANDIDATE_START_BEFORE_WATCHDOG';rollbackTarget=$OldGatewayCli}|ConvertTo-Json -Compress;exit 0}
function New-ProductionAdapter {
 $runtimeDir=$WatchdogRuntimeDirectory;$runtimeConfig=Join-Path $runtimeDir 'c2c-production-watchdog.config.json';$runtimeScript=Join-Path $runtimeDir 'orbnexa-vault-c2c-prod-watchdog.ps1';$installer=Join-Path $PSScriptRoot '..\..\scripts\install-production-watchdog.ps1';$auth=Join-Path $C2CStateDir (Join-Path 'auth' "$WorkspaceId.json");$runtimeFile=Join-Path $C2CStateDir (Join-Path 'runtime' "$WorkspaceId.json")
 $adapter=[pscustomobject]@{events=@();rollbackInvoked=$false;rollbackResult=$null;authSnapshot=$null;watchdogBackup=$null;candidatePid=$null;r3Runtime=$null;Preflight=$null;CaptureAuthStore=$null;StopR3=$null;StartCandidate=$null;Checkpoint=$null;HandoffWatchdog=$null;TestLocalHealth=$null;TestPublicHealth=$null;AuthStoreIntegrity=$null;StopCandidate=$null;RestoreR3=$null;RestoreWatchdog=$null}
 $adapter.Preflight={foreach($file in @($CandidateCli,$OldGatewayCli,$installer,$auth,$runtimeConfig,$runtimeScript)){if(-not(Test-Path -LiteralPath $file -PathType Leaf)){return $false}};try{$config=Get-Content -LiteralPath $runtimeConfig -Raw|ConvertFrom-Json -ErrorAction Stop}catch{return $false};return ([string]$config.workspace -eq $Workspace -and [string]$config.workspaceId -eq $WorkspaceId -and [int]$config.requiredPort -eq $Port -and [string]$config.gatewayCli -eq $OldGatewayCli -and [string]$config.c2cStateDir -eq $C2CStateDir)}.GetNewClosure()
 $adapter.CaptureAuthStore={ $adapter.authSnapshot=Get-AuthStoreSnapshot $auth;return $true }.GetNewClosure()
 $adapter.StopR3={if(-not(Test-Path -LiteralPath $runtimeFile -PathType Leaf)){throw 'R3_RUNTIME_MISSING'};$r=Get-Content -LiteralPath $runtimeFile -Raw|ConvertFrom-Json;if([string]$r.workspaceId -ne $WorkspaceId -or [int]$r.port -ne $Port -or -not $r.adminToken){throw 'R3_RUNTIME_IDENTITY_INVALID'};$commandLine=Get-ProcessCommandLine ([int]$r.pid);if(-not [string]::IsNullOrWhiteSpace($commandLine) -and $commandLine -notlike "*$OldGatewayCli*"){throw 'R3_PROCESS_IDENTITY_MISMATCH'};if([string]::IsNullOrWhiteSpace($commandLine) -and -not $IsolatedTestMode){throw 'R3_PROCESS_IDENTITY_UNAVAILABLE'};$adapter.r3Runtime=$r;try{Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/admin/shutdown" -Headers @{Authorization="Bearer $($r.adminToken)"} -TimeoutSec 8|Out-Null}catch{throw 'R3_GRACEFUL_SHUTDOWN_FAILED'};$deadline=(Get-Date).AddSeconds(15);do{if($null -eq(Get-Process -Id ([int]$r.pid) -ErrorAction SilentlyContinue)){return $true};Start-Sleep -Milliseconds 250}while((Get-Date)-lt $deadline);throw 'R3_SHUTDOWN_TIMEOUT'}.GetNewClosure()
 $adapter.StartCandidate={$previous=$env:C2C_STATE_DIR;try{$env:C2C_STATE_DIR=$C2CStateDir;$output=@(& 'C:\Program Files\nodejs\node.exe' $CandidateCli start --workspace $Workspace --port $Port --json 2>&1);if($LASTEXITCODE -ne 0){throw "CANDIDATE_START_FAILED: $($output -join ' ')"}}finally{if($null -eq $previous){Remove-Item Env:C2C_STATE_DIR -ErrorAction SilentlyContinue}else{$env:C2C_STATE_DIR=$previous}};if(-not(Test-Path -LiteralPath $runtimeFile -PathType Leaf)){throw 'CANDIDATE_RUNTIME_MISSING'};$adapter.candidatePid=[int]((Get-Content -LiteralPath $runtimeFile -Raw|ConvertFrom-Json).pid);return $true}.GetNewClosure()
 $adapter.Checkpoint={Test-RuntimeBindingCheckpoint $adapter.candidatePid|Out-Null;return $true}.GetNewClosure()
 $adapter.HandoffWatchdog={$adapter.watchdogBackup=Join-Path ([System.IO.Path]::GetTempPath()) ('c2c-cutover-'+[guid]::NewGuid().ToString());New-Item -ItemType Directory -Path $adapter.watchdogBackup -ErrorAction Stop|Out-Null;Copy-Item -LiteralPath $runtimeConfig,$runtimeScript -Destination $adapter.watchdogBackup -ErrorAction Stop;$previousConfig=Get-Content -LiteralPath $runtimeConfig -Raw|ConvertFrom-Json;& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -GatewayCli $CandidateCli -RuntimeDirectory $runtimeDir -C2CStateDir $C2CStateDir -Workspace $Workspace -WorkspaceId $WorkspaceId -RequiredPort $Port -Hostname $previousConfig.hostname|Out-Null;if($LASTEXITCODE -ne 0){throw 'WATCHDOG_INSTALL_FAILED'};$installed=Get-Content -LiteralPath $runtimeConfig -Raw|ConvertFrom-Json;if([string]$installed.gatewayCli -ne $CandidateCli -or [string]$installed.c2cStateDir -ne $C2CStateDir -or [string]$installed.workspaceId -ne $WorkspaceId -or [int]$installed.requiredPort -ne $Port -or [string]$installed.hostname -ne [string]$previousConfig.hostname){throw 'WATCHDOG_HANDOFF_VERIFY_FAILED'};return $true}.GetNewClosure()
 $adapter.TestLocalHealth={try{$h=Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 8;return ($h.service -eq 'c2c-bridge' -and $h.workspaceId -eq $WorkspaceId)}catch{return $false}}.GetNewClosure()
 $adapter.TestPublicHealth={if($SimulatePublicNetwork){return $adapter.TestLocalHealth.Invoke()};try{$hostname=(Get-Content -LiteralPath $runtimeConfig -Raw|ConvertFrom-Json).hostname;$h=Invoke-RestMethod -Uri "https://$hostname/health" -TimeoutSec 15;return ($h.service -eq 'c2c-bridge' -and $h.workspaceId -eq $WorkspaceId)}catch{return $false}}.GetNewClosure()
 $adapter.AuthStoreIntegrity={Test-AuthStoreSnapshot $adapter.authSnapshot}.GetNewClosure()
 $adapter.StopCandidate={if(-not $adapter.candidatePid){return};try{$r=Get-Content -LiteralPath $runtimeFile -Raw|ConvertFrom-Json;Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/admin/shutdown" -Headers @{Authorization="Bearer $($r.adminToken)"} -TimeoutSec 5|Out-Null}catch{};$deadline=(Get-Date).AddSeconds(15);do{if($null -eq(Get-Process -Id $adapter.candidatePid -ErrorAction SilentlyContinue)){break};Start-Sleep -Milliseconds 250}while((Get-Date)-lt $deadline);if(Get-Process -Id $adapter.candidatePid -ErrorAction SilentlyContinue){Stop-Process -Id $adapter.candidatePid -Force -ErrorAction SilentlyContinue};$deadline=(Get-Date).AddSeconds(10);do{$listener=Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -ErrorAction SilentlyContinue|Select-Object -First 1;if($null -eq(Get-Process -Id $adapter.candidatePid -ErrorAction SilentlyContinue) -and $null -eq $listener){return};Start-Sleep -Milliseconds 250}while((Get-Date)-lt $deadline);throw 'CANDIDATE_STOP_UNSAFE'}.GetNewClosure()
 $adapter.RestoreWatchdog={if($adapter.watchdogBackup){Copy-Item -LiteralPath (Join-Path $adapter.watchdogBackup '*') -Destination $runtimeDir -Force -ErrorAction Stop}}.GetNewClosure()
 $adapter.RestoreR3={if($null -eq $adapter.r3Runtime){throw 'R3_RESTORE_RUNTIME_MISSING'};$previous=$env:C2C_STATE_DIR;try{$env:C2C_STATE_DIR=$C2CStateDir;Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList @($OldGatewayCli,'serve','--workspace',$Workspace,'--port',$Port) -WindowStyle Hidden|Out-Null}finally{if($null -eq $previous){Remove-Item Env:C2C_STATE_DIR -ErrorAction SilentlyContinue}else{$env:C2C_STATE_DIR=$previous}};$deadline=(Get-Date).AddSeconds(25);do{if($adapter.TestLocalHealth.Invoke()){return};Start-Sleep -Milliseconds 250}while((Get-Date)-lt $deadline);throw 'R3_RESTORE_HEALTH_TIMEOUT'}.GetNewClosure()
 return $adapter
}
$adapter=New-ProductionAdapter
Invoke-CutoverStateMachine $adapter|ConvertTo-Json -Compress
