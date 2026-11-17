# TimeTracker iOS app

The app carries the **TT Safari** extension (`../safari-extension/`) and the
lock-probe Shortcuts action for test T12. `project.yml` is an XcodeGen spec;
the Xcode project is generated from it and never committed.

It ships to the iPhone through **TestFlight**, built and signed on a
[nomac](https://nomac.app) cloud Mac, so no Mac of our own is needed.

## What it needs (one-time)

- **A paid Apple Developer Program team ($99/yr).** Gabe's phone Apple ID is
  set up as under 18 (for Screen Time), and Apple won't enroll it, so the team
  belongs to a separate adult Apple ID used only for development. The phone
  keeps its own Apple ID.
- **That Apple ID connected to nomac** at nomac.app/dash/apple ("Sign in with
  Apple"). nomac keeps the App Store Connect key on its side; it never reaches
  the Mac, the repo, or a chat.
- **An App Store Connect app record** for `com.gtholiveri.timetracker`
  (My Apps → + → New App). Apple's API can't create one.
- **nomac credit** ($0.90/hr per minute; a release takes about 10–15 minutes).
- **TestFlight on the iPhone.** The phone's Apple ID joins through the
  app's public TestFlight link, so it doesn't need to be on the team. The
  first build needs Apple's beta review (about a day) before the link works.

Bundle IDs: `com.gtholiveri.timetracker` (app) and
`com.gtholiveri.timetracker.safari` (TT Safari). No capabilities beyond the
defaults; the extension needs no App Group. `ITSAppUsesNonExemptEncryption`
is `false` (HTTPS only), so uploads skip the encryption question.

## Shipping a build (what the agent does)

1. Start a Mac (`start_mac` / `nomac start`) and put the repo on its drive:
   `git clone https://github.com/gtholiveri/TimeTrackerOne ~/drive/src/TimeTrackerOne`
   (or `git -C ~/drive/src/TimeTrackerOne pull` on later runs).
2. `cd ~/drive/src/TimeTrackerOne/ios && brew install xcodegen && xcodegen generate`
3. Sign: `set_up_signing` / `nomac sign ios/TimeTracker.xcodeproj`. It
   registers both bundle IDs, creates the App Store profiles, installs them
   with the distribution certificate, and returns an `.xcconfig`, export
   options, and the next build number. It doesn't edit the project.
4. Build: `ios/nomac-build.sh <xcconfig> <ExportOptions.plist> <build number>`.
   If the commands `nomac sign` printed differ from the script, trust nomac's
   and update the script.
5. Upload: `send_to_testflight` / `nomac testflight <ipa>`. Apple processes it
   in 5–15 minutes; then it shows in TestFlight on the phone.
6. Stop the Mac (`stop_mac` / `nomac stop`). The drive keeps the checkout, so
   the next build is incremental.

`MARKETING_VERSION` in `project.yml` is the version testers see; bump it for
a release that matters. The build number comes from nomac each time.

## After installing

Open TimeTracker once while unlocked (creates the T12 canary file), then
Settings → Apps → Safari → Extensions → **TT Safari** → on, **All Websites:
Allow**. In Safari, tap the extensions button → TT Safari, paste the relay URL
TT Sync uses (`https://<relay>/tt/ingest?key=...`) and Save.

TestFlight builds expire after 90 days; shipping a new build renews it.
