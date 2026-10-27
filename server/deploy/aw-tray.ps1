<#
Makes ActivityWatch's tray icon open the TimeTracker dashboard on the relay
(<relay>/app/) from "Open Dashboard" and on double-click, instead of the stock
localhost:5600 page. In PowerShell:

    cd <your TimeTrackerOne folder>\server
    powershell -ExecutionPolicy Bypass -File deploy\aw-tray.ps1 -Relay https://<app>.fly.dev

Needs AutoHotkey v2 and ActivityWatch (aw-qt) installed. It copies
aw-tray.ahk to %LOCALAPPDATA%\tt-tray (not this folder: OneDrive may not be
up yet at login), stops the stock tray, points the Startup-folder
"ActivityWatch" shortcut at the new tray and starts it. The local page stays
one click away as "Open ActivityWatch (local)".

Updating ActivityWatch can put the stock shortcut back; run this again
afterwards. To go back to the stock tray: add -Uninstall.
#>
param(
    [string]$Relay,
    [switch]$Uninstall
)
$ErrorActionPreference = "Stop"

$awDir = Join-Path $env:LOCALAPPDATA "Programs\ActivityWatch"
$awQt = Join-Path $awDir "aw-qt.exe"
if (-not (Test-Path $awQt)) { throw "aw-qt.exe not found in $awDir. Install ActivityWatch first (SETUP.md, step 3)." }

$dir = Join-Path $env:LOCALAPPDATA "tt-tray"
$script = Join-Path $dir "aw-tray.ahk"
$link = Join-Path ([Environment]::GetFolderPath("Startup")) "ActivityWatch.lnk"

function Stop-Tray {
    # Ours first, or its watchdog would start aw-qt again.
    Get-CimInstance Win32_Process -Filter "Name like 'AutoHotkey%'" |
        Where-Object { $_.CommandLine -like "*aw-tray.ahk*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    # /T takes the server and watchers with it.
    & taskkill.exe /IM aw-qt.exe /T /F 2>$null | Out-Null
    Start-Sleep -Seconds 1
}

function Set-Link([string]$target, [string]$arguments) {
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($link)
    $shortcut.TargetPath = $target
    $shortcut.Arguments = $arguments
    $shortcut.WorkingDirectory = $awDir
    $shortcut.IconLocation = "$awQt,0"
    $shortcut.Save()
}

if ($Uninstall) {
    Stop-Tray
    Set-Link $awQt ""
    Start-Process $awQt -WorkingDirectory $awDir
    Write-Host "Back to the stock ActivityWatch tray."
    return
}

if (-not $Relay) { throw "Pass -Relay https://<app>.fly.dev (the relay's URL from tt-relay-keys.txt)." }
$ahk = @(
    (Join-Path $env:ProgramFiles "AutoHotkey\v2\AutoHotkey64.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\AutoHotkey\v2\AutoHotkey64.exe")
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $ahk) { throw "AutoHotkey v2 not found. Install it: winget install --id AutoHotkey.AutoHotkey -e" }

New-Item -ItemType Directory -Force $dir | Out-Null
Copy-Item (Join-Path $PSScriptRoot "aw-tray.ahk") $script -Force
# The dashboard asks for the relay password itself, so no key goes in here.
@(
    "[tray]",
    "dashboard=$($Relay.TrimEnd('/'))/app/",
    "awdir=$awDir"
) | Set-Content -Encoding ascii (Join-Path $dir "aw-tray.ini")

Stop-Tray
Set-Link $ahk "`"$script`""
Start-Process $ahk -ArgumentList "`"$script`"" -WorkingDirectory $dir
Write-Host "Started. Right-click the ActivityWatch icon: Open Dashboard goes to $($Relay.TrimEnd('/'))/app/"
