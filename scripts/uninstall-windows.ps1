<#
.SYNOPSIS
  Stop and remove the t3-copilot-idle-compact Windows Scheduled Task.
#>
$ErrorActionPreference = "SilentlyContinue"

$TaskName = "T3CopilotIdleCompact"
$AppDataDir = Join-Path $env:LOCALAPPDATA "t3-copilot-idle-compact"

Stop-ScheduledTask -TaskName $TaskName
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false

# Terminate any running watcher node process matching this script
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like "*t3-copilot-idle-compact.mjs*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Remove-Item -Path (Join-Path $AppDataDir "run-watcher.cmd") -Force
Remove-Item -Path (Join-Path $AppDataDir "launch-hidden.vbs") -Force

Write-Host "Uninstalled Windows Scheduled Task '$TaskName'"
