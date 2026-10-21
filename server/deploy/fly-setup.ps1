<#
Sets up the relay on Fly.io, from Windows. In PowerShell:

    cd <your TimeTrackerOne folder>\server
    powershell -ExecutionPolicy Bypass -File deploy\fly-setup.ps1 -App tt-relay-<something unique>

Needs flyctl, logged in (server/README.md, "Deploy on Fly.io"). It creates the
app and its 1 GB disk, generates the two keys, deploys, and writes the keys
and every URL you need to tt-relay-keys.txt in your home folder. It sets the
app name and region in fly.toml, which later `fly deploy` runs use.
#>
param(
    [Parameter(Mandatory = $true)][string]$App,
    [string]$Region = "lax"
)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)  # the server folder, where fly.toml is

function Invoke-Fly {
    & fly @args
    if ($LASTEXITCODE -ne 0) { throw "This failed: fly $($args -join ' ')" }
}

function New-Key {
    $bytes = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    -join ($bytes | ForEach-Object { $_.ToString("x2") })
}

if (-not (Get-Command fly -ErrorAction SilentlyContinue)) {
    throw "flyctl isn't installed. Run:  iwr https://fly.io/install.ps1 -useb | iex  then open a new PowerShell window."
}
& fly auth whoami
if ($LASTEXITCODE -ne 0) { throw "Not logged in to Fly. Run:  fly auth signup  (or  fly auth login)" }

(Get-Content fly.toml) `
    -replace '^app = .*', "app = `"$App`"" `
    -replace '^primary_region = .*', "primary_region = `"$Region`"" |
    Set-Content fly.toml

Invoke-Fly apps create $App --org personal
Invoke-Fly volumes create tt_data --size 1 --region $Region --app $App --yes
$key = New-Key
$ingest = New-Key
Invoke-Fly secrets set "TT_KEY=$key" "TT_INGEST_KEY=$ingest" --app $App --stage
Invoke-Fly deploy --app $App --ha=false

$url = "https://$App.fly.dev"
$out = Join-Path $HOME "tt-relay-keys.txt"
@"
TimeTracker relay: $url

TT_KEY         $key
  Opens everything: the ActivityWatch web UI (any user name, this as password),
  /tt/state, and the desktop mirror.
TT_INGEST_KEY  $ingest
  Uploads only. This one goes on the phone.

TT Sync and TT Safari:  $url/tt/ingest?key=$ingest
Live state:             $url/tt/state?key=$key
ActivityWatch web UI:   $url/
Health check:           $url/tt/health

Desktop mirror (in the server folder):
  powershell -ExecutionPolicy Bypass -File deploy\desktop-mirror.ps1 -Relay $url -Key $key
"@ | Set-Content $out

Get-Content $out
Write-Host ""
Write-Host "Saved to $out. Keep it private: TT_KEY opens all your data."
