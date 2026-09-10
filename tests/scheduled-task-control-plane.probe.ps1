param(
 [switch]$Worker,
 [ValidateSet('Create','Delete','Query','Run','End','Get','Start','Stop')][string]$Operation,
 [string]$TaskName,
 [int]$TimeoutSeconds=10
)
$ErrorActionPreference='Stop'

function Get-TaskParts([string]$Name) {
 if($Name -notmatch '^(.*\\)([^\\]+)$'){throw "TASK_NAME_INVALID:$Name"}
 [pscustomobject]@{path=$Matches[1];leaf=$Matches[2]}
}
function Invoke-WorkerOperation {
 $parts=Get-TaskParts $TaskName
 switch($Operation) {
  'Create' {& schtasks.exe /Create /TN $TaskName /SC ONCE /ST 23:59 /TR 'cmd.exe /c ping 127.0.0.1 -n 120 >nul' /F;break}
  'Delete' {& schtasks.exe /Delete /TN $TaskName /F;break}
  'Query' {& schtasks.exe /Query /TN $TaskName;break}
  'Run' {& schtasks.exe /Run /TN $TaskName;break}
  'End' {& schtasks.exe /End /TN $TaskName;break}
  'Get' {Get-ScheduledTask -TaskPath $parts.path -TaskName $parts.leaf -ErrorAction Stop|Out-Null;break}
  'Start' {Start-ScheduledTask -TaskPath $parts.path -TaskName $parts.leaf -ErrorAction Stop;break}
  'Stop' {Stop-ScheduledTask -TaskPath $parts.path -TaskName $parts.leaf -ErrorAction Stop;break}
 }
 exit $LASTEXITCODE
}
function Quote-Argument([string]$Value) {'"'+$Value.Replace('"','\\"')+'"'}
function Invoke-Bounded([string]$Interface,[string]$RequestedOperation) {
 $started=Get-Date
 $arguments="-NoProfile -NonInteractive -ExecutionPolicy Bypass -File $(Quote-Argument $PSCommandPath) -Worker -Operation $RequestedOperation -TaskName $(Quote-Argument $TaskName)"
 $process=New-Object System.Diagnostics.Process
 $process.StartInfo=New-Object System.Diagnostics.ProcessStartInfo
 $process.StartInfo.FileName='powershell.exe';$process.StartInfo.Arguments=$arguments;$process.StartInfo.UseShellExecute=$false;$process.StartInfo.RedirectStandardOutput=$true;$process.StartInfo.RedirectStandardError=$true;$process.StartInfo.CreateNoWindow=$true
 [void]$process.Start()
 $completed=$process.WaitForExit($TimeoutSeconds*1000)
 if(-not $completed){try{$process.Kill()}catch{};$null=$process.WaitForExit(5000)}
 $stdout=$process.StandardOutput.ReadToEnd();$stderr=$process.StandardError.ReadToEnd();$ended=Get-Date
 [pscustomobject]@{interface=$Interface;operation=$RequestedOperation;startedAt=$started.ToString('o');endedAt=$ended.ToString('o');durationMs=[int]($ended-$started).TotalMilliseconds;result=if($completed -and $process.ExitCode -eq 0){'PASS'}elseif(-not $completed){'HANG'}else{'FAIL'};exitCode=if($completed){$process.ExitCode}else{$null};stdout=$stdout.Trim();stderr=$stderr.Trim()}
}
if($Worker){Invoke-WorkerOperation;exit $LASTEXITCODE}

$TaskName='\C2C-Isolated-ControlPlane-'+[guid]::NewGuid().ToString('N')
$results=@();$cleanup='NOT_RUN'
try {
 $results+=Invoke-Bounded 'SCHTASKS_EXE' 'Create'
 if($results[-1].result -ne 'PASS'){throw 'TEMP_TASK_CREATE_FAILED'}
 foreach($operation in @('Get','Start','Stop')){$results+=Invoke-Bounded 'POWERSHELL_SCHEDULEDTASKS' $operation}
 foreach($operation in @('Query','Run','End')){$results+=Invoke-Bounded 'SCHTASKS_EXE' $operation}
} finally {
 $delete=Invoke-Bounded 'SCHTASKS_EXE' 'Delete';$cleanup=$delete.result;$results+=$delete
}
$service=Get-Service -Name Schedule -ErrorAction SilentlyContinue
[pscustomobject]@{taskName=$TaskName;taskSchedulerService=if($service -and $service.Status -eq 'Running'){'RUNNING'}else{'NOT_RUNNING_OR_UNAVAILABLE'};powerShellScheduledTasks=if(@($results|Where-Object {$_.interface -eq 'POWERSHELL_SCHEDULEDTASKS' -and $_.result -eq 'HANG'}).Count -gt 0){'HANG'}elseif(@($results|Where-Object {$_.interface -eq 'POWERSHELL_SCHEDULEDTASKS' -and $_.result -ne 'PASS'}).Count -gt 0){'FAIL'}else{'PASS'};schtasksExe=if(@($results|Where-Object {$_.interface -eq 'SCHTASKS_EXE' -and $_.operation -in @('Query','Run','End') -and $_.result -eq 'HANG'}).Count -gt 0){'HANG'}elseif(@($results|Where-Object {$_.interface -eq 'SCHTASKS_EXE' -and $_.operation -in @('Query','Run','End') -and $_.result -ne 'PASS'}).Count -gt 0){'FAIL'}else{'PASS'};cleanup=$cleanup;results=$results}|ConvertTo-Json -Depth 5
