#!/usr/bin/env bash
# One command from a fresh NoMac Mac to a TestFlight build:
#
#   NOMAC_SESSION=ses_... ios/nomac-ship.sh ["What to Test notes"]
#
# Needs the NoMac CLI logged in on the Mac: the NoMac secret TESTFLIGHT_UPLOAD_KEY
# (a NoMac API key), or `nomac login`. Signing was set up once with
# `nomac sign`; its certificate, profiles and xcconfig come to every Mac.
# The build number is the UTC date and time (YYYYMMDD.HHMM), so it always goes up.
set -euo pipefail
cd "$(dirname "$0")"
notes=${1:-"Build from $(git rev-parse --short HEAD 2>/dev/null || echo local)"}
team=3SC4668U86
signing=$HOME/.nomac/signing
# The CLI on the Mac can't tell which Mac it is on: pass this Mac's id (ses_...).
session=${NOMAC_SESSION:?set NOMAC_SESSION to the session id of this Mac (start_mac / nomac start prints it)}

command -v nomac >/dev/null || npm install -g @nomac/cli@latest
# A NoMac API key kept as the NoMac secret TESTFLIGHT_UPLOAD_KEY logs the CLI in
# with no approval link.
if [ -n "${TESTFLIGHT_UPLOAD_KEY:-}" ] && ! nomac whoami >/dev/null 2>&1; then
  export NOMAC_API_KEY=$TESTFLIGHT_UPLOAD_KEY
fi
command -v xcodegen >/dev/null || brew install xcodegen
xcodegen generate

if [ ! -f "$signing/$team.xcconfig" ]; then
  nomac sign "$PWD/TimeTracker.xcodeproj" --scheme TimeTracker --session "$session"
fi

build=$(date -u +%Y%m%d.%H%M)
ipa=$(./nomac-build.sh "$signing/$team.xcconfig" "$signing/$team.ExportOptions.plist" "$build" | tail -n 1)
nomac testflight "$ipa" --notes "$notes" --encryption no --session "$session"
