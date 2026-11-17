#!/usr/bin/env bash
# Builds a signed, App Store-distribution TimeTracker.ipa on a nomac cloud Mac.
# Run it on the Mac from the repo's ios/ folder, after `nomac sign` has
# installed the certificate and profiles (see ios/README.md):
#
#   ios/nomac-build.sh SIGNING.xcconfig ExportOptions.plist BUILD_NUMBER
#
# SIGNING.xcconfig and ExportOptions.plist are the two files `nomac sign`
# returns; BUILD_NUMBER is the "next build number" it reports (TestFlight
# rejects a build number it has already seen). Prints the .ipa path last.
set -euo pipefail

xcconfig=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
export_options=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
build_number=$3

cd "$(dirname "$0")"
command -v xcodegen >/dev/null || brew install xcodegen
xcodegen generate

rm -rf build/TimeTracker.xcarchive build/export
xcodebuild archive \
  -project TimeTracker.xcodeproj -scheme TimeTracker -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath build/TimeTracker.xcarchive \
  -xcconfig "$xcconfig" \
  CURRENT_PROJECT_VERSION="$build_number" \
  | tail -n 30

xcodebuild -exportArchive \
  -archivePath build/TimeTracker.xcarchive \
  -exportOptionsPlist "$export_options" \
  -exportPath build/export \
  | tail -n 20

ipa=$(ls build/export/*.ipa)
# Both bundles must be signed, or the Safari extension silently won't load.
codesign -dv "build/TimeTracker.xcarchive/Products/Applications/TimeTracker.app" 2>&1 | grep -E 'Identifier|TeamIdentifier'
codesign -dv "build/TimeTracker.xcarchive/Products/Applications/TimeTracker.app/PlugIns/TTSafari.appex" 2>&1 | grep -E 'Identifier|TeamIdentifier'
echo "$PWD/$ipa"
