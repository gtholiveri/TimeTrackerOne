import SwiftUI

@main
struct TTProbeApp: App {
    init() {
        // Must run once while unlocked so the lock probe has its canary file.
        ProtectedCanary.ensure()
    }

    var body: some Scene {
        WindowGroup {
            VStack(spacing: 16) {
                Text("TT Probe").font(.largeTitle.bold())
                Text("Lock canary: \(ProtectedCanary.readable() ? "ready" : "missing")")
                Text("Shortcuts: add the \"Probe Lock State\" action.\nSafari: Settings → Apps → Safari → Extensions → TT Safari Probe.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
            }
            .padding()
        }
    }
}
