// Lock-state probe for test T12. Add this file to the *app* target of the Xcode
// project (the same "Safari Extension App" project as the Safari probe works).
//
// It exposes a "Probe Lock State" action to Shortcuts that reports whether data
// protection currently considers the device unlocked, two ways:
//   - UIApplication.isProtectedDataAvailable
//   - whether a file written with .completeFileProtection can be read
// Both need a passcode on the device. Both are expected to flip to "locked"
// about 10 s after the screen locks, and back as soon as Face ID/Touch ID/the
// passcode unlocks, even while you are still on the Lock Screen.
//
// Setup: call ProtectedCanary.ensure() once at launch (for example first thing
// in AppDelegate.application(_:didFinishLaunchingWithOptions:)), then open the
// app once while the phone is unlocked so the canary file exists.

import AppIntents
import UIKit

enum ProtectedCanary {
    static var url: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("lock-canary.txt")
    }

    /// Creates the canary file. Only succeeds while the device is unlocked.
    static func ensure() {
        let fm = FileManager.default
        try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !fm.fileExists(atPath: url.path) {
            try? Data("canary".utf8).write(to: url, options: .completeFileProtection)
        }
    }

    /// True while complete-protection files are readable (device unlocked).
    static func readable() -> Bool {
        (try? Data(contentsOf: url)) != nil
    }
}

struct ProbeLockStateIntent: AppIntent {
    static let title: LocalizedStringResource = "Probe Lock State"
    static let description = IntentDescription(
        "Returns \"unlocked\" or \"locked\" from data protection, plus whether the canary file is readable."
    )
    static let openAppWhenRun = false

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<String> {
        let api = UIApplication.shared.isProtectedDataAvailable ? "unlocked" : "locked"
        let file = ProtectedCanary.readable() ? "readable" : "blocked"
        return .result(value: "\(api) file=\(file)")
    }
}
