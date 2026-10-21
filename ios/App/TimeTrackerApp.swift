import SwiftUI

@main
struct TimeTrackerApp: App {
    init() {
        // Must run once while unlocked so the lock probe has its canary file.
        ProtectedCanary.ensure()
    }

    var body: some Scene {
        WindowGroup {
            VStack(spacing: 16) {
                Text("TimeTracker").font(.largeTitle.bold())
                Text("Safari: Settings → Apps → Safari → Extensions → TT Safari → on, All Websites: Allow. Then in Safari tap the extensions button in the address bar → TT Safari and paste your relay URL.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                Text("Lock canary (test T12): \(ProtectedCanary.readable() ? "ready" : "missing")")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .padding()
        }
    }
}
