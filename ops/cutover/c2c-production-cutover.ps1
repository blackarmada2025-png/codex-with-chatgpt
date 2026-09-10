param(
 [Parameter(Mandatory=$true)][string]$CandidateCli,
 [Parameter(Mandatory=$true)][string]$OldGatewayCli,
 [Parameter(Mandatory=$true)][string]$C2CStateDir,
 [Parameter(Mandatory=$true)][string]$Workspace,
 [Parameter(Mandatory=$true)][string]$WorkspaceId,
 [int]$Port=48765,
 [switch]$DryRun,
 [string]$ContractFixture,
 [switch]$ContractTest
)
$ErrorActionPreference='Stop'
function Test-RuntimeBindingCheckpoint([int]$CandidatePid) {
 $file=Join-Path $C2CStateDir (Join-Path 'runtime' "$WorkspaceId.json")
 if(-not(Test-Path -LiteralPath $file)){throw 'RUNTIME_BINDING_FILE_MISSING'}
 $r=Get-Content -LiteralPath $file -Raw|ConvertFrom-Json
 if([int]$r.pid -ne $CandidatePid){throw 'RUNTIME_BINDING_PID_MISMATCH'}
 if([int]$r.port -ne $Port){throw 'RUNTIME_BINDING_PORT_MISMATCH'}
 if([string]$r.workspaceId -ne $WorkspaceId){throw 'RUNTIME_BINDING_WORKSPACE_MISMATCH'}
 [pscustomobject]@{ok=$true;checkpoint='AFTER_CANDIDATE_START_BEFORE_WATCHDOG';runtimeFile=$file;pid=$r.pid;port=$r.port;workspaceId=$r.workspaceId}
}
function Invoke-CutoverRollback($adapter,$stage,$trigger) {
 $adapter.events += "rollback:${stage}:${trigger}"
 $adapter.StopCandidate.Invoke(); $adapter.RestoreR3.Invoke(); $adapter.RestoreWatchdog.Invoke()
 if(-not $adapter.TestLocalHealth.Invoke() -or -not $adapter.TestPublicHealth.Invoke()){throw 'ROLLBACK_HEALTH_FAILED'}
 [pscustomobject]@{result='ROLLED_BACK';failureStage=$stage;rollbackTrigger=$trigger;rollbackResult='PASS'}
}
function Invoke-CutoverStateMachine($adapter) {
 $stage='PRECHECK'
 try {
  if(-not $adapter.Preflight.Invoke()){throw 'PREFLIGHT_FAILED'}
  $stage='START_CANDIDATE'; if(-not $adapter.StartCandidate.Invoke()){throw 'CANDIDATE_START_FAILED'}
  $stage='RUNTIME_CHECKPOINT'; if(-not $adapter.Checkpoint.Invoke()){throw 'RUNTIME_BINDING_FAILED'}
  $stage='WATCHDOG_HANDOFF'; if(-not $adapter.HandoffWatchdog.Invoke()){throw 'WATCHDOG_HANDOFF_FAILED'}
  $stage='PUBLIC_HEALTH'; if(-not $adapter.TestPublicHealth.Invoke()){throw 'PUBLIC_HEALTH_FAILED'}
  $stage='AUTHSTORE'; if(-not $adapter.AuthStoreIntegrity.Invoke()){throw 'AUTHSTORE_INTEGRITY_FAILED'}
  [pscustomobject]@{result='PASS';failureStage=$null;rollbackTrigger=$null;rollbackResult=$null;events=$adapter.events}
 } catch { $r=Invoke-CutoverRollback $adapter $stage $_.Exception.Message; $r|Add-Member NoteProperty events $adapter.events; return $r }
}
if($ContractTest){$f=Get-Content $ContractFixture -Raw|ConvertFrom-Json;$publicCalls=0;$a=[pscustomobject]@{events=@();Preflight={ $f.preflight };StartCandidate={ $f.start };Checkpoint={ $f.checkpoint };HandoffWatchdog={ $f.watchdog };TestLocalHealth={ $f.local };TestPublicHealth={ $script:publicCalls++;if($script:publicCalls -gt 1 -and $null -ne $f.rollbackPublic){$f.rollbackPublic}else{$f.public} };AuthStoreIntegrity={ $f.auth };StopCandidate={};RestoreR3={};RestoreWatchdog={}};Invoke-CutoverStateMachine $a|ConvertTo-Json -Compress;exit 0}
if($DryRun){
 foreach($file in @($CandidateCli,$OldGatewayCli)){if(-not(Test-Path -LiteralPath $file)){throw "REQUIRED_FILE_MISSING:$file"}}
 if(-not(Test-Path -LiteralPath (Join-Path $C2CStateDir 'auth'))){throw 'FORMAL_STATE_AUTH_MISSING'}
 [pscustomobject]@{ok=$true;mode='DRY_RUN';stateDir=(Resolve-Path $C2CStateDir).Path;checkpointPosition='AFTER_CANDIDATE_START_BEFORE_WATCHDOG';rollbackTarget=$OldGatewayCli}|ConvertTo-Json -Compress
 exit 0
}
function New-ProductionAdapter {
 $runtimeDir='C:\Users\Administrator\AppData\Local\codex-with-chatgpt\watchdog';$cfg=Join-Path $runtimeDir 'c2c-production-watchdog.config.json';$script=Join-Path $runtimeDir 'orbnexa-vault-c2c-prod-watchdog.ps1';$auth=Join-Path $C2CStateDir (Join-Path 'auth' "$WorkspaceId.json")
 [pscustomobject]@{events=@();Preflight={ (Test-Path $CandidateCli) -and (Test-Path $OldGatewayCli) -and (Test-Path $auth) };StartCandidate={ $env:C2C_STATE_DIR=$C2CStateDir;$o=& 'C:\Program Files\nodejs\node.exe' $CandidateCli start --workspace $Workspace --port $Port --json 2>&1;$env:C2C_STATE_DIR=$null;if($LASTEXITCODE){return $false};$script:cutoverPid=($o|ConvertFrom-Json).pid;return $true };Checkpoint={ Test-RuntimeBindingCheckpoint $script:cutoverPid|Out-Null;return $true };HandoffWatchdog={ $script:watchdogBackup=Join-Path $env:TEMP ('c2c-cutover-'+[guid]::NewGuid());New-Item -ItemType Directory $script:watchdogBackup|Out-Null;Copy-Item $cfg,$script -Destination $script:watchdogBackup;& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot '..\..\scripts\install-production-watchdog.ps1') -GatewayCli $CandidateCli -C2CStateDir $C2CStateDir|Out-Null;return $true };TestLocalHealth={try{(Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 8).workspaceId -eq $WorkspaceId}catch{$false}};TestPublicHealth={try{(Invoke-RestMethod 'https://vault.orbnexa.com/health' -TimeoutSec 15).workspaceId -eq $WorkspaceId}catch{$false}};AuthStoreIntegrity={ (Test-Path $auth) };StopCandidate={if($script:cutoverPid){Stop-Process -Id $script:cutoverPid -Force -ErrorAction SilentlyContinue}};RestoreR3={Start-Process 'C:\Program Files\nodejs\node.exe' -ArgumentList @($OldGatewayCli,'serve','--workspace',$Workspace,'--port',$Port)|Out-Null};RestoreWatchdog={if($script:watchdogBackup){Copy-Item (Join-Path $script:watchdogBackup '*') -Destination $runtimeDir -Force}} }
}
$adapter=New-ProductionAdapter
Invoke-CutoverStateMachine $adapter|ConvertTo-Json -Compress
