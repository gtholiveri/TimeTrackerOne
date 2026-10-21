<#
Copies this computer's ActivityWatch to the relay, now and at every login
(ttserver/mirror.py). In PowerShell:

    cd <your TimeTrackerOne folder>\server
    powershell -ExecutionPolicy Bypass -File deploy\desktop-mirror.ps1 -Relay https://<app>.fly.dev -Key <TT_KEY>

Needs Python 3 (the `py` launcher) and ActivityWatch installed and running.
It runs one pass in this window first, so you see any problem, then starts
the mirror in the background and adds it to your Startup folder. Run it
again to change the relay or key; it replaces the running copy. To stop it
for good, delete "TimeTracker mirror" from the Startup folder (Win+R,
shell:startup) and end pythonw.exe in Task Manager.
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
$startup = [Environment]::GetFolderPath("Startup")
$link = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $startup "TimeTracker mirror.lnk"))
$link.TargetPath = $pythonw
$link.Arguments = $arguments
$link.WorkingDirectory = $server
$link.WindowStyle = 7  # minimized
$link.Save()

Start-Process -FilePath $pythonw -ArgumentList $arguments -WorkingDirectory $server -WindowStyle Hidden
Write-Host "Mirror running in the background and added to Startup. Log: $log"
