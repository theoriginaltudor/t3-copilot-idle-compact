<#
.SYNOPSIS
  Install t3-copilot-idle-compact as a hidden background Windows Scheduled Task
  that starts automatically when you sign in.
#>
param(
  [int]$MinTokens = 200000,
  [int]$IdleMinSec = 240,
  [int]$IdleMaxSec = 285,
  [int]$PollSec = 15
)

$ErrorActionPreference = "Stop"

$TaskName = "T3CopilotIdleCompact"
$RepoDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Entry = Join-Path $RepoDir "bin\t3-copilot-idle-compact.mjs"
$NodeBin = (Get-Command node.exe -ErrorAction Stop).Source

$AppDataDir = Join-Path $env:LOCALAPPDATA "t3-copilot-idle-compact"
New-Item -ItemType Directory -Force -Path $AppDataDir | Out-Null

$LogFile = Join-Path $AppDataDir "watcher.log"
$RunnerCmd = Join-Path $AppDataDir "run-watcher.cmd"
$LauncherVbs = Join-Path $AppDataDir "launch-hidden.vbs"

# Wrapper .cmd redirects stdout/stderr to the log file cleanly
$CmdContent = @"
@echo off
"$NodeBin" --no-warnings "$Entry" --min-tokens $MinTokens --idle-min $IdleMinSec --idle-max $IdleMaxSec --poll $PollSec >> "$LogFile" 2>&1
"@
Set-Content -Path $RunnerCmd -Value $CmdContent -Encoding ASCII

# Tiny WScript wrapper avoids any console window flashing on Windows logon
$VbsContent = @"
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """$RunnerCmd""", 0, False
"@
Set-Content -Path $LauncherVbs -Value $VbsContent -Encoding ASCII

$Action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$LauncherVbs`""
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Settings $Settings `
  -Description "Auto-compact idle GitHub Copilot CLI threads in T3 Code before the 5-minute prompt cache expires." `
  -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName

Write-Host "Installed and started Windows Scheduled Task '$TaskName'"
Write-Host "  Node : $NodeBin"
Write-Host "  Logs : $LogFile"
