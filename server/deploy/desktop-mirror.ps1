<#
Copies this computer's ActivityWatch to the relay, now and at every login
(ttserver/mirror.py). In PowerShell:

    cd <your TimeTrackerOne folder>\server
    powershell -ExecutionPolicy Bypass -File deploy\desktop-mirror.ps1 -Relay https://<app>.fly.dev -Key <TT_KEY>

Needs Python 3 (the `py` launcher) and ActivityWatch installed and running.
It runs one pass in this window first, so you see any problem, then registers
a scheduled task, "TimeTracker mirror", that runs the mirror in the
background: a minute after each login (once OneDrive, which may hold this
folder, is up), and every 5 minutes after that if it isn't running. Run it
again to change the relay or key; it replaces the running copy. To stop it
for good: Unregister-ScheduledTask "TimeTracker mirror", then end pythonw.exe
in Task Manager.

(It used to be a Startup-folder shortcut. That started before OneDrive's
files were readable and failed silently, and nothing brought back a mirror
that had stopped.)
#>
param(
    [Parameter(Mandatory = $true)][string]$Relay,
    [Parameter(Mandatory = $true)][string]$Key
)
$ErrorActionPreference = "Stop"
$server = Split-Path -Parent $PSScriptRoot
Set-Location $server

$python = (& py -3 -c "import sys; print(sys.executable)").Trim()
if ($LASTEXITCODE -ne 0 -or -not $python) { throw "Python 3 not found. Install it from python.org (with the py launcher)." }
$pythonw = Join-Path (Split-Path $python) "pythonw.exe"
if (-not (Test-Path $pythonw)) { $pythonw = $python }

$dir = Join-Path $env:LOCALAPPDATA "tt-mirror"
New-Item -ItemType Directory -Force $dir | Out-Null
$state = Join-Path $dir "state.json"
$log = Join-Path $dir "mirror.log"

# Only one copy may run: two would insert the same events twice.
Get-CimInstance Win32_Process -Filter "Name like 'python%'" |
    Where-Object { $_.CommandLine -like "*ttserver.mirror*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Write-Host "First pass (copies up to 30 days of history, so it can take a minute)..."
& $python -m ttserver.mirror --relay $Relay --key $Key --state $state --once
if ($LASTEXITCODE -ne 0) { throw "The first pass failed; see above." }

$arguments = "-m ttserver.mirror --relay `"$Relay`" --key `"$Key`" --state `"$state`" --log `"$log`""
$oldLink = Join-Path ([Environment]::GetFolderPath("Startup")) "TimeTracker mirror.lnk"
if (Test-Path $oldLink) { Remove-Item $oldLink }

$atLogon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$atLogon.Delay = "PT1M"
$every5 = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
# IgnoreNew: the 5-minute trigger starts the mirror only when it isn't running.
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$task = Register-ScheduledTask -TaskName "TimeTracker mirror" -Force `
    -Description "Copies this computer's ActivityWatch to the TimeTracker relay (server/deploy/desktop-mirror.ps1)." `
    -Action (New-ScheduledTaskAction -Execute $pythonw -Argument $arguments -WorkingDirectory $server) `
    -Trigger $atLogon, $every5 -Settings $settings
Start-ScheduledTask -TaskName $task.TaskName
Write-Host "Mirror running in the background, as the scheduled task 'TimeTracker mirror'. Log: $log"
