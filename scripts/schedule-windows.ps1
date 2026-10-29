# Registers a Windows scheduled task that makes and publishes one Hồi Sau
# episode a day. Run once from the repo folder in PowerShell:
#
#   powershell -ExecutionPolicy Bypass -File scripts\schedule-windows.ps1 -At 19:00
#   powershell -ExecutionPolicy Bypass -File scripts\schedule-windows.ps1 -Mock      # offline rehearsal into data-demo\
#   powershell -ExecutionPolicy Bypass -File scripts\schedule-windows.ps1 -Remove
#
# The task runs `npm run pipeline -- run` and appends to logs\pipeline.log.
# A day that already has an episode is skipped, so running it twice is safe.
# "StartWhenAvailable" runs a missed slot as soon as the PC is back on.

param(
  [string]$At = "19:00",
  [switch]$Mock,
  [switch]$Remove,
  [string]$Name = "HoiSau daily episode"
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path "$PSScriptRoot\..").Path

if ($Remove) {
  Unregister-ScheduledTask -TaskName $Name -Confirm:$false
  Write-Host "Removed '$Name'."
  exit 0
}

$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npm) { throw "npm not found. Install Node.js 20+ first." }
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue) -and -not $env:FFMPEG_PATH) {
  Write-Warning "ffmpeg is not on PATH. Install it (winget install Gyan.FFmpeg) or set FFMPEG_PATH and FFPROBE_PATH in .env."
}

New-Item -ItemType Directory -Force -Path "$repo\logs" | Out-Null
$flags = if ($Mock) { "--mock" } else { "" }
$cmd = "cd /d `"$repo`" && `"$npm`" run pipeline -- run $flags >> logs\pipeline.log 2>&1"

$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c $cmd"
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2) -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 15)
Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Settings $settings -Description "Hồi Sau: comments → episode → motion comic → Facebook, Instagram, Threads" -Force | Out-Null

Write-Host "Scheduled '$Name' every day at $At (this PC's clock; set Windows to UTC+07 Hanoi). Log: $repo\logs\pipeline.log"
Write-Host "Run it now to test: Start-ScheduledTask -TaskName '$Name'"
