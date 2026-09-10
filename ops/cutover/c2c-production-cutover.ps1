param(
 [Parameter(Mandatory=$true)][string]$CandidateCli,
 [Parameter(Mandatory=$true)][string]$OldGatewayCli,
 [Parameter(Mandatory=$true)][string]$C2CStateDir,
 [Parameter(Mandatory=$true)][string]$Workspace,
 [Parameter(Mandatory=$true)][string]$WorkspaceId,
 [int]$Port=48765,
 [switch]$DryRun
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
if($DryRun){
 foreach($file in @($CandidateCli,$OldGatewayCli)){if(-not(Test-Path -LiteralPath $file)){throw "REQUIRED_FILE_MISSING:$file"}}
 if(-not(Test-Path -LiteralPath (Join-Path $C2CStateDir 'auth'))){throw 'FORMAL_STATE_AUTH_MISSING'}
 [pscustomobject]@{ok=$true;mode='DRY_RUN';stateDir=(Resolve-Path $C2CStateDir).Path;checkpointPosition='AFTER_CANDIDATE_START_BEFORE_WATCHDOG';rollbackTarget=$OldGatewayCli}|ConvertTo-Json -Compress
 exit 0
}
throw 'PRODUCTION_EXECUTION_REQUIRES_EXPLICIT_CUTOVER_GATE'
