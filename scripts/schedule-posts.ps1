# Schedules approved clips to post at given times with Windows Task Scheduler, each running scripts\post-clip.ps1.
# The plan file has one line per clip, "yyyy-MM-dd HH:mm <post id>" in local time; blank lines and # comments are ignored.
#   powershell -ExecutionPolicy Bypass -File scripts\schedule-posts.ps1 -Plan data\post-plan.txt
#   powershell -ExecutionPolicy Bypass -File scripts\schedule-posts.ps1 -Remove
# Tasks live under \HoiSau\ and wake the computer from sleep; it must not be shut down.
param([string]$Plan = "data\post-plan.txt", [switch]$Remove)
$repo = (Resolve-Path "$PSScriptRoot\..").Path
if ($Remove) {
  Get-ScheduledTask -TaskPath "\HoiSau\" -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false
  Write-Output "Removed the \HoiSau\ posting tasks."; exit 0
}
$script = Join-Path $PSScriptRoot "post-clip.ps1"
$settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1)
foreach ($line in Get-Content (Join-Path $repo $Plan) -Encoding utf8) {
  $line = $line.Trim()
  if (-not $line -or $line.StartsWith("#")) { continue }
  $date, $time, $id = $line -split "\s+", 3
  $at = [datetime]::ParseExact("$date $time", "yyyy-MM-dd HH:mm", $null)
  if ($at -lt (Get-Date)) { Write-Output "skip ${id}: $date $time has passed"; continue }
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`" $id" -WorkingDirectory $repo
  Register-ScheduledTask -TaskName "HoiSau post $id" -TaskPath "\HoiSau\" -Action $action -Trigger (New-ScheduledTaskTrigger -Once -At $at) -Settings $settings -Force | Out-Null
}
Get-ScheduledTask -TaskPath "\HoiSau\" | ForEach-Object { "{0}  ->  {1}" -f $_.TaskName, ($_ | Get-ScheduledTaskInfo).NextRunTime }
