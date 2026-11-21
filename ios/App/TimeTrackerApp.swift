import SwiftUI
import UIKit

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // Runs on every launch, including iOS relaunching the app in the
        // background for a location event: monitoring must be restarted.
        TTSensors.shared.start()
        return true
    }
}

@main
struct TimeTrackerApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @Environment(\.scenePhase) private var phase

    init() {
        // Must run once while unlocked so the lock probe has its canary file.
        ProtectedCanary.ensure()
    }

    var body: some Scene {
        WindowGroup {
            StatusView()
        }
        .onChange(of: phase) { _, now in
            if now == .active {
                TTSensors.shared.catchUpMotion()
                Task { await TTLog.shared.flush() }
            }
        }
    }
}

struct StatusView: View {
    @State private var relay = TTSettings.relayURL
    @State private var device = TTSettings.deviceName
    @State private var pending = 0
    @State private var tick = 0

    var body: some View {
        NavigationStack {
            Form {
                Section("Relay") {
                    TextField("https://<relay>/tt/ingest?key=…", text: $relay, axis: .vertical)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.footnote.monospaced())
                        .onChange(of: relay) { _, v in TTSettings.relayURL = v }
                    TextField("Device name", text: $device)
                        .onChange(of: device) { _, v in TTSettings.deviceName = v }
                    Text("The shortcuts fill both in when they run, so you normally don't type anything here.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("Uploads") {
                    LabeledContent("Waiting to upload", value: "\(pending) lines")
                    LabeledContent("Last upload", value: TTSettings.lastUploadOK.map { $0.formatted(date: .abbreviated, time: .standard) } ?? "never")
                    if !TTSettings.lastError.isEmpty {
                        Text(TTSettings.lastError).font(.footnote).foregroundStyle(.secondary)
                    }
                    Button("Upload now") {
                        Task { await TTLog.shared.flush(); await refresh() }
                    }
                }
                Section("Location and movement") {
                    LabeledContent("Location", value: TTSensors.shared.locationStatus)
                    LabeledContent("Motion & Fitness", value: TTSensors.shared.motionStatus)
                    Button("Allow location and motion") {
                        TTSensors.shared.requestPermissions()
                    }
                    Text("Choose \"Allow While Using App\", then \"Change to Always Allow\" when iOS asks again. Always is what lets TimeTracker record places and movement while it's closed.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("Safari") {
                    Text("Settings → Apps → Safari → Extensions → TT Safari → on, All Websites: Allow. Then in Safari tap the extensions button → TT Safari and paste your relay URL.")
                        .font(.footnote).foregroundStyle(.secondary)
                    Text("Lock canary (test T12): \(ProtectedCanary.readable() ? "ready" : "missing")")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("TimeTracker")
            .id(tick)
            .task { await refresh() }
            .refreshable { await TTLog.shared.flush(); await refresh() }
        }
    }

    private func refresh() async {
        pending = await TTLog.shared.pendingCount()
        tick += 1
    }
}
