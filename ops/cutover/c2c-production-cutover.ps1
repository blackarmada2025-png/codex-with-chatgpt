param(
 [Parameter(Mandatory=$true)][string]$CandidateCli,
 [Parameter(Mandatory=$true)][string]$OldGatewayCli,
 [Parameter(Mandatory=$true)][string]$C2CStateDir,
 [string]$LegacyC2CStateDir=$C2CStateDir,
 [Parameter(Mandatory=$true)][string]$Workspace,
 [Parameter(Mandatory=$true)][string]$WorkspaceId,
 [int]$Port=48765,
 [string]$WatchdogRuntimeDirectory='C:\Users\Administrator\AppData\Local\codex-with-chatgpt\watchdog',
 [string]$ScheduledTaskName='\CodexWithChatGPT\Orbnexa Vault C2C Prod Watchdog',
 [switch]$SimulatePublicNetwork,
 [switch]$IsolatedTestMode,
 [switch]$DryRun,
 [string]$SnapshotScript,
 [string]$ContractFixture,
 [switch]$ContractTest
)
$ErrorActionPreference='Stop'
if([string]::IsNullOrWhiteSpace($SnapshotScript)){$SnapshotScript=Join-Path $PSScriptRoot '..\dr\c2c-light-recovery-snapshot.ps1'}

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
function Test-AuthStoreContinuity($Legacy,$Formal) {return ($Legacy.sha256 -eq $Formal.sha256 -and $Legacy.clientCount -eq $Formal.clientCount -and $Legacy.tokenCount -eq $Formal.tokenCount)}
function Normalize-PathIdentity([string]$Path) {return [System.IO.Path]::GetFullPath($Path).TrimEnd([System.IO.Path]::DirectorySeparatorChar,[System.IO.Path]::AltDirectorySeparatorChar)}
function Get-ProcessCommandLine([int]$ProcessId) {$process=Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue;if($null -eq $process){return $null};return [string]$process.CommandLine}
function Invoke-SchtasksControl([ValidateSet('Query','End','Run')][string]$Operation,[string]$TaskName) {
 if($TaskName -notmatch '^(.*\\)([^\\]+)$'){throw "SCHEDULED_TASK_NAME_INVALID:$TaskName"}
 $arguments=if($Operation -eq 'Query'){"/Query /TN `"$TaskName`" /XML"}else{"/$Operation /TN `"$TaskName`""}
 $process=New-Object System.Diagnostics.Process
 $process.StartInfo=New-Object System.Diagnostics.ProcessStartInfo
 $process.StartInfo.FileName='schtasks.exe';$process.StartInfo.Arguments=$arguments;$process.StartInfo.UseShellExecute=$false;$process.StartInfo.RedirectStandardOutput=$true;$process.StartInfo.RedirectStandardError=$true;$process.StartInfo.CreateNoWindow=$true
 [void]$process.Start();$completed=$process.WaitForExit(10000)
 if(-not $completed){try{$process.Kill()}catch{};$null=$process.WaitForExit(5000);throw "SCHTASKS_${Operation}_TIMEOUT"}
 $stdout=$process.StandardOutput.ReadToEnd();$stderr=$process.StandardError.ReadToEnd()
 if($process.ExitCode -ne 0){throw "SCHTASKS_${Operation}_FAILED:$stderr$stdout"}
 return $stdout
}
function Get-ExactScheduledTask([string]$TaskName) {
 if($TaskName -notmatch '^(.*\\)([^\\]+)$'){throw "SCHEDULED_TASK_NAME_INVALID:$TaskName"}
 try {[xml]$xml=Invoke-SchtasksControl Query $TaskName}catch{throw "SCHEDULED_TASK_NOT_FOUND:$TaskName"}
 $exec=$xml.Task.Actions.Exec
 if($null -eq $exec){throw "SCHEDULED_TASK_ACTION_MISSING:$TaskName"}
 [pscustomobject]@{TaskName=$Matches[2];TaskPath=$Matches[1];Execute=[string]$exec.Command;Arguments=[string]$exec.Arguments}
}
function Test-WatchdogDefaultConfigPath([string]$RuntimeScript,[string]$RuntimeConfig) {
 if(-not(Test-Path -LiteralPath $RuntimeScript -PathType Leaf) -or -not(Test-Path -LiteralPath $RuntimeConfig -PathType Leaf)){return $false}
 $expected=Join-Path (Split-Path -Parent $RuntimeScript) 'c2c-production-watchdog.config.json'
 if((Normalize-PathIdentity $expected) -ne (Normalize-PathIdentity $RuntimeConfig)){return $false}
 try {$source=Get-Content -LiteralPath $RuntimeScript -Raw -ErrorAction Stop}catch{return $false}
 return $source -match '(?s)\[string\]\s*\$ConfigPath\s*=\s*\(\s*Join-Path\s+\$PSScriptRoot\s+[\x27\x22]c2c-production-watchdog\.config\.json[\x27\x22]\s*\)'
}
function Test-WatchdogInvocation([string]$Arguments,[string]$RuntimeScript,[string]$RuntimeConfig) {
 if($Arguments -notlike "*$RuntimeScript*"){return $false}
 if($Arguments -like "*$RuntimeConfig*"){return $true}
 if($Arguments -match '(?i)(?:^|\s)-ConfigPath(?:\s|$)'){return $false}
 return Test-WatchdogDefaultConfigPath $RuntimeScript $RuntimeConfig
}
function Test-ScheduledTaskAction($Task,[string]$RuntimeScript,[string]$RuntimeConfig) {
 return ([string]$Task.Execute -match '(?i)(powershell|pwsh)(\.exe)?$' -and (Test-WatchdogInvocation ([string]$Task.Arguments) $RuntimeScript $RuntimeConfig))
}
function Get-WatchdogProcess([string]$RuntimeScript,[string]$RuntimeConfig) {
 @((Get-CimInstance Win32_Process -ErrorAction Stop|Where-Object { $_.Name -match '^(?i:powershell|pwsh)\.exe$' -and (Test-WatchdogInvocation ([string]$_.CommandLine) $RuntimeScript $RuntimeConfig) }))
}
function Get-BoundWatchdogProcess($Task,[string]$RuntimeScript,[string]$RuntimeConfig) {
 if(-not(Test-ScheduledTaskAction $Task $RuntimeScript $RuntimeConfig)){throw 'SCHEDULED_TASK_ACTION_MISMATCH'}
 $processes=Get-WatchdogProcess $RuntimeScript $RuntimeConfig
 if(@($processes).Count -ne 1){throw "WATCHDOG_PROCESS_BINDING_INVALID:$(@($processes).Count)"}
 return $processes[0]
}
function Test-WatchdogAbsent([string]$RuntimeScript,[string]$RuntimeConfig,[int]$WindowSeconds=2) {
 $deadline=(Get-Date).AddSeconds($WindowSeconds)
 do {if(@(Get-WatchdogProcess $RuntimeScript $RuntimeConfig).Count -ne 0){return $false};Start-Sleep -Milliseconds 250}while((Get-Date)-lt $deadline)
 return $true
}
function Wait-ProcessExit([int]$ProcessId,[int]$TimeoutSeconds,[string]$Failure) {
 $deadline=(Get-Date).AddSeconds($TimeoutSeconds)
 do {if($null -eq(Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)){return $true};Start-Sleep -Milliseconds 250} while((Get-Date)-lt $deadline)
 throw $Failure
}
function Test-PortReleased([int]$ExpectedPort) {return $null -eq (Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $ExpectedPort -State Listen -ErrorAction SilentlyContinue|Select-Object -First 1)}
function Invoke-ScheduledTaskControl([ValidateSet('Start','Stop')][string]$Operation,[string]$TaskName) {
 Invoke-SchtasksControl $(if($Operation -eq 'Stop'){'End'}else{'Run'}) $TaskName|Out-Null
}
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
 try {if($adapter.candidatePid){$adapter.PauseWatchdog.Invoke()|Out-Null;$adapter.StopCandidate.Invoke()|Out-Null;$adapter.VerifyPortReleased.Invoke()|Out-Null};if($adapter.watchdogBackup){$adapter.RestoreWatchdog.Invoke()|Out-Null};if($adapter.r3Runtime){$adapter.RestoreR3.Invoke()|Out-Null;$adapter.StartWatchdog.Invoke()|Out-Null;if(-not $adapter.VerifyWatchdogR3.Invoke()){throw 'WATCHDOG_R3_ADOPTION_FAILED'};if(-not $adapter.TestLocalHealth.Invoke() -or -not $adapter.TestTunnel.Invoke() -or (-not $IsolatedTestMode -and -not $adapter.TestPublicHealth.Invoke()) -or -not $adapter.AuthStoreIntegrity.Invoke()){throw 'ROLLBACK_HEALTH_FAILED'}};$adapter.rollbackResult=[pscustomobject]@{result='ROLLED_BACK';failureStage=$stage;rollbackTrigger=$trigger;rollbackResult='PASS'}} catch {$adapter.rollbackResult=[pscustomobject]@{result='ROLLBACK_FAILED';failureStage=$stage;rollbackTrigger=$trigger;rollbackResult=$_.Exception.Message}}
 return $adapter.rollbackResult
}
function Invoke-CutoverStateMachine($adapter) {
 $stage='PRECHECK'
 try {
  if(-not $adapter.Preflight.Invoke()){throw 'PREFLIGHT_FAILED'}
  $stage='PRESERVE_AUTHSTORE';if(-not $adapter.CaptureAuthStore.Invoke()){throw 'AUTHSTORE_CAPTURE_FAILED'}
  $stage='PAUSE_WATCHDOG';if(-not $adapter.PauseWatchdog.Invoke()){throw 'WATCHDOG_PAUSE_FAILED'}
  $stage='STOP_R3';if(-not $adapter.StopR3.Invoke()){throw 'R3_STOP_FAILED'}
  $stage='VERIFY_PORT_RELEASED';if(-not $adapter.VerifyPortReleased.Invoke()){throw 'PORT_NOT_RELEASED'}
  $stage='START_CANDIDATE';if(-not $adapter.StartCandidate.Invoke()){throw 'CANDIDATE_START_FAILED'}
  $stage='RUNTIME_CHECKPOINT';if(-not $adapter.Checkpoint.Invoke()){throw 'RUNTIME_BINDING_FAILED'}
  $stage='WATCHDOG_HANDOFF';if(-not $adapter.HandoffWatchdog.Invoke()){throw 'WATCHDOG_HANDOFF_FAILED'}
  $stage='VERIFY_LOCAL_HEALTH';if(-not $adapter.TestLocalHealth.Invoke()){throw 'LOCAL_HEALTH_FAILED'}
  $stage='VERIFY_TUNNEL';if(-not $adapter.TestTunnel.Invoke()){throw 'TUNNEL_VERIFICATION_FAILED'}
  $stage='VERIFY_PUBLIC_HEALTH';if(-not $adapter.TestPublicHealth.Invoke()){throw 'PUBLIC_HEALTH_FAILED'}
  $stage='AUTHSTORE';if(-not $adapter.AuthStoreIntegrity.Invoke()){throw 'AUTHSTORE_INTEGRITY_FAILED'}
  [pscustomobject]@{result='PASS';failureStage=$null;rollbackTrigger=$null;rollbackResult=$null;events=$adapter.events}
 } catch {$rollback=Invoke-CutoverRollback $adapter $stage $_.Exception.Message;$rollback|Add-Member NoteProperty events $adapter.events -Force;return $rollback}
}
function Invoke-PostCutoverRecoverySnapshot($adapter,$cutoverResult) {
 if($cutoverResult.result -ne 'PASS'){$cutoverResult|Add-Member NoteProperty drSnapshotStatus 'NOT_RUN' -Force;$cutoverResult|Add-Member NoteProperty alertRequired $false -Force;return $cutoverResult}
 try {$adapter.events=@($adapter.events)+'recovery-snapshot:BEGIN';$adapter.RunSnapshot.Invoke()|Out-Null;$adapter.events=@($adapter.events)+'recovery-snapshot:PASS';$cutoverResult|Add-Member NoteProperty drSnapshotStatus 'PASS' -Force;$cutoverResult|Add-Member NoteProperty alertRequired $false -Force} catch {$adapter.events=@($adapter.events)+('recovery-snapshot:FAIL:'+ $_.Exception.Message);$cutoverResult|Add-Member NoteProperty drSnapshotStatus 'FAIL' -Force;$cutoverResult|Add-Member NoteProperty alertRequired $true -Force;$cutoverResult|Add-Member NoteProperty drSnapshotError $_.Exception.Message -Force}
 $cutoverResult|Add-Member NoteProperty events $adapter.events -Force
 return $cutoverResult
}
function Invoke-CutoverWithRecoverySnapshot($adapter) {return Invoke-PostCutoverRecoverySnapshot $adapter (Invoke-CutoverStateMachine $adapter)}
if($ContractTest){if(-not $ContractFixture){throw 'CONTRACT_FIXTURE_REQUIRED'};$f=Get-Content -LiteralPath $ContractFixture -Raw|ConvertFrom-Json;$publicCalls=0;$a=[pscustomobject]@{events=@();rollbackInvoked=$false;rollbackResult=$null;Preflight={ $f.preflight };CaptureAuthStore={ $true };PauseWatchdog={ $true };StopR3={ $true };VerifyPortReleased={ $true };StartCandidate={ $f.start };Checkpoint={ $f.checkpoint };HandoffWatchdog={ $f.watchdog };StartWatchdog={ $true };VerifyWatchdogR3={ $true };TestLocalHealth={ $f.local };TestTunnel={ $true };TestPublicHealth={ $script:publicCalls++;if($script:publicCalls -gt 1 -and $null -ne $f.rollbackPublic){$f.rollbackPublic}else{$f.public} };AuthStoreIntegrity={ $f.auth };RunSnapshot={ if($f.snapshot){return $true};throw 'RECOVERY_SNAPSHOT_FAILED' };StopCandidate={};RestoreR3={};RestoreWatchdog={}};Invoke-CutoverWithRecoverySnapshot $a|ConvertTo-Json -Compress;exit 0}
if($DryRun){foreach($file in @($CandidateCli,$OldGatewayCli)){if(-not(Test-Path -LiteralPath $file -PathType Leaf)){throw "REQUIRED_FILE_MISSING:$file"}};if(-not(Test-Path -LiteralPath (Join-Path $C2CStateDir 'auth') -PathType Container)){throw 'FORMAL_STATE_AUTH_MISSING'};[pscustomobject]@{ok=$true;mode='DRY_RUN';stateDir=(Resolve-Path -LiteralPath $C2CStateDir).Path;checkpointPosition='AFTER_CANDIDATE_START_BEFORE_WATCHDOG';rollbackTarget=$OldGatewayCli}|ConvertTo-Json -Compress;exit 0}
function New-ProductionAdapter {
 $runtimeDir=$WatchdogRuntimeDirectory;$runtimeConfig=Join-Path $runtimeDir 'c2c-production-watchdog.config.json';$runtimeScript=Join-Path $runtimeDir 'orbnexa-vault-c2c-prod-watchdog.ps1';$installer=Join-Path $PSScriptRoot '..\..\scripts\install-production-watchdog.ps1';$targetWatchdogSource=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\watchdog\c2c-production-watchdog.ps1')).Path;$formalAuth=Join-Path $C2CStateDir (Join-Path 'auth' "$WorkspaceId.json");$legacyAuth=Join-Path $LegacyC2CStateDir (Join-Path 'auth' "$WorkspaceId.json");$runtimeFile=Join-Path $C2CStateDir (Join-Path 'runtime' "$WorkspaceId.json");$legacyRuntimeFile=Join-Path $LegacyC2CStateDir (Join-Path 'runtime' "$WorkspaceId.json")
 $adapter=[pscustomobject]@{events=@();rollbackInvoked=$false;rollbackResult=$null;legacyAuthSnapshot=$null;formalAuthSnapshot=$null;watchdogBackup=$null;preWatchdogScriptHash=$null;preWatchdogConfigHash=$null;targetWatchdogSourceHash=$null;candidatePid=$null;r3Runtime=$null;watchdogPid=$null;task=$null;Preflight=$null;CaptureAuthStore=$null;PauseWatchdog=$null;StopR3=$null;VerifyPortReleased=$null;StartCandidate=$null;Checkpoint=$null;HandoffWatchdog=$null;StartWatchdog=$null;VerifyWatchdogR3=$null;TestLocalHealth=$null;TestTunnel=$null;TestPublicHealth=$null;AuthStoreIntegrity=$null;RunSnapshot=$null;StopCandidate=$null;RestoreR3=$null;RestoreWatchdog=$null}
 $adapter.Preflight={foreach($file in @($CandidateCli,$OldGatewayCli,$installer,$targetWatchdogSource,$formalAuth,$legacyAuth,$runtimeConfig,$runtimeScript,$legacyRuntimeFile)){if(-not(Test-Path -LiteralPath $file -PathType Leaf)){throw "PRECHECK_REQUIRED_FILE_MISSING:$file"}};try{$config=Get-Content -LiteralPath $runtimeConfig -Raw|ConvertFrom-Json -ErrorAction Stop;$adapter.task=Get-ExactScheduledTask $ScheduledTaskName;$watchdog=Get-BoundWatchdogProcess $adapter.task $runtimeScript $runtimeConfig;$adapter.watchdogPid=[int]$watchdog.ProcessId;$adapter.preWatchdogScriptHash=Get-Sha256 $runtimeScript;$adapter.preWatchdogConfigHash=Get-Sha256 $runtimeConfig;$adapter.targetWatchdogSourceHash=Get-Sha256 $targetWatchdogSource}catch{throw "PRECHECK_WATCHDOG_BINDING_FAILED:$($_.Exception.Message)"};if([string]$config.workspace -ne $Workspace -or [string]$config.workspaceId -ne $WorkspaceId -or [int]$config.requiredPort -ne $Port -or [string]$config.gatewayCli -ne $OldGatewayCli -or (([string]$config.c2cStateDir) -and [string]$config.c2cStateDir -ne $LegacyC2CStateDir)){throw 'PRECHECK_LEGACY_WATCHDOG_IDENTITY_MISMATCH'};return $true}.GetNewClosure()
 $adapter.CaptureAuthStore={ $adapter.legacyAuthSnapshot=Get-AuthStoreSnapshot $legacyAuth;$adapter.formalAuthSnapshot=Get-AuthStoreSnapshot $formalAuth;if(-not(Test-AuthStoreContinuity $adapter.legacyAuthSnapshot $adapter.formalAuthSnapshot)){throw 'AUTHSTORE_LEGACY_FORMAL_MISMATCH'};return $true }.GetNewClosure()
 $adapter.PauseWatchdog={if($null -eq $adapter.task -or -not $adapter.watchdogPid){throw 'WATCHDOG_PRECHECK_MISSING'};Invoke-ScheduledTaskControl Stop $ScheduledTaskName;Wait-ProcessExit $adapter.watchdogPid 15 'WATCHDOG_STOP_TIMEOUT'|Out-Null;if(-not(Test-WatchdogAbsent $runtimeScript $runtimeConfig)){throw 'WATCHDOG_REAPPEARED_DURING_PAUSE'};return $true}.GetNewClosure()
 $adapter.StopR3={if(-not(Test-Path -LiteralPath $legacyRuntimeFile -PathType Leaf)){throw 'R3_RUNTIME_MISSING'};$r=Get-Content -LiteralPath $legacyRuntimeFile -Raw|ConvertFrom-Json;if([string]$r.workspaceId -ne $WorkspaceId -or [int]$r.port -ne $Port -or -not $r.adminToken){throw 'R3_RUNTIME_IDENTITY_INVALID'};$commandLine=Get-ProcessCommandLine ([int]$r.pid);if(-not [string]::IsNullOrWhiteSpace($commandLine) -and $commandLine -notlike "*$OldGatewayCli*"){throw 'R3_PROCESS_IDENTITY_MISMATCH'};if([string]::IsNullOrWhiteSpace($commandLine) -and -not $IsolatedTestMode){throw 'R3_PROCESS_IDENTITY_UNAVAILABLE'};$adapter.r3Runtime=$r;try{Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/admin/shutdown" -Headers @{Authorization="Bearer $($r.adminToken)"} -TimeoutSec 8|Out-Null}catch{throw 'R3_GRACEFUL_SHUTDOWN_FAILED'};Wait-ProcessExit ([int]$r.pid) 15 'R3_SHUTDOWN_TIMEOUT'|Out-Null;return $true}.GetNewClosure()
 $adapter.VerifyPortReleased={if(-not(Test-PortReleased $Port)){throw 'PORT_NOT_RELEASED'};return $true}.GetNewClosure()
 $adapter.StartCandidate={$previous=$env:C2C_STATE_DIR;try{$env:C2C_STATE_DIR=$C2CStateDir;$output=@(& 'C:\Program Files\nodejs\node.exe' $CandidateCli start --workspace $Workspace --port $Port --json 2>&1);if($LASTEXITCODE -ne 0){throw "CANDIDATE_START_FAILED: $($output -join ' ')"}}finally{if($null -eq $previous){Remove-Item Env:C2C_STATE_DIR -ErrorAction SilentlyContinue}else{$env:C2C_STATE_DIR=$previous}};if(-not(Test-Path -LiteralPath $runtimeFile -PathType Leaf)){throw 'CANDIDATE_RUNTIME_MISSING'};$adapter.candidatePid=[int]((Get-Content -LiteralPath $runtimeFile -Raw|ConvertFrom-Json).pid);return $true}.GetNewClosure()
 $adapter.Checkpoint={Test-RuntimeBindingCheckpoint $adapter.candidatePid|Out-Null;return $true}.GetNewClosure()
 $adapter.HandoffWatchdog={$adapter.watchdogBackup=Join-Path ([System.IO.Path]::GetTempPath()) ('c2c-cutover-'+[guid]::NewGuid().ToString());New-Item -ItemType Directory -Path $adapter.watchdogBackup -ErrorAction Stop|Out-Null;Copy-Item -LiteralPath $runtimeConfig,$runtimeScript -Destination $adapter.watchdogBackup -ErrorAction Stop;$previousConfig=Get-Content -LiteralPath $runtimeConfig -Raw|ConvertFrom-Json;& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -GatewayCli $CandidateCli -RuntimeDirectory $runtimeDir -C2CStateDir $C2CStateDir -Workspace $Workspace -WorkspaceId $WorkspaceId -RequiredPort $Port -Hostname $previousConfig.hostname|Out-Null;if($LASTEXITCODE -ne 0){throw 'WATCHDOG_INSTALL_FAILED'};$installed=Get-Content -LiteralPath $runtimeConfig -Raw|ConvertFrom-Json;if((Get-Sha256 $runtimeScript) -ne $adapter.targetWatchdogSourceHash){throw 'WATCHDOG_TARGET_SCRIPT_HASH_MISMATCH'};if([string]$installed.gatewayCli -ne $CandidateCli -or [string]$installed.c2cStateDir -ne $C2CStateDir -or [string]$installed.workspaceId -ne $WorkspaceId -or [int]$installed.requiredPort -ne $Port -or [string]$installed.hostname -ne [string]$previousConfig.hostname){throw 'WATCHDOG_HANDOFF_VERIFY_FAILED'};$adapter.StartWatchdog.Invoke();return $true}.GetNewClosure()
 $adapter.StartWatchdog={Invoke-ScheduledTaskControl Start $ScheduledTaskName;$deadline=(Get-Date).AddSeconds(20);do{try{$process=Get-BoundWatchdogProcess $adapter.task $runtimeScript $runtimeConfig;if([int]$process.ProcessId -ne [int]$adapter.watchdogPid){$adapter.watchdogPid=[int]$process.ProcessId;return $true}}catch{};Start-Sleep -Milliseconds 250}while((Get-Date)-lt $deadline);throw 'WATCHDOG_START_OR_BINDING_TIMEOUT'}.GetNewClosure()
 $adapter.VerifyWatchdogR3={try{$process=Get-BoundWatchdogProcess $adapter.task $runtimeScript $runtimeConfig;$config=Get-Content -LiteralPath $runtimeConfig -Raw|ConvertFrom-Json;$runtime=Get-Content -LiteralPath $legacyRuntimeFile -Raw|ConvertFrom-Json;$legacyStateBinding=([string]::IsNullOrWhiteSpace([string]$config.c2cStateDir) -or [string]$config.c2cStateDir -eq $LegacyC2CStateDir);return ([int]$process.ProcessId -eq [int]$adapter.watchdogPid -and [string]$config.gatewayCli -eq $OldGatewayCli -and $legacyStateBinding -and (Get-Sha256 $runtimeScript) -eq $adapter.preWatchdogScriptHash -and (Get-Sha256 $runtimeConfig) -eq $adapter.preWatchdogConfigHash -and [int]$runtime.port -eq $Port -and [string]$runtime.workspaceId -eq $WorkspaceId -and -not(Test-PortReleased $Port))}catch{return $false}}.GetNewClosure()
 $adapter.TestLocalHealth={try{$h=Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 8;return ($h.service -eq 'c2c-bridge' -and $h.workspaceId -eq $WorkspaceId)}catch{return $false}}.GetNewClosure()
 $adapter.TestTunnel={if($SimulatePublicNetwork -or $IsolatedTestMode){return $adapter.TestLocalHealth.Invoke()};try{$config=Get-Content -LiteralPath $runtimeConfig -Raw|ConvertFrom-Json;$tunnels=@(Get-CimInstance Win32_Process -ErrorAction Stop|Where-Object {$_.Name -eq 'cloudflared.exe' -and [string]$_.CommandLine -like "*$($config.tunnelId)*" -and [string]$_.CommandLine -like "*$($config.cloudflaredConfig)*"});return @($tunnels).Count -eq 1}catch{return $false}}.GetNewClosure()
 $adapter.TestPublicHealth={if($SimulatePublicNetwork){return $adapter.TestLocalHealth.Invoke()};try{$hostname=(Get-Content -LiteralPath $runtimeConfig -Raw|ConvertFrom-Json).hostname;$h=Invoke-RestMethod -Uri "https://$hostname/health" -TimeoutSec 15;return ($h.service -eq 'c2c-bridge' -and $h.workspaceId -eq $WorkspaceId)}catch{return $false}}.GetNewClosure()
 $adapter.AuthStoreIntegrity={return ((Test-AuthStoreSnapshot $adapter.legacyAuthSnapshot) -and (Test-AuthStoreSnapshot $adapter.formalAuthSnapshot) -and (Test-AuthStoreContinuity $adapter.legacyAuthSnapshot $adapter.formalAuthSnapshot))}.GetNewClosure()
 $adapter.RunSnapshot={if($IsolatedTestMode){return $true};if(-not(Test-Path -LiteralPath $SnapshotScript -PathType Leaf)){throw "RECOVERY_SNAPSHOT_SCRIPT_MISSING:$SnapshotScript"};$match=[regex]::Match($CandidateCli,'(?i)c2c-candidate-([0-9a-f]{7,40})');if(-not $match.Success){throw 'RECOVERY_SNAPSHOT_COMMIT_UNRESOLVED'};$repository=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path;$commit=(& git -C $repository rev-parse $match.Groups[1].Value 2>$null).Trim();if($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$'){throw 'RECOVERY_SNAPSHOT_COMMIT_UNRESOLVED'};& $SnapshotScript -ProductionCommit $commit|Out-Null;if($LASTEXITCODE -ne 0){throw 'RECOVERY_SNAPSHOT_FAILED'};return $true}.GetNewClosure()
 $adapter.StopCandidate={if(-not $adapter.candidatePid){return};try{$r=Get-Content -LiteralPath $runtimeFile -Raw|ConvertFrom-Json;Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/admin/shutdown" -Headers @{Authorization="Bearer $($r.adminToken)"} -TimeoutSec 5|Out-Null}catch{};try{Wait-ProcessExit $adapter.candidatePid 15 'CANDIDATE_STOP_TIMEOUT'|Out-Null}catch{Stop-Process -Id $adapter.candidatePid -Force -ErrorAction Stop;Wait-ProcessExit $adapter.candidatePid 10 'CANDIDATE_STOP_UNSAFE'|Out-Null};return $true}.GetNewClosure()
 $adapter.RestoreWatchdog={if(-not $adapter.watchdogBackup){throw 'WATCHDOG_BACKUP_MISSING'};Get-ChildItem -LiteralPath $adapter.watchdogBackup -File -ErrorAction Stop|Copy-Item -Destination $runtimeDir -Force -ErrorAction Stop;if((Get-Sha256 $runtimeScript) -ne $adapter.preWatchdogScriptHash){throw 'ROLLBACK_WATCHDOG_SCRIPT_HASH_MISMATCH'};if((Get-Sha256 $runtimeConfig) -ne $adapter.preWatchdogConfigHash){throw 'ROLLBACK_WATCHDOG_CONFIG_HASH_MISMATCH'};return $true}.GetNewClosure()
 $adapter.RestoreR3={if($null -eq $adapter.r3Runtime){throw 'R3_RESTORE_RUNTIME_MISSING'};$previous=$env:C2C_STATE_DIR;try{$env:C2C_STATE_DIR=$LegacyC2CStateDir;Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList @($OldGatewayCli,'serve','--workspace',$Workspace,'--port',$Port) -WindowStyle Hidden|Out-Null}finally{if($null -eq $previous){Remove-Item Env:C2C_STATE_DIR -ErrorAction SilentlyContinue}else{$env:C2C_STATE_DIR=$previous}};$deadline=(Get-Date).AddSeconds(25);do{if($adapter.TestLocalHealth.Invoke()){return};Start-Sleep -Milliseconds 250}while((Get-Date)-lt $deadline);throw 'R3_RESTORE_HEALTH_TIMEOUT'}.GetNewClosure()
 return $adapter
}
$adapter=New-ProductionAdapter
Invoke-CutoverWithRecoverySnapshot $adapter|ConvertTo-Json -Compress
