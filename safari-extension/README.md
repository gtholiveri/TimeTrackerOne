# TT Safari

The Safari extension for iOS. Every page reports when it's visible or hidden,
its URL and title changes, and a beat every 15 s while visible; the background
script uploads those to the relay (`/tt/safari`), keeping anything that fails
in `storage.local` until the next try. The relay works out which page was on
screen and clips it to the times the phone had Safari in front.

It ships inside the iOS app (`ios/project.yml`; built by
`.github/workflows/ios-app.yml`). After installing the app, turn it on in
Settings → Apps → Safari → Extensions → TT Safari (All Websites: Allow), then
open Safari, tap the extensions button in the address bar → TT Safari, and
paste the same relay URL TT Sync uses.

Files here are copied flat into the extension bundle; this README is excluded.
