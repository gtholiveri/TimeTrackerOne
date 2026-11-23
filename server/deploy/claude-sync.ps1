<#
Sends this computer's Claude conversations to the relay every 10 minutes
(ttserver/claudesync.py), so the timeline can say what each stretch in
Claude was actually about. In PowerShell:

    cd <your TimeTrackerOne folder>\server
    powershell -ExecutionPolicy Bypass -File deploy\claude-sync.ps1

Uses the TT_RELAY_URL and TT_KEY user environment variables (the one key) and
the Claude Code login on this computer. Runs one pass here first (the first
one goes back 30 days), then registers the scheduled task "TimeTracker
Claude sync". Run it again to replace the task. To stop it:
Unregister-ScheduledTask "TimeTracker Claude sync".
#>
$ErrorActionPreference = "Stop"
$server = Split-Path -Parent $PSScriptRoot
Set-Location $server
$relay = [Environment]::GetEnvironmentVariable("TT_RELAY_URL", "User")
$key = [Environment]::GetEnvironmentVariable("TT_KEY", "User")
if (-not $relay -or -not $key) { throw "Set the TT_RELAY_URL and TT_KEY user environment variables first." }
$env:TT_RELAY_URL = $relay
$env:TT_KEY = $key

$python = (& py -3 -c "import sys; print(sys.executable)").Trim()
if ($LASTEXITCODE -ne 0 -or -not $python) { throw "Python 3 not found. Install it from python.org (with the py launcher)." }
$pythonw = Join-Path (Split-Path $python) "pythonw.exe"
if (-not (Test-Path $pythonw)) { $pythonw = $python }

$dir = Join-Path $env:LOCALAPPDATA "tt-mirror"
New-Item -ItemType Directory -Force $dir | Out-Null
$log = Join-Path $dir "claude-sync.log"

Write-Host "First pass (up to 30 days of conversations)..."
& $python -m ttserver.claudesync
if ($LASTEXITCODE -ne 0) { throw "The first pass failed; see above." }

$every10 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 9) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$task = Register-ScheduledTask -TaskName "TimeTracker Claude sync" -Force `
    -Description "Sends Claude conversations to the TimeTracker relay (server/deploy/claude-sync.ps1)." `
    -Action (New-ScheduledTaskAction -Execute $pythonw -Argument "-m ttserver.claudesync --log `"$log`"" -WorkingDirectory $server) `
    -Trigger $every10 -Settings $settings
Write-Host "Registered '$($task.TaskName)', every 10 minutes. Log: $log"
